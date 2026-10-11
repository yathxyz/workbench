//! One `hub.sock` connection: the peer check, the handshake, the request reader and the
//! writer task that drains the connection's [`OutQ`].

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use rustix::process::geteuid;
use serde::Serialize;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tracing::{debug, warn};
use wb_proto::hub::{Agent, ErrorCode, HubMessage, HubRequest, PROTO, SessionsReply, SpawnPty};
use wb_proto::limits::{HELLO_TIMEOUT, MAX_LINE, PTY_INPUT_FRAME, REQS_IN_FLIGHT};
use wb_proto::line::encode;

use crate::Ctx;
use crate::env::check_client_env;
use crate::outq::OutQ;
use crate::pty::{self, Cmd, Open};

/// Most items in `SpawnPty.argv`.
const ARGV_MAX: usize = 256;
/// Most bytes in all of `SpawnPty.argv`.
const ARGV_BYTES_MAX: usize = 256 << 10;
/// How long a connection whose client stopped sending may take to deliver the replies
/// it still owes; a `pty.kill{forget:true}` waits for the exit, up to about 3 s.
const LINGER: Duration = Duration::from_secs(10);

pub type ConnId = u64;

type Lines = BufReader<OwnedReadHalf>;

/// A connection that receives events.
#[derive(Clone)]
pub struct Viewer {
    pub id: ConnId,
    pub outq: Arc<OutQ>,
}

/// Where the one reply to a request goes. It holds one of the connection's in-flight
/// permits until it is sent or dropped.
pub struct Reply {
    rid: u64,
    outq: Arc<OutQ>,
    _permit: Option<OwnedSemaphorePermit>,
}

impl Reply {
    pub fn ok(self, result: &impl Serialize) {
        self.outq
            .push_reply(line(&HubMessage::ok(self.rid, result)));
    }

    /// The empty `ok` reply, `{}`.
    pub fn done(self) {
        let msg = HubMessage::Ok {
            rid: self.rid,
            result: Map::new(),
        };
        self.outq.push_reply(line(&msg));
    }

    pub fn err(self, code: ErrorCode, message: impl Into<String>) {
        self.outq
            .push_reply(line(&error(Some(self.rid), None, code, message.into())));
    }
}

/// One encoded message line, ready to share between connections.
pub fn line(msg: &HubMessage) -> Arc<[u8]> {
    encode(msg).into()
}

fn error(rid: Option<u64>, sid: Option<String>, code: ErrorCode, message: String) -> HubMessage {
    HubMessage::Err {
        rid,
        sid,
        code,
        message,
    }
}

