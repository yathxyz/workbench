//! The edwind client (edwind spec §7, §11.3, §12.2): one persistent NDJSON connection
//! to `edit.sock` as `kind: "web"`, reconnecting with backoff like the hub control
//! connection. It carries `call` requests for the notes endpoints and `/api/status`,
//! forwards `sample` streams between `/rpc` tabs and edwind, and turns `notes{gen}`
//! into a feed message for every `/rpc` client.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::time::{interval, sleep, timeout};
use tokio_util::codec::{FramedRead, LinesCodec};
use wb_proto::limits::{HELLO_TIMEOUT, MAX_LINE};

use crate::FeedMsg;
use crate::http::ApiError;

/// The edit protocol version this client speaks (§7.2).
const PROTO: u64 = 1;
/// The message of every 503 while edwind is unreachable (R11.8).
pub const NOT_RUNNING: &str = "workbench-edit is not running";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);
/// A connection must stay up this long before the backoff starts over.
const STABLE: Duration = Duration::from_secs(5);
/// How long edwind has to answer a `call`.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// Silence after which the client pings; silence through a second period ends the
/// connection (§7.2).
const IDLE_PING: Duration = Duration::from_secs(20);
/// How long a `status` answer serves `/api/info` and `/api/status`.
const STATUS_TTL: Duration = Duration::from_secs(5);
/// Calls waiting for the connection task.
const CALLS: usize = 64;
/// Fire-and-forget messages (`sample`, `tool_result`, `cancel`) waiting for it.
const OUTBOUND: usize = 256;

/// What the web knows about edwind.
#[derive(Clone, Debug, PartialEq)]
pub enum EditStatus {
    Down,
    Up(EditInfo),
}

/// What edwind's `welcome` said.
#[derive(Clone, Debug, PartialEq)]
pub struct EditInfo {
    pub build: Option<String>,
}

/// Why a request to edwind failed.
#[derive(Clone, Debug, PartialEq)]
pub enum EditError {
    /// Not connected, or the connection ended before the answer.
    Down,
    /// No answer within `REPLY_TIMEOUT`.
    Timeout,
    /// The encoded line would exceed `MAX_LINE` (R7.2).
    TooLarge,
    /// `result{error}`: a condition the command raised (§7.4).
    Condition { condition: String, report: String },
    /// `error{code, msg}`: a protocol refusal (§7.8).
    Refused { code: String, msg: String },
}

impl EditError {
    /// The `/api` answer: 503 while edwind is down, 504 on silence, and for a refusal
    /// `bad_request` 400, `no_buffer` 404, `refused_path` 403, anything else 502.
    pub fn into_api(self) -> ApiError {
        match self {
            EditError::Down => ApiError::new(StatusCode::SERVICE_UNAVAILABLE, NOT_RUNNING),
            EditError::Timeout => {
                ApiError::new(StatusCode::GATEWAY_TIMEOUT, "workbench-edit did not answer")
            }
            EditError::TooLarge => ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request too large for edwind",
            ),
            EditError::Condition {
                condition: code,
                report: msg,
            }
            | EditError::Refused { code, msg } => {
                let status = match code.as_str() {
                    "bad_request" => StatusCode::BAD_REQUEST,
                    "no_buffer" => StatusCode::NOT_FOUND,
                    "refused_path" => StatusCode::FORBIDDEN,
                    _ => StatusCode::BAD_GATEWAY,
                };
                ApiError::new(status, msg)
            }
        }
    }
}

type Reply = oneshot::Sender<Result<Value, EditError>>;

/// A `call` for the connection task to send.
struct Call {
    cmd: String,
    args: Value,
    reply: Reply,
}

/// What a `/rpc` socket receives from this module.
#[derive(Debug)]
pub enum Delivery {
    /// One message of a `sample` stream, already in the `/rpc` shape (`text`, `tool`,
    /// `done` or `error` with the tab's `id`).
    Stream { sid: String, msg: Value },
    /// Any other message for the browser, such as the `ok` of a `limits`.
    Plain(Value),
}

/// Where a `sample` stream goes: the tab's socket and the id the tab gave it.
pub struct Stream {
    pub id: Value,
    pub to: mpsc::UnboundedSender<Delivery>,
}

