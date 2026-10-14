//! The board tool commands (DESIGN §3.3, §3.7.4): one `hello` and one `cmd` on
//! `web.sock`, which wb-web runs in the leader page. They never touch `edit.sock`.

use std::ffi::OsString;
use std::io::{self, BufReader, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde_json::{Map, Value};
use wb_proto::limits::{CMD_TIMEOUT_DEFAULT, CMD_TIMEOUT_MAX, MAX_LINE};
use wb_proto::line::{encode, read_line_capped};
use wb_proto::websock::{PROTO, WbErrorCode, WbMessage, WbRequest};

use crate::args::{DROPPED_TOOLS, JsonInput, ToolCall, USAGE, Usage, is_tool_name};
use crate::fail::Fail;

/// The socket when neither `--socket` nor `$WB_SOCKET` names one (§3.7.4).
const DEFAULT_SOCKET: &str = "/run/workbench-web/web.sock";
/// How long `wb` waits for the server `hello`.
const HELLO_WAIT: Duration = Duration::from_secs(10);
/// Added to the command timeout to give the read deadline of the reply.
const REPLY_SLACK: Duration = Duration::from_secs(10);
/// The `rid` of the one `cmd` of an invocation.
const RID: u64 = 1;

/// `--socket`, then `$WB_SOCKET` when not empty, then the default.
pub fn socket_path(flag: Option<&Path>, env: Option<OsString>) -> PathBuf {
    match (flag, env) {
        (Some(p), _) => p.to_owned(),
        (None, Some(p)) if !p.is_empty() => PathBuf::from(p),
        _ => PathBuf::from(DEFAULT_SOCKET),
    }
}

fn resolve(flag: Option<&Path>) -> PathBuf {
    socket_path(flag, std::env::var_os("WB_SOCKET"))
}

/// The read deadline of the reply: the timeout wb-web applies, plus `REPLY_SLACK`.
pub fn reply_deadline(timeout: Option<u64>) -> Duration {
    let secs = timeout.map_or(CMD_TIMEOUT_DEFAULT.as_secs(), |t| {
        t.clamp(1, CMD_TIMEOUT_MAX.as_secs())
    });
    Duration::from_secs(secs) + REPLY_SLACK
}

/// `wb tools`: the text of `list_tools` without the entries of the W-14 tools.
pub fn tools(socket: Option<&Path>) -> Result<ExitCode> {
    let text = exchange(&resolve(socket), "list_tools", Map::new(), None)?;
    print_result(&strip_dropped(&text))?;
    Ok(ExitCode::SUCCESS)
}

/// `wb TOOL ...`: runs one tool and prints its result text.
pub fn tool(call: &ToolCall) -> Result<ExitCode> {
    let stdin = match call.json {
        Some(JsonInput::Stdin) => Some(read_stdin()?),
        _ => None,
    };
    let input = call.input(stdin.as_deref()).map_err(usage_fail)?;
    let text = exchange(
        &resolve(call.socket.as_deref()),
        &call.tool,
        input,
        call.timeout,
    )?;
    print_result(&text)?;
    Ok(ExitCode::SUCCESS)
}

/// A usage error found after parsing (in INPUT read from stdin): exit 2 with the usage text.
fn usage_fail(usage: Usage) -> anyhow::Error {
    let lines = USAGE.lines().map(str::to_owned).collect();
    Fail::new(2, "usage", usage.0).detail(lines).into()
}

/// Reads INPUT for `--json -`, at most `MAX_LINE` bytes.
fn read_stdin() -> Result<String> {
    let mut text = String::new();
    io::stdin()
        .lock()
        .take(MAX_LINE as u64 + 1)
        .read_to_string(&mut text)
        .context("reading INPUT from stdin")?;
    if text.len() > MAX_LINE {
        return Err(usage_fail(Usage(format!(
            "INPUT from stdin is longer than {MAX_LINE} bytes"
        ))));
    }
    Ok(text)
}

/// Writes the result text with a final newline when it has none.
fn print_result(text: &str) -> Result<()> {
    let mut out = io::stdout().lock();
    out.write_all(text.as_bytes())?;
    if !text.is_empty() && !text.ends_with('\n') {
        out.write_all(b"\n")?;
    }
    out.flush()?;
    Ok(())
}

/// Removes from a `list_tools` text the entries of the W-14 tools. An entry starts with
/// a line `NAME(`; the lines after it up to the next entry belong to it.
pub fn strip_dropped(list: &str) -> String {
    let mut out = String::with_capacity(list.len());
    let mut keep = true;
    for line in list.split_inclusive('\n') {
        if let Some((name, _)) = line.split_once('(')
            && is_tool_name(name)
        {
            keep = !DROPPED_TOOLS.contains(&name);
        }
        if keep {
            out.push_str(line);
        }
    }
    out
}

/// The errno text of `err`, without the `(os error N)` that std adds.
fn errno_text(err: &io::Error) -> String {
    let text = err.to_string();
    match (err.raw_os_error(), text.rfind(" (os error ")) {
        (Some(_), Some(at)) => text[..at].to_owned(),
        _ => text,
    }
}

fn fail(msg: String) -> anyhow::Error {
    Fail::new(1, "connect", msg).into()
}

fn unreachable(path: &Path, err: &io::Error) -> anyhow::Error {
    fail(format!(
        "cannot reach wb-web at {} ({})",
        path.display(),
        errno_text(err)
    ))
}

/// Checks that this user owns the socket, then connects.
fn connect(path: &Path) -> Result<UnixStream> {
    let meta = std::fs::metadata(path).map_err(|e| unreachable(path, &e))?;
    let me = rustix::process::geteuid().as_raw();
    if meta.uid() != me {
        return Err(fail(format!(
            "web socket {} is owned by uid {}, not by this user ({me}); refusing to use it",
            path.display(),
            meta.uid()
        )));
    }
    UnixStream::connect(path).map_err(|e| unreachable(path, &e))
}

/// One connection to wb-web.
struct Conn<'a> {
    path: &'a Path,
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Conn<'_> {
    fn send(&mut self, msg: &WbRequest) -> Result<()> {
        let line = encode(msg);
        if line.len() > MAX_LINE + 1 {
            return Err(Fail::new(
                1,
                "too_large",
                format!(
                    "the request is {} bytes, more than {MAX_LINE}",
                    line.len() - 1
                ),
            )
            .into());
        }
        self.writer
            .write_all(&line)
            .and_then(|()| self.writer.flush())
            .map_err(|e| fail(format!("writing to wb-web: {}", errno_text(&e))))
    }

    /// The next line, or a failure at `deadline` or when the server closes.
    fn recv(&mut self, deadline: Instant, wait: Duration, what: &str) -> Result<Vec<u8>> {
        let late = || {
            fail(format!(
                "wb-web at {} did not send {what} within {} s",
                self.path.display(),
                wait.as_secs()
            ))
        };
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(late());
        }
        self.reader
            .get_ref()
            .set_read_timeout(Some(left))
            .context("setting a read timeout")?;
        match read_line_capped(&mut self.reader) {
            Ok(Some(line)) => Ok(line),
            Ok(None) => Err(fail(format!(
                "wb-web closed the connection before it sent {what}"
            ))),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                Err(late())
            }
            Err(e) => Err(fail(format!("reading from wb-web: {}", errno_text(&e)))),
        }
    }
}

