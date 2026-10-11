//! The hub client (design §3.2): one connection per card socket, plus the control
//! connection that tracks hub status and the session map, and carries `pty.capture`.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::time::{sleep, timeout};
use tokio_util::codec::{FramedRead, LinesCodec};
use wb_proto::hub::{
    Agent, CaptureReply, ErrorCode, HubMessage, HubRequest, PROTO, SessionsReply, Summary,
};
use wb_proto::limits::{HELLO_TIMEOUT, MAX_LINE};
use wb_proto::line;
use wb_proto::state::derive;

use crate::FeedMsg;

const CLIENT: &str = concat!("wb-web/", env!("CARGO_PKG_VERSION"));
const WEB_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The build id of the hub sources this web was built from, so a deploy that changes
/// only the web never marks the hub stale (design N-4). Absent in plain cargo builds.
const WEB_BUILD: Option<&str> = option_env!("WB_HUB_BUILD");
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);
/// A control connection must stay up this long before the backoff starts over.
const STABLE: Duration = Duration::from_secs(5);
/// How long the hub has to answer a request.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// Captures waiting for the control task.
const CALLS: usize = 64;

/// What the web knows about the hub, from the control connection.
#[derive(Clone, Debug, PartialEq)]
pub enum HubStatus {
    Down,
    Up(HubInfo),
    /// The hub speaks protocol `proto`, not ours.
    Incompatible {
        proto: u32,
    },
}

impl HubStatus {
    pub fn name(&self) -> &'static str {
        match self {
            HubStatus::Down => "down",
            HubStatus::Up(_) => "up",
            HubStatus::Incompatible { .. } => "incompatible",
        }
    }
}

/// The hub's hello, plus whether a hub restart would pick up hub changes.
#[derive(Clone, Debug, PartialEq)]
pub struct HubInfo {
    pub version: String,
    pub build: Option<String>,
    pub proto: u32,
    pub started_at: u64,
    pub agents: Vec<Agent>,
    /// The shells a spawn may name; DELTA-1 §B.
    pub shells: Vec<String>,
    /// Empty from a hub that predates shell choice.
    pub default_shell: String,
    pub stale: bool,
}

/// §3.2.3 rule 5: when both sides have a build, the builds decide; otherwise the
/// versions do.
fn stale(
    hub_version: &str,
    hub_build: Option<&str>,
    web_version: &str,
    web_build: Option<&str>,
) -> bool {
    match (hub_build, web_build) {
        (Some(hub), Some(web)) => hub != web,
        _ => hub_version != web_version,
    }
}

pub enum ConnectError {
    Unavailable(String),
    Incompatible(u32),
}

/// One hub connection after the handshake.
pub struct HubConn {
    rx: FramedRead<OwnedReadHalf, LinesCodec>,
    tx: OwnedWriteHalf,
}

impl HubConn {
    /// Connects and does the handshake (§3.2.3). Returns what the hub's hello says.
    pub async fn connect(path: &Path) -> Result<(Self, HubInfo), ConnectError> {
        let unavailable = |why: String| ConnectError::Unavailable(why);
        let stream = timeout(CONNECT_TIMEOUT, UnixStream::connect(path))
            .await
            .map_err(|_| unavailable("connect timed out".into()))?
            .map_err(|e| unavailable(e.to_string()))?;
        let (rx, tx) = stream.into_split();
        let mut conn = HubConn {
            rx: FramedRead::new(rx, LinesCodec::new_with_max_length(MAX_LINE)),
            tx,
        };
        let hello = timeout(HELLO_TIMEOUT, conn.recv())
            .await
            .map_err(|_| unavailable("no hello".into()))?;
        let Some(HubMessage::Hello {
            proto,
            version,
            build,
            started_at,
            agents,
            shells,
            default_shell,
            ..
        }) = hello
        else {
            return Err(unavailable("the first line was not a hello".into()));
        };
        if proto != PROTO {
            return Err(ConnectError::Incompatible(proto));
        }
        let hello = HubRequest::Hello {
            proto: PROTO,
            client: CLIENT.into(),
        };
        conn.send(&hello)
            .await
            .map_err(|e| unavailable(e.to_string()))?;
        let info = HubInfo {
            stale: stale(&version, build.as_deref(), WEB_VERSION, WEB_BUILD),
            version,
            build,
            proto,
            started_at,
            agents,
            shells,
            default_shell,
        };
        Ok((conn, info))
    }

    pub async fn send(&mut self, req: &HubRequest) -> std::io::Result<()> {
        self.send_line(&line::encode(req)).await
    }

    /// Sends a line already encoded with [`line::encode`].
    pub async fn send_line(&mut self, line: &[u8]) -> std::io::Result<()> {
        self.tx.write_all(line).await
    }