type Streams = Arc<Mutex<HashMap<String, Stream>>>;
type StatusCache = Arc<tokio::sync::Mutex<Option<(Instant, Value)>>>;

/// The connection's results, shared with the handlers.
pub struct EditHandle {
    pub status: watch::Receiver<EditStatus>,
    calls: mpsc::Sender<Call>,
    outbound: mpsc::Sender<Value>,
    streams: Streams,
    cid: String,
    counter: AtomicU64,
    status_cache: StatusCache,
}

impl EditHandle {
    pub fn is_up(&self) -> bool {
        matches!(*self.status.borrow(), EditStatus::Up(_))
    }

    /// `call{cmd, args}` and its `result`.
    pub async fn call(&self, cmd: &str, args: Value) -> Result<Value, EditError> {
        if !self.is_up() {
            return Err(EditError::Down);
        }
        let (reply, answer) = oneshot::channel();
        let call = async {
            let call = Call {
                cmd: cmd.to_owned(),
                args,
                reply,
            };
            if self.calls.send(call).await.is_err() {
                return Err(EditError::Down);
            }
            answer.await.unwrap_or(Err(EditError::Down))
        };
        timeout(REPLY_TIMEOUT, call)
            .await
            .unwrap_or(Err(EditError::Timeout))
    }

    /// Sends a message that expects no `result`.
    pub fn send(&self, msg: Value) -> Result<(), EditError> {
        if !self.is_up() {
            return Err(EditError::Down);
        }
        self.outbound.try_send(msg).map_err(|e| {
            tracing::warn!(error = %e, "edwind outbound queue");
            EditError::Down
        })
    }

    /// The `status` command's value, at most `STATUS_TTL` old; `None` while edwind is
    /// down or does not answer.
    pub async fn status_value(&self) -> Option<Value> {
        if !self.is_up() {
            return None;
        }
        let mut cache = self.status_cache.lock().await;
        if let Some((at, value)) = &*cache
            && at.elapsed() < STATUS_TTL
        {
            return Some(value.clone());
        }
        match self.call("status", json!([])).await {
            Ok(value) => {
                *cache = Some((Instant::now(), value.clone()));
                Some(value)
            }
            Err(e) => {
                tracing::debug!(error = ?e, "edwind status call failed");
                *cache = None;
                None
            }
        }
    }

    /// An id unique for this process: the cid's first eight digits and a counter.
    pub fn next_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{}-{n}", &self.cid[..8])
    }

    /// Routes the stream `sid` to a tab.
    pub fn open_stream(&self, sid: String, stream: Stream) {
        self.streams().insert(sid, stream);
    }

    /// Forgets the stream `sid`.
    pub fn close_stream(&self, sid: &str) -> Option<Stream> {
        self.streams().remove(sid)
    }

    fn streams(&self) -> std::sync::MutexGuard<'_, HashMap<String, Stream>> {
        self.streams.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Starts the connection task. `notes{gen}` from edwind is sent on `feed`.
pub fn spawn(path: PathBuf, host: &str, feed: broadcast::Sender<FeedMsg>) -> EditHandle {
    let (status_tx, status) = watch::channel(EditStatus::Down);
    let (calls, calls_rx) = mpsc::channel(CALLS);
    let (outbound, outbound_rx) = mpsc::channel(OUTBOUND);
    let streams: Streams = Arc::default();
    let status_cache: StatusCache = Arc::default();
    let cid = random_cid();
    let control = Control {
        status: status_tx,
        feed,
        streams: streams.clone(),
        status_cache: status_cache.clone(),
        cid: cid.clone(),
        device: format!("web:{host}"),
    };
    tokio::spawn(control.run(path, calls_rx, outbound_rx));
    EditHandle {
        status,
        calls,
        outbound,
        streams,
        cid,
        counter: AtomicU64::new(0),
        status_cache,
    }
}

/// One connection after `hello`.
struct Conn {
    rx: FramedRead<OwnedReadHalf, LinesCodec>,
    tx: OwnedWriteHalf,
}

