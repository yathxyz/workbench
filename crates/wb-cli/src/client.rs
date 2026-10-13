//! The edit-protocol client (§7): a blocking NDJSON connection to `edit.sock`,
//! `hello` first, then requests carrying `rid`. Unknown messages are ignored (R7.4)
//! and no line longer than `MAX_LINE` is ever sent (R7.2).

use std::io::{BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow, bail};
use rustix::process::geteuid;
use serde_json::{Value, json};
use wb_proto::limits::MAX_LINE;
use wb_proto::line::read_line_capped;

use crate::fail::Fail;
use crate::text::{Batch, Op, len16};

/// The default socket when `WB_EDIT_SOCK` is unset (R13.3).
const DEFAULT_SOCKET: &str = "/run/workbench-edit/edit.sock";
/// Longest raw text of one op piece; even fully escaped it fits a line with room.
const PIECE: usize = MAX_LINE / 8;
/// Bytes kept free in an `edit` line for its fields other than `ops`.
const EDIT_OVERHEAD: usize = 512;

/// The answer to `open`: the text (when a `snap` came), the version the client is live
/// at, the buffer's `meta` and the replayed `edits` batches (after `open{since}`).
#[derive(Debug, Default)]
pub struct Opened {
    pub ver: u64,
    pub text: Option<String>,
    pub meta: Value,
    pub edits: Vec<Batch>,
}

/// One connection to edwind, past `hello`.
pub struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_rid: u64,
    next_seq: u64,
    /// The `welcome` message, kept for diagnostics.
    pub welcome: Value,
}

/// `$WB_EDIT_SOCK`, else the default (R13.3).
pub fn socket_path() -> PathBuf {
    match std::env::var_os("WB_EDIT_SOCK") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => PathBuf::from(DEFAULT_SOCKET),
    }
}

/// `device` and `session` for `hello` (R13.2).
fn identity() -> (String, Option<String>) {
    if let Ok(session) = std::env::var("WB_SESSION")
        && !session.is_empty()
    {
        return (format!("cli:{session}"), Some(session));
    }
    let tty = rustix::termios::ttyname(std::io::stdin(), Vec::new())
        .ok()
        .map(|name| name.to_string_lossy().into_owned());
    let device = tty.unwrap_or_else(|| std::process::id().to_string());
    (format!("cli:{device}"), None)
}