    /// The next message, or `None` once the connection has ended. Lines that do not
    /// decode are skipped. Cancel safe.
    pub async fn recv(&mut self) -> Option<HubMessage> {
        loop {
            match self.rx.next().await? {
                Ok(line) => match serde_json::from_str(&line) {
                    Ok(msg) => return Some(msg),
                    Err(e) => tracing::warn!(error = %e, "undecodable hub line skipped"),
                },
                Err(e) => {
                    tracing::warn!(error = %e, "hub connection failed");
                    return None;
                }
            }
        }
    }
}

/// Why a request over the control connection failed.
#[derive(Debug, PartialEq)]
pub enum CallError {
    /// No control connection, or it ended before the reply.
    Unavailable,
    /// No reply within `REPLY_TIMEOUT`.
    Timeout,
    /// The hub answered `err`.
    Refused(ErrorCode, String),
}

type Reply = oneshot::Sender<Result<String, CallError>>;

/// A `pty.capture` for the control task to send.
struct Capture {
    sid: String,
    lines: u32,
    reply: Reply,
}

/// The control connection's results, shared with the handlers.
pub struct HubHandle {
    pub status: watch::Receiver<HubStatus>,
    /// Every session the hub knows, by sid; empty while the hub is not up.
    pub sessions: Arc<Mutex<BTreeMap<String, Summary>>>,
    calls: mpsc::Sender<Capture>,
}

impl HubHandle {
    /// A copy of the session map.
    pub fn sessions(&self) -> Vec<Summary> {
        let sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.values().cloned().collect()
    }

    /// The plain text of the last `lines` lines of PTY `sid`, over the control
    /// connection.
    pub async fn capture(&self, sid: String, lines: u32) -> Result<String, CallError> {
        let (reply, answer) = oneshot::channel();
        let call = async {
            let capture = Capture { sid, lines, reply };
            if self.calls.send(capture).await.is_err() {
                return Err(CallError::Unavailable);
            }
            answer.await.unwrap_or(Err(CallError::Unavailable))
        };
        timeout(REPLY_TIMEOUT, call)
            .await
            .unwrap_or(Err(CallError::Timeout))
    }
}

/// A Summary as the browser sees it: the hub's facts plus the `state` the web derives
/// (§3.2.6).
pub fn with_state(summary: &Summary) -> Value {
    let mut value = serde_json::to_value(summary).unwrap_or_default();
    value["state"] = serde_json::to_value(derive(summary)).unwrap_or_default();
    value
}

/// Starts the control connection task (§3.2.10). Every status change, session change
/// and forget is also sent on `feed`.
pub fn spawn_control(path: PathBuf, feed: broadcast::Sender<FeedMsg>) -> HubHandle {
    let (status_tx, status) = watch::channel(HubStatus::Down);
    let sessions = Arc::new(Mutex::new(BTreeMap::new()));
    let (calls, calls_rx) = mpsc::channel(CALLS);
    let control = Control {
        status: status_tx,
        sessions: sessions.clone(),
        feed,
    };
    tokio::spawn(control.run(path, calls_rx));
    HubHandle {
        status,
        sessions,
        calls,
    }
}

struct Control {
    status: watch::Sender<HubStatus>,
    sessions: Arc<Mutex<BTreeMap<String, Summary>>>,
    feed: broadcast::Sender<FeedMsg>,
}

impl Control {
    async fn run(self, path: PathBuf, mut calls: mpsc::Receiver<Capture>) {
        let mut backoff = BACKOFF_MIN;
        loop {
            let wait = match HubConn::connect(&path).await {
                Ok((conn, info)) => {
                    let since = Instant::now();
                    self.watch(conn, info, &mut calls).await;
                    self.sessions().clear();
                    self.set(HubStatus::Down);
                    if since.elapsed() >= STABLE {
                        backoff = BACKOFF_MIN;
                    }
                    jitter(next_backoff(&mut backoff))
                }
                Err(ConnectError::Incompatible(proto)) => {
                    self.set(HubStatus::Incompatible { proto });
                    BACKOFF_MAX
                }
                Err(ConnectError::Unavailable(why)) => {
                    tracing::debug!(why, "hub not reachable");
                    self.set(HubStatus::Down);
                    jitter(next_backoff(&mut backoff))
                }
            };
            sleep(wait).await;
        }
    }