impl Conn {
    async fn connect(path: &Path, hello: &Value) -> Result<(Self, EditInfo), String> {
        let stream = timeout(CONNECT_TIMEOUT, UnixStream::connect(path))
            .await
            .map_err(|_| "connect timed out".to_owned())?
            .map_err(|e| e.to_string())?;
        let (rx, tx) = stream.into_split();
        let mut conn = Conn {
            rx: FramedRead::new(rx, LinesCodec::new_with_max_length(MAX_LINE)),
            tx,
        };
        conn.send(hello)
            .await
            .map_err(|_| "hello not sent".to_owned())?;
        let welcome = timeout(HELLO_TIMEOUT, conn.recv())
            .await
            .map_err(|_| "no welcome".to_owned())?
            .ok_or_else(|| "closed before welcome".to_owned())?;
        match welcome["t"].as_str() {
            Some("welcome") => {}
            Some("error") => {
                return Err(format!(
                    "hello refused: {} ({})",
                    welcome["msg"].as_str().unwrap_or_default(),
                    welcome["code"].as_str().unwrap_or_default()
                ));
            }
            _ => return Err("the first line was not a welcome".into()),
        }
        if welcome["proto"].as_u64() != Some(PROTO) {
            return Err(format!("edwind speaks proto {}", welcome["proto"]));
        }
        let info = EditInfo {
            build: welcome["build"].as_str().map(str::to_owned),
        };
        Ok((conn, info))
    }

    /// Sends one message as one line; a line over `MAX_LINE` is refused unsent.
    async fn send(&mut self, msg: &Value) -> Result<(), EditError> {
        let mut line = msg.to_string().into_bytes();
        if line.len() > MAX_LINE {
            return Err(EditError::TooLarge);
        }
        line.push(b'\n');
        self.tx.write_all(&line).await.map_err(|e| {
            tracing::warn!(error = %e, "edwind connection failed");
            EditError::Down
        })
    }

    /// The next message, or `None` once the connection has ended. Lines that do not
    /// decode to an object are skipped. Cancel safe.
    async fn recv(&mut self) -> Option<Value> {
        loop {
            match self.rx.next().await? {
                Ok(line) => match serde_json::from_str::<Value>(&line) {
                    Ok(msg) if msg.is_object() => return Some(msg),
                    _ => tracing::warn!("undecodable edwind line skipped"),
                },
                Err(e) => {
                    tracing::warn!(error = %e, "edwind connection failed");
                    return None;
                }
            }
        }
    }
}

struct Control {
    status: watch::Sender<EditStatus>,
    feed: broadcast::Sender<FeedMsg>,
    streams: Streams,
    status_cache: StatusCache,
    cid: String,
    device: String,
}

impl Control {
    async fn run(
        self,
        path: PathBuf,
        mut calls: mpsc::Receiver<Call>,
        mut outbound: mpsc::Receiver<Value>,
    ) {
        let hello = json!({
            "t": "hello",
            "proto": PROTO,
            "cid": self.cid,
            "kind": "web",
            "device": self.device,
            "caps": {},
        });
        let mut backoff = BACKOFF_MIN;
        loop {
            let wait = match Conn::connect(&path, &hello).await {
                Ok((conn, info)) => {
                    let since = Instant::now();
                    self.set(EditStatus::Up(info)).await;
                    self.session(conn, &mut calls, &mut outbound).await;
                    self.set(EditStatus::Down).await;
                    self.fail_streams();
                    if since.elapsed() >= STABLE {
                        backoff = BACKOFF_MIN;
                    }
                    jitter(next_backoff(&mut backoff))
                }
                Err(why) => {
                    tracing::debug!(why, "edwind not reachable");
                    self.set(EditStatus::Down).await;
                    jitter(next_backoff(&mut backoff))
                }
            };
            sleep(wait).await;
        }
    }