/// A random 128-bit client id as 32 hex digits.
fn random_cid() -> String {
    let mut bytes = [0u8; 16];
    let mut filled = 0;
    while filled < bytes.len() {
        match rustix::rand::getrandom(&mut bytes[filled..], rustix::rand::GetRandomFlags::empty()) {
            Ok(n) if n > 0 => filled += n,
            _ => break,
        }
    }
    if filled < bytes.len() {
        // Without a random source, mix the time and pid; uniqueness is all that is
        // needed from a cid of one short-lived process.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let mut x = (nanos as u64) ^ (u64::from(std::process::id()) << 32);
        for b in bytes.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = (x & 0xff) as u8;
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn connect_fail(msg: String) -> anyhow::Error {
    Fail::new(1, "connect", msg).into()
}

/// Checks the socket's owner (R13.3), connects and completes `hello`/`welcome`.
pub fn connect() -> Result<Client> {
    let path = socket_path();
    let shown = path.display();
    let st = rustix::fs::stat(&path)
        .map_err(|e| connect_fail(format!("edit socket {shown}: {e} (is edwind running?)")))?;
    let me = geteuid().as_raw();
    if st.st_uid != me {
        return Err(connect_fail(format!(
            "edit socket {shown} is owned by uid {}, not by this user ({me}); refusing to use it",
            st.st_uid
        )));
    }
    let stream = UnixStream::connect(&path)
        .map_err(|e| connect_fail(format!("connecting to edit socket {shown}: {e}")))?;
    let writer = stream
        .try_clone()
        .map_err(|e| connect_fail(format!("edit socket {shown}: {e}")))?;
    let mut client = Client {
        reader: BufReader::new(stream),
        writer,
        next_rid: 0,
        next_seq: 0,
        welcome: Value::Null,
    };
    let (device, session) = identity();
    let mut hello = json!({
        "t": "hello",
        "proto": 1,
        "cid": random_cid(),
        "kind": "cli",
        "device": device,
        "caps": {},
    });
    if let Some(session) = session {
        hello["session"] = Value::String(session);
    }
    client.send(&hello)?;
    loop {
        let msg = client.recv()?;
        match msg["t"].as_str() {
            Some("welcome") => {
                client.welcome = msg;
                return Ok(client);
            }
            Some("error") => return Err(error_fail(&msg).into()),
            _ => {}
        }
    }
}

/// The `Fail` of a protocol `error` message.
pub fn error_fail(msg: &Value) -> Fail {
    let code = msg["code"].as_str().unwrap_or("error");
    let text = msg["msg"].as_str().unwrap_or("edwind refused the request");
    Fail::protocol(code, &format!("{text} ({code})"))
}

impl Client {
    /// Writes one message as one line; refuses a line over `MAX_LINE`.
    pub fn send(&mut self, msg: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(msg).context("encoding a message")?;
        if line.len() > MAX_LINE {
            bail!("message of {} bytes exceeds MAX_LINE", line.len());
        }
        line.push(b'\n');
        self.writer
            .write_all(&line)
            .and_then(|()| self.writer.flush())
            .context("writing to edwind")
    }

    /// Reads the next JSON object, answering pings and skipping anything else that is
    /// not an object.
    pub fn recv(&mut self) -> Result<Value> {
        loop {
            let line = read_line_capped(&mut self.reader).context("reading from edwind")?;
            let Some(line) = line else {
                return Err(Fail::new(1, "disconnected", "edwind closed the connection").into());
            };
            let Ok(msg) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            if !msg.is_object() {
                continue;
            }
            if msg["t"].as_str() == Some("ping") {
                self.send(&json!({"t": "pong", "rid": msg["rid"]}))?;
                continue;
            }
            return Ok(msg);
        }
    }

    fn rid(&mut self) -> String {
        self.next_rid += 1;
        format!("r{}", self.next_rid)
    }

    /// Sends a request and waits for its `result`; a protocol `error` is a `Fail`.
    pub fn request(&mut self, mut msg: Value) -> Result<Value> {
        let rid = self.rid();
        msg["rid"] = Value::String(rid.clone());
        self.send(&msg)?;
        loop {
            let m = self.recv()?;
            if m["rid"].as_str() != Some(rid.as_str()) {
                continue;
            }
            match m["t"].as_str() {
                Some("result") => return Ok(m),
                Some("error") => return Err(error_fail(&m).into()),
                _ => {}
            }
        }
    }

    /// `call{cmd, args}` with an empty or given `ctx`.
    pub fn call_cmd(&mut self, cmd: &str, args: Value, ctx: Value) -> Result<Value> {
        self.request(json!({"t": "call", "cmd": cmd, "args": args, "ctx": ctx}))
    }

    /// `call{form}`: evaluates `form` in the server image.
    pub fn call_form(&mut self, form: &str) -> Result<Value> {
        self.request(json!({"t": "call", "form": form, "ctx": {}}))
    }

    /// Attaches to `buf` and collects the whole answer up to `opened`.
    pub fn open(&mut self, buf: &str, since: Option<u64>, create: bool) -> Result<Opened> {
        let rid = self.rid();
        let mut msg = json!({"t": "open", "rid": rid, "buf": buf});
        if let Some(since) = since {
            msg["since"] = since.into();
        }
        if create {
            msg["create"] = Value::Bool(true);
        }
        self.send(&msg)?;
        let mut opened = Opened::default();
        loop {
            let m = self.recv()?;
            let mine = m["rid"].as_str() == Some(rid.as_str());
            let same_buf = m["buf"].as_str() == Some(buf);
            match m["t"].as_str() {
                Some("snap") if mine => {
                    opened.text = Some(m["text"].as_str().unwrap_or_default().to_owned());
                    opened.ver = m["ver"].as_u64().unwrap_or_default();
                    opened.meta = m["meta"].clone();
                }
                Some("chunk") if mine => {
                    if let Some(piece) = m["text"].as_str() {
                        opened.text.get_or_insert_default().push_str(piece);
                    }
                }
                Some("edits") if same_buf => {
                    let ops = m["ops"]
                        .as_array()
                        .map(|ops| ops.iter().map(Op::from_value).collect::<Result<Vec<_>>>())
                        .transpose()?
                        .unwrap_or_default();
                    opened.edits.push(Batch {
                        ver: m["ver"].as_u64().unwrap_or_default(),
                        ops,
                    });
                }
                Some("meta") if same_buf => opened.meta = m,
                Some("opened") if mine => {
                    opened.ver = m["ver"].as_u64().unwrap_or(opened.ver);
                    return Ok(opened);
                }
                Some("error") if mine || (m.get("rid").is_none() && same_buf) => {
                    return Err(error_fail(&m).into());
                }
                _ => {}
            }
        }
    }

    /// Detaches from `buf`.
    pub fn close(&mut self, buf: &str) -> Result<()> {
        self.send(&json!({"t": "close", "buf": buf}))
    }

    /// Sends `ops` against `base`, split into as many `edit` messages as `MAX_LINE`
    /// requires, one in flight at a time; returns the version of the last `ack`.
    pub fn edit(&mut self, buf: &str, base: u64, ops: &[Op]) -> Result<u64> {
        let mut ver = base;
        for batch in split_batches(ops) {
            self.next_seq += 1;
            let seq = self.next_seq;
            self.send(&json!({"t": "edit", "buf": buf, "base": ver, "seq": seq, "ops": batch}))?;
            loop {
                let m = self.recv()?;
                let same_buf = m["buf"].as_str() == Some(buf);
                match m["t"].as_str() {
                    Some("ack") if same_buf && m["seq"].as_u64() == Some(seq) => {
                        ver = m["ver"]
                            .as_u64()
                            .ok_or_else(|| anyhow!("ack without a version"))?;
                        break;
                    }
                    Some("error")
                        if m["seq"].as_u64() == Some(seq)
                            || (m.get("seq").is_none()
                                && m.get("rid").is_none()
                                && (same_buf || m.get("buf").is_none())) =>
                    {
                        return Err(error_fail(&m).into());
                    }
                    _ => {}
                }
            }
        }
        Ok(ver)
    }
}

/// Cuts `s` into pieces of at most `max` bytes on character boundaries.
fn char_chunks(s: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut last_end = 0;
    for (i, c) in s.char_indices() {
        let end = i + c.len_utf8();
        if end - start > max && last_end > start {
            out.push(&s[start..last_end]);
            start = last_end;
        }
        last_end = end;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

/// Splits one op whose texts exceed [`PIECE`] into equivalent smaller ops: the deletion
/// piece by piece at the same position, then the insertion piece by piece.
fn pieces(op: &Op) -> Vec<Op> {
    if op.del.len() <= PIECE && op.ins.len() <= PIECE {
        return vec![op.clone()];
    }
    let mut out = Vec::new();
    for chunk in char_chunks(&op.del, PIECE) {
        out.push(Op::new(op.pos, chunk, ""));
    }
    let mut pos = op.pos;
    for chunk in char_chunks(&op.ins, PIECE) {
        out.push(Op::new(pos, "", chunk));
        pos += len16(chunk);
    }
    out
}

/// Groups `ops` into `ops` arrays that each fit an `edit` line under `MAX_LINE`.
pub fn split_batches(ops: &[Op]) -> Vec<Vec<Value>> {
    let budget = MAX_LINE - EDIT_OVERHEAD;
    let mut batches = Vec::new();
    let mut cur = Vec::new();
    let mut size = 0;
    for op in ops.iter().flat_map(pieces) {
        let value = op.to_value();
        let n = value.to_string().len() + 1;
        if !cur.is_empty() && size + n > budget {
            batches.push(std::mem::take(&mut cur));
            size = 0;
        }
        size += n;
        cur.push(value);
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::apply_to_str;

    #[test]
    fn cid_is_32_hex() {
        let cid = random_cid();
        assert_eq!(cid.len(), 32);
        assert!(cid.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(cid, random_cid());
    }

    #[test]
    fn small_ops_stay_one_batch() {
        let ops = vec![Op::new(0, "a", "b"), Op::new(5, "", "x")];
        let batches = split_batches(&ops);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0], vec![json!([0, "a", "b"]), json!([5, "", "x"])]);
        assert!(split_batches(&[]).is_empty());
    }

    #[test]
    fn char_chunks_respect_boundaries() {
        assert_eq!(char_chunks("ab😀cd", 3), vec!["ab", "😀", "cd"]);
        assert_eq!(char_chunks("", 3), Vec::<&str>::new());
        assert_eq!(char_chunks("abc", 3), vec!["abc"]);
    }

    #[test]
    fn huge_ops_are_split_and_equivalent() {
        let old = "😀".repeat(PIECE / 2 + 7);
        let new = "é".repeat(PIECE + 3);
        let op = Op::new(0, old.clone(), new.clone());
        let parts = pieces(&op);
        assert!(parts.len() >= 3);
        for part in &parts {
            assert!(part.del.len() <= PIECE && part.ins.len() <= PIECE);
        }
        assert_eq!(apply_to_str(&old, &parts).unwrap(), new);
        for batch in split_batches(&[op]) {
            let line = json!({"t": "edit", "buf": "x", "base": 1, "seq": 1, "ops": batch});
            assert!(line.to_string().len() <= MAX_LINE);
        }
    }
}