/// `^[A-Za-z0-9_-]{1,64}$`. Sids become file names, so this also guards paths.
pub fn valid_sid(sid: &str) -> bool {
    (1..=64).contains(&sid.len())
        && sid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Serves one accepted connection until either side closes it.
pub async fn serve(ctx: Arc<Ctx>, stream: UnixStream, id: ConnId) {
    match stream.peer_cred() {
        Ok(cred) if cred.uid() == geteuid().as_raw() || cred.uid() == 0 => {}
        Ok(cred) => {
            warn!(uid = cred.uid(), pid = ?cred.pid(), "refused a connection from another user");
            return;
        }
        Err(e) => {
            warn!("reading peer credentials: {e}");
            return;
        }
    }
    let (rd, mut wr) = stream.into_split();
    if wr.write_all(&encode(&hello(&ctx))).await.is_err() {
        return;
    }
    let mut lines = BufReader::new(rd);
    let first = match tokio::time::timeout(HELLO_TIMEOUT, read_line(&mut lines)).await {
        Ok(Ok(Some(first))) => first,
        _ => return,
    };
    if let Err((code, message)) = handshake(&first) {
        let _ = wr
            .write_all(&encode(&error(None, None, code, message)))
            .await;
        return;
    }

    let outq = Arc::new(OutQ::default());
    tokio::spawn(write_loop(wr, outq.clone()));
    let mut conn = Conn {
        ctx,
        id,
        outq,
        permits: Arc::new(Semaphore::new(REQS_IN_FLIGHT)),
        opened: HashSet::new(),
    };
    while let Some(line) = conn.next_line(&mut lines).await {
        conn.dispatch(&line).await;
    }
    conn.close().await;
}

fn hello(ctx: &Ctx) -> HubMessage {
    HubMessage::Hello {
        proto: PROTO,
        server: "wb-hub".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        build: option_env!("WB_HUB_BUILD").map(Into::into),
        host: ctx.cfg.host.clone(),
        pid: std::process::id(),
        started_at: ctx.started_at,
        agents: ctx
            .cfg
            .agents
            .iter()
            .map(|(name, a)| Agent {
                name: name.clone(),
                label: a.label.clone(),
            })
            .collect(),
        shells: Vec::new(),
        default_shell: String::new(),
    }
}

/// Checks the client's hello; the error is sent before closing.
fn handshake(first: &str) -> Result<(), (ErrorCode, String)> {
    match serde_json::from_str::<HubRequest>(first) {
        Ok(HubRequest::Hello { proto: PROTO, .. }) => Ok(()),
        Ok(HubRequest::Hello { proto, .. }) => Err((
            ErrorCode::Proto,
            format!("this hub speaks proto {PROTO}, not {proto}"),
        )),
        _ => Err((ErrorCode::BadRequest, "expected hello".into())),
    }
}

/// One request line without its `\n`; `None` at end of input. A line over `MAX_LINE`
/// bytes, end of input inside a line and invalid UTF-8 are errors.
async fn read_line(r: &mut Lines) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    (&mut *r)
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', &mut line)
        .await?;
    match line.pop() {
        None => Ok(None),
        Some(b'\n') => String::from_utf8(line)
            .map(Some)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Some(_) if line.len() >= MAX_LINE => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "line longer than MAX_LINE",
        )),
        Some(_) => Err(std::io::ErrorKind::UnexpectedEof.into()),
    }
}

async fn write_loop(mut wr: OwnedWriteHalf, q: Arc<OutQ>) {
    while let Some(line) = q.pop().await {
        tokio::select! {
            r = wr.write_all(&line) => if r.is_err() { break },
            () = q.closed() => break,
        }
    }
    q.close();
}

struct Conn {
    ctx: Arc<Ctx>,
    id: ConnId,
    outq: Arc<OutQ>,
    permits: Arc<Semaphore>,
    /// Every sid this connection opened, to detach from when it closes.
    opened: HashSet<String>,
}

impl Conn {
    /// The next request line. `None` ends the connection: end of input, a line over
    /// `MAX_LINE` or not UTF-8, or a closed `OutQ`. No line is read while the `OutQ`
    /// is at its cap.
    async fn next_line(&self, lines: &mut Lines) -> Option<String> {
        self.outq.room().await.ok()?;
        tokio::select! {
            next = read_line(lines) => next.unwrap_or_else(|e| {
                debug!(conn = self.id, "closing: {e}");
                None
            }),
            () = self.outq.closed() => None,
        }
    }