    /// Serves calls and outbound messages and routes what edwind sends until the
    /// connection ends. Calls still waiting then fail as down.
    async fn session(
        &self,
        mut conn: Conn,
        calls: &mut mpsc::Receiver<Call>,
        outbound: &mut mpsc::Receiver<Value>,
    ) {
        let mut rid: u64 = 0;
        let mut pending: HashMap<String, Reply> = HashMap::new();
        let mut idle = interval(IDLE_PING);
        idle.tick().await;
        let mut last_rx = Instant::now();
        let mut pinged = false;
        loop {
            tokio::select! {
                msg = conn.recv() => {
                    let Some(msg) = msg else { return };
                    last_rx = Instant::now();
                    pinged = false;
                    if let Some(reply) = self.on_msg(msg, &mut pending)
                        && conn.send(&reply).await.is_err()
                    {
                        return;
                    }
                }
                Some(call) = calls.recv() => {
                    // The caller gave up already.
                    if call.reply.is_closed() {
                        continue;
                    }
                    rid += 1;
                    let rid = rid.to_string();
                    let req = json!({"t": "call", "rid": rid, "cmd": call.cmd, "args": call.args, "ctx": {}});
                    match conn.send(&req).await {
                        Ok(()) => {
                            pending.retain(|_, reply| !reply.is_closed());
                            pending.insert(rid, call.reply);
                        }
                        Err(EditError::TooLarge) => {
                            let _ = call.reply.send(Err(EditError::TooLarge));
                        }
                        Err(_) => return,
                    }
                }
                Some(msg) = outbound.recv() => {
                    match conn.send(&msg).await {
                        Ok(()) => {}
                        Err(EditError::TooLarge) => {
                            if let Some(cancel) = self.refuse_too_large(&msg)
                                && conn.send(&cancel).await.is_err()
                            {
                                return;
                            }
                        }
                        Err(_) => return,
                    }
                }
                _ = idle.tick() => {
                    if last_rx.elapsed() < IDLE_PING {
                        continue;
                    }
                    if pinged {
                        tracing::warn!("edwind did not answer the ping");
                        return;
                    }
                    pinged = true;
                    if conn.send(&json!({"t": "ping", "rid": "web-ping"})).await.is_err() {
                        return;
                    }
                }
            }
        }
    }

    /// Handles one message from edwind; returns a message to send back, if any.
    fn on_msg(&self, mut msg: Value, pending: &mut HashMap<String, Reply>) -> Option<Value> {
        let t = msg["t"].as_str().unwrap_or_default().to_owned();
        match t.as_str() {
            "result" => {
                let rid = msg["rid"].as_str().unwrap_or_default();
                if let Some(reply) = pending.remove(rid) {
                    let answer = match msg.get_mut("error") {
                        Some(error) if !error.is_null() => Err(EditError::Condition {
                            condition: error["condition"].as_str().unwrap_or_default().to_owned(),
                            report: error["report"].as_str().unwrap_or_default().to_owned(),
                        }),
                        _ => Ok(msg["value"].take()),
                    };
                    let _ = reply.send(answer);
                }
            }
            "error" => {
                let code = msg["code"].as_str().unwrap_or_default().to_owned();
                let text = msg["msg"].as_str().unwrap_or_default().to_owned();
                match msg["rid"].as_str().and_then(|rid| pending.remove(rid)) {
                    Some(reply) => {
                        let _ = reply.send(Err(EditError::Refused { code, msg: text }));
                    }
                    None => tracing::warn!(code, "edwind error"),
                }
            }
            "ping" => return Some(json!({"t": "pong", "rid": msg["rid"]})),
            "notes" => {
                if let Some(generation) = msg["gen"].as_u64() {
                    let _ = self.feed.send(FeedMsg::Notes { generation });
                }
            }
            "sample.text" | "sample.tool" | "sample.done" | "sample.error" => {
                self.route_stream(&t["sample.".len()..], msg);
            }
            _ => {}
        }
        None
    }

    /// Delivers one `sample.*` message to the tab that owns its `sid`, in the `/rpc`
    /// shape. `done` and `error` end the stream.
    fn route_stream(&self, t: &str, mut msg: Value) {
        let Some(sid) = msg["sid"].as_str().map(str::to_owned) else {
            return;
        };
        let ends = matches!(t, "done" | "error");
        let stream = {
            let mut streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
            if ends {
                streams.remove(&sid)
            } else {
                streams.get(&sid).map(|s| Stream {
                    id: s.id.clone(),
                    to: s.to.clone(),
                })
            }
        };
        let Some(stream) = stream else {
            tracing::debug!(t, "sample message for an unknown stream");
            return;
        };
        let obj = msg.as_object_mut().expect("edwind messages are objects");
        obj.remove("sid");
        obj.insert("t".into(), t.into());
        obj.insert("id".into(), stream.id);
        let _ = stream.to.send(Delivery::Stream { sid, msg });
    }