    /// Sends `watch`, publishes `up` once the hub answered, then keeps the session map
    /// current and serves captures until the connection ends. Captures still waiting
    /// for their reply then fail as unavailable.
    async fn watch(&self, mut conn: HubConn, info: HubInfo, calls: &mut mpsc::Receiver<Capture>) {
        if conn.send(&HubRequest::Watch { rid: 1 }).await.is_err() {
            return;
        }
        // Nothing else is subscribed on this connection, so the reply comes first.
        let reply = match timeout(REPLY_TIMEOUT, conn.recv()).await {
            Ok(Some(HubMessage::Ok { rid: 1, result })) => {
                serde_json::from_value::<SessionsReply>(Value::Object(result))
            }
            _ => {
                tracing::warn!("the hub did not answer watch");
                return;
            }
        };
        let Ok(SessionsReply { sessions }) = reply else {
            tracing::warn!("undecodable watch reply");
            return;
        };
        *self.sessions() = sessions.into_iter().map(|s| (s.sid.clone(), s)).collect();
        self.set(HubStatus::Up(info));
        let mut rid = 1;
        let mut pending: HashMap<u64, Reply> = HashMap::new();
        loop {
            tokio::select! {
                msg = conn.recv() => match msg {
                    None => return,
                    Some(msg) => self.hub_msg(msg, &mut pending),
                },
                Some(call) = calls.recv() => {
                    // The caller gave up already.
                    if call.reply.is_closed() {
                        continue;
                    }
                    rid += 1;
                    let req = HubRequest::PtyCapture { rid, sid: call.sid, lines: Some(call.lines) };
                    if conn.send(&req).await.is_err() {
                        return;
                    }
                    pending.retain(|_, reply| !reply.is_closed());
                    pending.insert(rid, call.reply);
                }
            }
        }
    }

    fn hub_msg(&self, msg: HubMessage, pending: &mut HashMap<u64, Reply>) {
        match msg {
            HubMessage::Session { session } => {
                self.sessions()
                    .insert(session.sid.clone(), (*session).clone());
                let _ = self.feed.send(FeedMsg::Session(session));
            }
            HubMessage::Gone { sid, epoch } => {
                {
                    let mut sessions = self.sessions();
                    if sessions.get(&sid).is_some_and(|s| s.created_at == epoch) {
                        sessions.remove(&sid);
                    }
                }
                let _ = self.feed.send(FeedMsg::Gone { sid, epoch });
            }
            HubMessage::Ok { rid, result } => {
                if let Some(reply) = pending.remove(&rid) {
                    let text = serde_json::from_value::<CaptureReply>(Value::Object(result))
                        .map(|c| c.text)
                        .map_err(|_| {
                            CallError::Refused(ErrorCode::Internal, "bad capture reply".into())
                        });
                    let _ = reply.send(text);
                }
            }
            HubMessage::Err {
                rid: Some(rid),
                code,
                message,
                ..
            } => {
                if let Some(reply) = pending.remove(&rid) {
                    let _ = reply.send(Err(CallError::Refused(code, message)));
                }
            }
            _ => {}
        }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Summary>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, new: HubStatus) {
        let changed = self.status.send_if_modified(|cur| {
            let changed = *cur != new;
            if changed {
                *cur = new.clone();
            }
            changed
        });
        if changed {
            tracing::info!(status = new.name(), "hub status");
            let _ = self.feed.send(FeedMsg::Hub(new));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_the_cap() {
        let mut b = BACKOFF_MIN;
        let seq: Vec<_> = (0..7).map(|_| next_backoff(&mut b).as_millis()).collect();
        assert_eq!(seq, [250, 500, 1000, 2000, 4000, 5000, 5000]);
    }

    #[test]
    fn builds_decide_staleness_when_both_sides_have_one() {
        // (hub version, hub build, web version, web build, stale)
        let table = [
            ("0.1.0", Some("a"), "0.1.0", Some("b"), true),
            ("0.1.0", Some("a"), "0.2.0", Some("a"), false),
            ("0.1.0", Some("a"), "0.1.0", Some("a"), false),
            ("0.1.0", Some("a"), "0.1.0", None, false),
            ("0.1.0", Some("a"), "0.2.0", None, true),
            ("0.1.0", None, "0.1.0", Some("b"), false),
            ("0.1.0", None, "0.2.0", Some("b"), true),
            ("0.1.0", None, "0.1.0", None, false),
            ("0.1.0", None, "0.2.0", None, true),
        ];
        for (hv, hb, wv, wb, want) in table {
            assert_eq!(stale(hv, hb, wv, wb), want, "{hv} {hb:?} {wv} {wb:?}");
        }
    }

    #[test]
    fn jitter_stays_within_a_quarter() {
        for _ in 0..100 {
            let j = jitter(Duration::from_secs(4));
            assert!(
                j >= Duration::from_secs(3) && j < Duration::from_secs(5),
                "{j:?}"
            );
        }
    }
}