/// Connects, completes the hellos, sends one `cmd` and gives the result text.
fn exchange(
    path: &Path,
    tool: &str,
    input: Map<String, Value>,
    timeout: Option<u64>,
) -> Result<String> {
    let stream = connect(path)?;
    let writer = stream.try_clone().map_err(|e| unreachable(path, &e))?;
    // A server that stops reading must not hang `wb` either.
    writer
        .set_write_timeout(Some(HELLO_WAIT))
        .context("setting a write timeout")?;
    let mut conn = Conn {
        path,
        reader: BufReader::new(stream),
        writer,
    };

    let line = conn.recv(Instant::now() + HELLO_WAIT, HELLO_WAIT, "its hello")?;
    match serde_json::from_slice::<WbMessage>(&line) {
        Ok(WbMessage::Hello { proto: PROTO, .. }) => {}
        Ok(WbMessage::Hello { proto, .. }) => {
            return Err(fail(format!(
                "wb-web at {} speaks protocol {proto}; this wb speaks {PROTO}",
                path.display()
            )));
        }
        _ => {
            return Err(fail(format!(
                "wb-web at {} did not start with hello",
                path.display()
            )));
        }
    }
    conn.send(&WbRequest::Hello {
        proto: PROTO,
        client: format!("wb/{}", env!("CARGO_PKG_VERSION")),
    })?;
    conn.send(&WbRequest::Cmd {
        rid: RID,
        tool: tool.to_owned(),
        input,
        timeout,
    })?;

    let wait = reply_deadline(timeout);
    let deadline = Instant::now() + wait;
    loop {
        let line = conn.recv(deadline, wait, "an answer")?;
        // Lines that are not JSON, other messages and other rids are skipped.
        let Ok(value) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let ours = value["rid"] == RID;
        match serde_json::from_value::<WbMessage>(value) {
            Ok(WbMessage::Ok { rid: RID, result }) => return Ok(result),
            // An `err` without `rid` answers a line too malformed to carry one.
            Ok(WbMessage::Err {
                rid: None | Some(RID),
                code,
                message,
            }) => return Err(reply_fail(code, message).into()),
            Err(_) if ours => {
                return Err(fail("wb-web sent a malformed answer".to_owned()));
            }
            _ => {}
        }
    }
}