    /// Ends the stream of an outbound `sample`, `tool_result` or `tool_error` that does not fit
    /// a line: an `error` to its tab and, when edwind already runs the stream (a tool answer
    /// its thread waits for), a `cancel` to send to edwind.
    fn refuse_too_large(&self, msg: &Value) -> Option<Value> {
        let (what, running) = match msg["t"].as_str() {
            Some("sample") => ("the request", false),
            Some("tool_result" | "tool_error") => ("the tool result", true),
            _ => return None,
        };
        let sid = msg["sid"].as_str()?;
        let stream = self
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(sid)?;
        let error = json!({"t": "error", "id": stream.id, "code": "too_large", "message": format!("{what} is too large")});
        let _ = stream.to.send(Delivery::Stream {
            sid: sid.to_owned(),
            msg: error,
        });
        running.then(|| json!({"t": "cancel", "sid": sid}))
    }

    /// Ends every open stream with an `error` when the connection is lost.
    fn fail_streams(&self) {
        let streams: Vec<_> = self
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .collect();
        for (sid, stream) in streams {
            let error = json!({"t": "error", "id": stream.id, "code": "unavailable", "message": NOT_RUNNING});
            let _ = stream.to.send(Delivery::Stream { sid, msg: error });
        }
    }

    async fn set(&self, new: EditStatus) {
        let changed = self.status.send_if_modified(|cur| {
            let changed = *cur != new;
            if changed {
                *cur = new.clone();
            }
            changed
        });
        if changed {
            *self.status_cache.lock().await = None;
            let status = match new {
                EditStatus::Down => "down",
                EditStatus::Up(_) => "up",
            };
            tracing::info!(status, "edwind status");
        }
    }
}

/// Returns the current backoff and doubles the next one, up to the maximum.
fn next_backoff(backoff: &mut Duration) -> Duration {
    let current = *backoff;
    *backoff = (current * 2).min(BACKOFF_MAX);
    current
}

/// ±25 %, so restarted webs do not reconnect in lockstep.
fn jitter(d: Duration) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.subsec_nanos());
    d.mul_f64(0.75 + f64::from(nanos % 1000) / 2000.0)
}

/// A random 128-bit client id as 32 hex digits, fixed for this process (§7.2).
fn random_cid() -> String {
    let mut bytes = [0u8; 16];
    let read = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes));
    if read.is_err() {
        // Without a random source, mix the time and pid; uniqueness is all that is
        // needed from the cid of one process.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let mut x = (nanos as u64) ^ (u64::from(std::process::id()) << 32) | 1;
        for b in bytes.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = (x & 0xff) as u8;
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cids_are_32_hex_digits_and_differ() {
        let a = random_cid();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(a, random_cid());
    }

    #[test]
    fn errors_map_to_the_api_statuses() {
        let cases = [
            (EditError::Down, StatusCode::SERVICE_UNAVAILABLE),
            (EditError::Timeout, StatusCode::GATEWAY_TIMEOUT),
            (
                EditError::Refused {
                    code: "bad_request".into(),
                    msg: "x".into(),
                },
                StatusCode::BAD_REQUEST,
            ),
            (
                EditError::Refused {
                    code: "no_buffer".into(),
                    msg: "x".into(),
                },
                StatusCode::NOT_FOUND,
            ),
            (
                EditError::Condition {
                    condition: "refused_path".into(),
                    report: "x".into(),
                },
                StatusCode::FORBIDDEN,
            ),
            (
                EditError::Condition {
                    condition: "error".into(),
                    report: "x".into(),
                },
                StatusCode::BAD_GATEWAY,
            ),
        ];
        for (err, want) in cases {
            let res = axum::response::IntoResponse::into_response(err.clone().into_api());
            assert_eq!(res.status(), want, "{err:?}");
        }
    }

    #[test]
    fn backoff_doubles_to_the_cap() {
        let mut b = BACKOFF_MIN;
        let seq: Vec<_> = (0..7).map(|_| next_backoff(&mut b).as_millis()).collect();
        assert_eq!(seq, [250, 500, 1000, 2000, 4000, 5000, 5000]);
    }
}
