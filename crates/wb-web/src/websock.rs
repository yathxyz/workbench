//! `web.sock` (design §3.3): the `wb` CLI runs a board tool in the leader page.
//!
//! Only the service user and root get past the peer check; others are closed before
//! one byte is written. The server sends `hello`, the client answers `hello`, then each
//! `cmd` line is answered in order with `ok` or `err` before the next line is read.
//! [`crate::rpc::Pages`] chooses the page and carries the answer back.

use std::fs::Permissions;
use std::io::ErrorKind;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rustix::process::geteuid;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::timeout;
use tracing::{debug, warn};
use wb_proto::limits::{CMD_TIMEOUT_DEFAULT, CMD_TIMEOUT_MAX, HELLO_TIMEOUT, MAX_LINE};
use wb_proto::line::encode;
use wb_proto::websock::{PROTO, WbErrorCode, WbMessage, WbRequest};

use crate::AppState;
use crate::rpc::{Answer, PageGone};

/// The `err{no_page}` message; `wb` prints the same text.
const NO_PAGE: &str = "no Workbench page is open";
/// The shortest timeout a `cmd` gets.
const CMD_TIMEOUT_MIN: Duration = Duration::from_secs(1);
/// Pause after a failed accept, such as when the process is out of descriptors.
const ACCEPT_PAUSE: Duration = Duration::from_millis(100);

type Lines = BufReader<OwnedReadHalf>;

/// Binds `path` with mode 0600. A socket already there is stale and is removed first;
/// any other file there is an error. The parent directory is the unit's
/// `RuntimeDirectory` (0700), as for `hub.sock`.
pub fn bind(path: &Path) -> Result<UnixListener> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => remove_stale(path)?,
        Ok(_) => bail!("{} exists and is not a socket", path.display()),
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("cannot inspect {}", path.display())),
    }
    let listener =
        UnixListener::bind(path).with_context(|| format!("cannot bind {}", path.display()))?;
    std::fs::set_permissions(path, Permissions::from_mode(0o600))
        .with_context(|| format!("cannot set the mode of {}", path.display()))?;
    Ok(listener)
}

/// Removes the socket at `path` only when nothing accepts on it. A live socket (a
/// second wb-web, or a typo that names hub.sock) is left alone and stops startup.
fn remove_stale(path: &Path) -> Result<()> {
    match std::os::unix::net::UnixStream::connect(path) {
        Ok(_) => bail!("{} is in use by another process", path.display()),
        Err(e) if e.kind() == ErrorKind::ConnectionRefused => std::fs::remove_file(path)
            .with_context(|| format!("cannot remove the stale {}", path.display())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("cannot probe {}", path.display())),
    }
}

/// Accepts connections until shutdown begins. `main` removes the socket file at exit.
pub async fn serve(app: AppState, listener: UnixListener) {
    tracing::info!(socket = %app.cfg.socket.display(), "serving wb");
    let stop = app.stopped();
    tokio::pin!(stop);
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(conn(app.clone(), stream));
                }
                Err(e) => {
                    warn!("web.sock accept: {e}");
                    tokio::time::sleep(ACCEPT_PAUSE).await;
                }
            },
            () = &mut stop => return,
        }
    }
}

/// Serves one connection until the client closes it or breaks the protocol.
async fn conn(app: AppState, stream: UnixStream) {
    match stream.peer_cred() {
        Ok(cred) if cred.uid() == geteuid().as_raw() || cred.uid() == 0 => {}
        Ok(cred) => {
            warn!(uid = cred.uid(), pid = ?cred.pid(), "web.sock refused a connection from another user");
            return;
        }
        Err(e) => {
            warn!("web.sock: cannot read peer credentials: {e}");
            return;
        }
    }
    let (rd, mut wr) = stream.into_split();
    let mut lines = BufReader::new(rd);
    let hello = WbMessage::Hello {
        proto: PROTO,
        server: "wb-web".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    };
    if send(&mut wr, &hello).await.is_err() {
        return;
    }
    let first = match timeout(HELLO_TIMEOUT, read_line(&mut lines)).await {
        Ok(Ok(Some(first))) => first,
        _ => return,
    };
    if let Err(message) = handshake(&first) {
        let _ = send(&mut wr, &err(None, WbErrorCode::BadRequest, message)).await;
        return;
    }
    loop {
        let line = match read_line(&mut lines).await {
            Ok(Some(line)) => line,
            Ok(None) => return,
            Err(e) => {
                debug!("web.sock closing: {e}");
                return;
            }
        };
        let reply = match parse(line) {
            Ok(cmd) => run(&app, cmd).await,
            Err((rid, message)) => err(rid, WbErrorCode::BadRequest, message),
        };
        if send(&mut wr, &reply).await.is_err() {
            return;
        }
    }
}