/// The failure of an `err` reply: `no_page` exits 7, every other code 1.
pub fn reply_fail(code: WbErrorCode, message: String) -> Fail {
    let or = |fallback: &str| {
        if message.trim().is_empty() {
            fallback.to_owned()
        } else {
            message.clone()
        }
    };
    match code {
        WbErrorCode::NoPage => Fail::new(7, "no_page", "no Workbench page is open"),
        WbErrorCode::Timeout => Fail::new(1, "timeout", "the page did not answer in time"),
        WbErrorCode::PageGone => Fail::new(1, "page_gone", "the page closed before answering"),
        WbErrorCode::Tool => Fail::new(1, "tool", or("the tool failed")),
        WbErrorCode::BadRequest => Fail::new(1, "bad_request", or("wb-web refused the request")),
        WbErrorCode::Unknown => Fail::new(1, "error", or("wb-web refused the request")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_precedence() {
        let flag = Path::new("/a/flag.sock");
        assert_eq!(
            socket_path(Some(flag), Some("/b/env.sock".into())),
            PathBuf::from("/a/flag.sock")
        );
        assert_eq!(
            socket_path(None, Some("/b/env.sock".into())),
            PathBuf::from("/b/env.sock")
        );
        assert_eq!(
            socket_path(None, Some(OsString::new())),
            PathBuf::from(DEFAULT_SOCKET)
        );
        assert_eq!(socket_path(None, None), PathBuf::from(DEFAULT_SOCKET));
    }

    #[test]
    fn reply_deadline_is_the_clamped_timeout_plus_slack() {
        assert_eq!(reply_deadline(None), Duration::from_secs(70));
        assert_eq!(reply_deadline(Some(5)), Duration::from_secs(15));
        assert_eq!(reply_deadline(Some(0)), Duration::from_secs(11));
        assert_eq!(reply_deadline(Some(10_000)), Duration::from_secs(310));
    }

    #[test]
    fn strip_dropped_removes_w14_entries() {
        let list = "read_node(path): Read a node.\n\
                    list_hosts(): List the hosts.\n\
                    host_folder(host): Bind a folder\n  to a host.\n\
                    create_node(kind, name): Create a node.\n\
                    list_tmux(host): tmux sessions.\n\
                    adopt_tmux(target, host): adopt.\n\
                    unit_control(unit, verb): units.\n\
                    host_status(host): health.\n\
                    list_tools(): List the board tools.";
        assert_eq!(
            strip_dropped(list),
            "read_node(path): Read a node.\n\
             create_node(kind, name): Create a node.\n\
             list_tools(): List the board tools."
        );
        assert_eq!(strip_dropped(""), "");
        assert_eq!(strip_dropped("(no tools)\n"), "(no tools)\n");
    }

    #[test]
    fn errno_text_drops_the_os_error_suffix() {
        let err = io::Error::from_raw_os_error(2);
        assert_eq!(errno_text(&err), "No such file or directory");
        let err = io::Error::other("plain");
        assert_eq!(errno_text(&err), "plain");
    }

    #[test]
    fn reply_codes_map_to_exits_and_messages() {
        let f = reply_fail(WbErrorCode::NoPage, "no Workbench page is open".into());
        assert_eq!(
            (f.exit, f.message.as_str()),
            (7, "no Workbench page is open")
        );
        let f = reply_fail(WbErrorCode::Tool, "no node at x".into());
        assert_eq!((f.exit, f.message.as_str()), (1, "no node at x"));
        let f = reply_fail(WbErrorCode::Timeout, "timeout after 5 s".into());
        assert_eq!(
            (f.exit, f.message.as_str()),
            (1, "the page did not answer in time")
        );
        let f = reply_fail(WbErrorCode::PageGone, String::new());
        assert_eq!(
            (f.exit, f.message.as_str()),
            (1, "the page closed before answering")
        );
        let f = reply_fail(WbErrorCode::BadRequest, "input must be an object".into());
        assert_eq!((f.exit, f.message.as_str()), (1, "input must be an object"));
        let f = reply_fail(WbErrorCode::Unknown, String::new());
        assert_eq!(f.exit, 1);
        assert!(!f.message.is_empty());
    }
}