    async fn dispatch(&mut self, text: &str) {
        let v: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => {
                return self.error(None, None, ErrorCode::BadRequest, format!("not JSON: {e}"));
            }
        };
        let rid = v.get("rid").and_then(Value::as_u64);
        let t = v
            .get("t")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let req = match serde_json::from_value::<HubRequest>(v) {
            Ok(req) => req,
            Err(e) => {
                return self.error(rid, None, ErrorCode::BadRequest, format!("bad {t:?}: {e}"));
            }
        };
        if rid == Some(0) {
            return self.error(
                rid,
                None,
                ErrorCode::BadRequest,
                "rid must be nonzero".into(),
            );
        }
        match req {
            HubRequest::Hello { .. } => {
                let msg = "hello was already exchanged".into();
                self.error(None, None, ErrorCode::BadRequest, msg);
            }
            HubRequest::List { rid } => {
                let sessions = self.ctx.registry.list();
                self.outq
                    .push_reply(line(&HubMessage::ok(rid, &SessionsReply { sessions })));
            }
            HubRequest::Watch { rid } => self.ctx.registry.watch(self.viewer(), rid),
            HubRequest::PtyOpen {
                rid,
                sid,
                cols,
                rows,
                spawn,
                resume: _,
            } => self.open(rid, sid, cols, rows, spawn).await,
            HubRequest::PtyDetach { rid, sid } => {
                let conn = self.id;
                self.to_session(rid, sid, |reply| Cmd::Detach {
                    conn,
                    reply: Some(reply),
                })
                .await;
            }
            HubRequest::PtyInput { sid, d } => self.input(sid, d).await,
            HubRequest::PtyResize { sid, cols, rows } => {
                if !valid_sid(&sid) {
                    return self.error(None, None, ErrorCode::BadRequest, "invalid sid".into());
                }
                if let Some(tx) = self.ctx.registry.sender(&sid) {
                    let _ = tx.send(Cmd::Resize { cols, rows }).await;
                }
            }
            HubRequest::PtyKill { rid, sid, forget } => {
                self.to_session(rid, sid, |reply| Cmd::Kill { forget, reply })
                    .await;
            }
            HubRequest::PtyCapture { rid, .. } => {
                let msg = "pty.capture needs the VT state, which this hub version lacks".into();
                self.error(Some(rid), None, ErrorCode::Internal, msg);
            }
            HubRequest::Unknown => {
                self.error(
                    rid,
                    None,
                    ErrorCode::UnknownType,
                    format!("unknown request {t:?}"),
                );
            }
        }
    }

    async fn open(&mut self, rid: u64, sid: String, cols: u32, rows: u32, spawn: Option<SpawnPty>) {
        if !valid_sid(&sid) {
            return self.error(Some(rid), None, ErrorCode::BadRequest, "invalid sid".into());
        }
        if let Some(Err(msg)) = spawn.as_ref().map(check_spawn) {
            return self.error(Some(rid), None, ErrorCode::BadRequest, msg);
        }
        let open = Open {
            viewer: self.viewer(),
            cols,
            rows,
            spawn,
            reply: self.reply(rid).await,
        };
        self.opened.insert(sid.clone());
        pty::open(self.ctx.clone(), sid, open).await;
    }

    async fn to_session(&self, rid: u64, sid: String, cmd: impl FnOnce(Reply) -> Cmd) {
        if !valid_sid(&sid) {
            return self.error(Some(rid), None, ErrorCode::BadRequest, "invalid sid".into());
        }
        let reply = self.reply(rid).await;
        match self.ctx.registry.sender(&sid) {
            Some(tx) => {
                if let Err(unsent) = tx.send(cmd(reply)).await {
                    unsent
                        .0
                        .refuse(ErrorCode::NotFound, &format!("no session {sid}"));
                }
            }
            None => reply.err(ErrorCode::NotFound, format!("no session {sid}")),
        }
    }

    async fn input(&self, sid: String, d: String) {
        if !valid_sid(&sid) {
            return self.error(None, None, ErrorCode::BadRequest, "invalid sid".into());
        }
        if d.len() > PTY_INPUT_FRAME {
            let msg = format!("pty.input is limited to {PTY_INPUT_FRAME} bytes");
            return self.error(None, Some(sid), ErrorCode::BadRequest, msg);
        }
        if let Some(tx) = self.ctx.registry.sender(&sid) {
            let from = self.outq.clone();
            let _ = tx.send(Cmd::Input { d, from }).await;
        }
    }

    fn viewer(&self) -> Viewer {
        Viewer {
            id: self.id,
            outq: self.outq.clone(),
        }
    }

    /// A reply route for `rid`; waits while `REQS_IN_FLIGHT` replies are outstanding.
    async fn reply(&self, rid: u64) -> Reply {
        Reply {
            rid,
            outq: self.outq.clone(),
            _permit: self.permits.clone().acquire_owned().await.ok(),
        }
    }

    /// An `err` reply when `rid` is known, else an asynchronous `err` event.
    fn error(&self, rid: Option<u64>, sid: Option<String>, code: ErrorCode, message: String) {
        let msg = line(&error(rid, sid, code, message));
        if rid.is_some() {
            self.outq.push_reply(msg);
        } else {
            let _ = self.outq.push_event(msg);
        }
    }

    /// Ends the connection after its input ended. The client may have shut down only its
    /// sending side, so the replies it is still owed go out first, within [`LINGER`].
    async fn close(self) {
        self.ctx.registry.unwatch(self.id);
        for sid in &self.opened {
            if let Some(tx) = self.ctx.registry.sender(sid) {
                let detach = Cmd::Detach {
                    conn: self.id,
                    reply: None,
                };
                let _ = tx.send(detach).await;
            }
        }
        let owed = async {
            // A reply holds its permit until it is queued.
            let _ = self.permits.acquire_many(REQS_IN_FLIGHT as u32).await;
            self.outq.finish();
            self.outq.closed().await;
        };
        let _ = tokio::time::timeout(LINGER, async {
            tokio::select! {
                () = owed => {}
                () = self.outq.closed() => {}
            }
        })
        .await;
        self.outq.close();
    }
}