/// Checks the client's hello; the error is sent before closing.
fn handshake(first: &str) -> Result<(), String> {
    match serde_json::from_str::<WbRequest>(first) {
        Ok(WbRequest::Hello { proto: PROTO, .. }) => Ok(()),
        Ok(WbRequest::Hello { proto, .. }) => {
            Err(format!("this server speaks proto {PROTO}, not {proto}"))
        }
        _ => Err("expected hello".into()),
    }
}

/// A valid `cmd` line.
struct Cmd {
    rid: u64,
    tool: String,
    input: Map<String, Value>,
    wait: Duration,
}

/// Reads a `cmd` line. The error carries the line's `rid` when it has one.
fn parse(line: String) -> Result<Cmd, (Option<u64>, String)> {
    let v: Value = serde_json::from_str(&line).map_err(|e| (None, format!("not JSON: {e}")))?;
    let Value::Object(mut v) = v else {
        return Err((None, "expected a JSON object".into()));
    };
    let rid = v.get("rid").and_then(Value::as_u64);
    let bad = |message: &str| Err((rid, message.to_owned()));
    if v.get("t").and_then(Value::as_str) != Some("cmd") {
        return bad("expected cmd");
    }
    let Some(rid) = rid else {
        return bad("rid must be a non-negative integer");
    };
    let tool = match v.get("tool").and_then(Value::as_str) {
        Some(tool) if !tool.is_empty() => tool.to_owned(),
        _ => return bad("tool must be a non-empty string"),
    };
    let wait = match v.get("timeout") {
        None | Some(Value::Null) => CMD_TIMEOUT_DEFAULT,
        Some(secs) => match secs.as_f64() {
            Some(secs) => Duration::from_secs_f64(
                secs.clamp(CMD_TIMEOUT_MIN.as_secs_f64(), CMD_TIMEOUT_MAX.as_secs_f64()),
            ),
            None => return bad("timeout must be a number of seconds"),
        },
    };
    let Some(Value::Object(input)) = v.remove("input") else {
        return bad("input must be a JSON object");
    };
    Ok(Cmd {
        rid,
        tool,
        input,
        wait,
    })
}

/// Runs `cmd` in the leader page and returns the reply.
async fn run(app: &AppState, cmd: Cmd) -> WbMessage {
    let rid = Some(cmd.rid);
    let Some(mut call) = app.pages.call(&cmd.tool, cmd.input) else {
        return err(rid, WbErrorCode::NoPage, NO_PAGE.into());
    };
    match timeout(cmd.wait, call.answer()).await {
        Ok(Ok(Answer::Result(result))) => WbMessage::Ok {
            rid: cmd.rid,
            result,
        },
        Ok(Ok(Answer::Error(message))) => err(rid, WbErrorCode::Tool, message),
        Ok(Err(PageGone)) => err(
            rid,
            WbErrorCode::PageGone,
            "the page closed before answering".into(),
        ),
        Err(_) => err(
            rid,
            WbErrorCode::Timeout,
            format!("the page did not answer in {} s", cmd.wait.as_secs()),
        ),
    }
}

fn err(rid: Option<u64>, code: WbErrorCode, message: String) -> WbMessage {
    WbMessage::Err { rid, code, message }
}

/// Writes `msg` as one line. A reply over `MAX_LINE` becomes `err{tool}`.
async fn send(wr: &mut OwnedWriteHalf, msg: &WbMessage) -> std::io::Result<()> {
    let mut line = encode(msg);
    if line.len() > MAX_LINE + 1 {
        let rid = match msg {
            WbMessage::Ok { rid, .. } => Some(*rid),
            WbMessage::Err { rid, .. } => *rid,
            _ => None,
        };
        let message = format!("the page's answer is longer than {MAX_LINE} bytes");
        line = encode(&err(rid, WbErrorCode::Tool, message));
    }
    wr.write_all(&line).await
}

/// One line without its `\n`; `None` at end of input. A line over `MAX_LINE` bytes,
/// end of input inside a line and invalid UTF-8 are errors, which close the connection.
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
            .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e)),
        Some(_) if line.len() >= MAX_LINE => Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "line longer than MAX_LINE",
        )),
        Some(_) => Err(ErrorKind::UnexpectedEof.into()),
    }
}