/// The limits of `SpawnPty` (DESIGN §3.2.7); an error is a `bad_request` message.
fn check_spawn(s: &SpawnPty) -> Result<(), String> {
    if !(1..=ARGV_MAX).contains(&s.argv.len()) {
        return Err(format!("argv must have 1 to {ARGV_MAX} items"));
    }
    if s.argv.iter().map(String::len).sum::<usize>() > ARGV_BYTES_MAX {
        return Err(format!("argv exceeds {ARGV_BYTES_MAX} bytes"));
    }
    if s.argv[0].is_empty() || s.argv.iter().any(|a| a.contains('\0')) {
        return Err("argv[0] is empty or an argument contains NUL".into());
    }
    if let Some(cwd) = &s.cwd
        && (!cwd.starts_with('/') || cwd.contains('\0'))
    {
        return Err("cwd must be an absolute path".into());
    }
    if let Some(from) = &s.cwd_from
        && !valid_sid(from)
    {
        return Err("cwdFrom is not a valid sid".into());
    }
    if let Some(env) = &s.env {
        check_client_env(env)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn(argv: &[&str]) -> SpawnPty {
        SpawnPty {
            argv: argv.iter().map(|a| (*a).into()).collect(),
            shell: None,
            cwd: None,
            cwd_from: None,
            env: None,
        }
    }

    #[test]
    fn sids() {
        for ok in ["a", "n_k3m9x2", "A-b_9", &"x".repeat(64)] {
            assert!(valid_sid(ok), "{ok}");
        }
        for bad in ["", "../x", "a/b", "a.b", "a b", "é", &"x".repeat(65)] {
            assert!(!valid_sid(bad), "{bad}");
        }
    }

    #[test]
    fn spawn_limits() {
        assert!(check_spawn(&spawn(&["/bin/bash"])).is_ok());
        assert!(check_spawn(&spawn(&[])).is_err());
        assert!(check_spawn(&spawn(&[""])).is_err());
        assert!(check_spawn(&spawn(&["bash", "a\0b"])).is_err());
        let many: Vec<&str> = vec!["x"; 257];
        assert!(check_spawn(&spawn(&many)).is_err());
        let big = "x".repeat(ARGV_BYTES_MAX);
        assert!(check_spawn(&spawn(&[&big])).is_ok());
        assert!(check_spawn(&spawn(&[&big, "y"])).is_err());
        let mut s = spawn(&["bash"]);
        s.cwd = Some("relative".into());
        assert!(check_spawn(&s).is_err());
        s.cwd = Some("/tmp".into());
        s.cwd_from = Some("../up".into());
        assert!(check_spawn(&s).is_err());
        s.cwd_from = Some("n_1".into());
        s.env = Some([("BAD-KEY".to_string(), "v".to_string())].into());
        assert!(check_spawn(&s).is_err());
    }

    #[test]
    fn handshake_rules() {
        assert!(handshake(r#"{"t":"hello","proto":1,"client":"t"}"#).is_ok());
        let code = |line| handshake(line).unwrap_err().0;
        assert_eq!(
            code(r#"{"t":"hello","proto":2,"client":"t"}"#),
            ErrorCode::Proto
        );
        assert_eq!(code(r#"{"t":"list","rid":1}"#), ErrorCode::BadRequest);
        assert_eq!(code("not json"), ErrorCode::BadRequest);
    }
}
