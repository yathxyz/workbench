//! The integration harness: a real edwind started from `edwin/server/main.mjs`, the
//! `wb` binary run against its socket, and a scripted protocol client.
// Each test crate uses a different part of this module.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// How long a test waits for the server, a message or a condition.
pub const WAIT: Duration = Duration::from_secs(10);

/// `WB_EDWIND_MAIN`, else `<repo>/edwin/server/main.mjs`.
fn main_mjs() -> PathBuf {
    match std::env::var_os("WB_EDWIND_MAIN") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => Path::new(env!("CARGO_MANIFEST_DIR")).join("../../edwin/server/main.mjs"),
    }
}

/// `WB_NODE`, else `node` on PATH.
fn node() -> String {
    match std::env::var("WB_NODE") {
        Ok(n) if !n.is_empty() => n,
        _ => "node".to_owned(),
    }
}

/// A running edwind under a private temporary directory.
pub struct Edwind {
    child: Child,
    pub dir: tempfile::TempDir,
    /// The canonical temporary root (`dir` itself may be under a symlink).
    pub root: PathBuf,
    pub sock: PathBuf,
    pub notes: PathBuf,
    /// A directory for files outside `notes`, whose buffer ids are absolute paths.
    pub work: PathBuf,
    log: Arc<Mutex<String>>,
}

impl Edwind {
    /// Starts edwind and waits until its socket accepts connections. Panics loudly when
    /// the server source or node is missing: these tests never pass vacuously.
    pub fn start() -> Edwind {
        let main = main_mjs();
        assert!(
            main.is_file(),
            "edwind server not found at {}; set WB_EDWIND_MAIN to edwin/server/main.mjs",
            main.display()
        );
        let node = node();
        let probe = Command::new(&node)
            .arg("--version")
            .stdin(Stdio::null())
            .output();
        assert!(
            probe.is_ok_and(|o| o.status.success()),
            "node not found as {node:?}; set WB_NODE to a node binary"
        );

        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // edwind refuses a socket directory that is not 0700 (R14.3); the umask may have widened it.
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let sock = root.join("edit.sock");
        let notes = root.join("notes");
        let work = root.join("work");
        for d in [&notes, &work, &root.join("state"), &root.join("config")] {
            std::fs::create_dir_all(d).unwrap();
        }
        let config = json!({
            "socket": sock,
            "stateDir": root.join("state"),
            "notesDir": notes,
            "configDir": root.join("config"),
            "writablePaths": [root],
            "refusePaths": [],
            "host": "test",
            "logLevel": "info",
        });
        let config_path = root.join("edit.json");
        std::fs::write(&config_path, config.to_string()).unwrap();

        let mut child = Command::new(&node)
            .arg(&main)
            .arg("--config")
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap_or_else(|e| panic!("starting {node} {}: {e}", main.display()));
        let stderr = child.stderr.take().unwrap();
        let log = Arc::new(Mutex::new(String::new()));
        let sink = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                let mut log = sink.lock().unwrap();
                log.push_str(&line);
                log.push('\n');
            }
        });

        let started = Instant::now();
        loop {
            if UnixStream::connect(&sock).is_ok() {
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                panic!(
                    "edwind exited with {status} before listening:\n{}",
                    log.lock().unwrap()
                );
            }
            if started.elapsed() > WAIT {
                let _ = child.kill();
                panic!(
                    "edwind did not listen on {} within {WAIT:?}:\n{}",
                    sock.display(),
                    log.lock().unwrap()
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Edwind {
            child,
            dir,
            root,
            sock,
            notes,
            work,
            log,
        }
    }

    /// Everything edwind wrote to stderr so far.
    pub fn log(&self) -> String {
        self.log.lock().unwrap().clone()
    }

    /// A file path under `work`; its buffer id is the path itself.
    pub fn work_file(&self, name: &str) -> String {
        self.work.join(name).to_string_lossy().into_owned()
    }

    /// Runs `wb` with `args` against this server, feeding `stdin` when given.
    pub fn wb(&self, args: &[&str], stdin: Option<&str>) -> Run {
        run_wb(&self.sock, args, stdin)
    }

    /// Starts `wb` with `args` and leaves it running.
    pub fn spawn_wb(&self, args: &[&str]) -> Child {
        wb_command(&self.sock, args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    }

    /// A scripted client of this server, past `hello`.
    pub fn client(&self) -> Scripted {
        Scripted::connect(&self.sock)
    }

    /// The `buffer-list` entry whose `id` or `file` is `path`, polled for up to `WAIT`.
    pub fn wait_buffer(&self, client: &mut Scripted, path: &str) -> Value {
        let started = Instant::now();
        loop {
            let res =
                client.request(json!({"t": "call", "cmd": "buffer-list", "args": [], "ctx": {}}));
            let list = res["value"].as_array().cloned().unwrap_or_default();
            if let Some(b) = list
                .iter()
                .find(|b| b["id"].as_str() == Some(path) || b["file"].as_str() == Some(path))
            {
                return b.clone();
            }
            assert!(
                started.elapsed() < WAIT,
                "no buffer for {path} appeared; buffers: {list:?}\nserver log:\n{}",
                self.log()
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Edwind {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The outcome of one `wb` run.
#[derive(Debug)]
pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Run {
    /// The single JSON object on stdout.
    pub fn json(&self) -> Value {
        serde_json::from_str(self.stdout.trim())
            .unwrap_or_else(|e| panic!("stdout is not one JSON object ({e}): {:?}", self.stdout))
    }
}

/// A `wb` command against `sock`, with the hub's variables cleared.
pub fn wb_command(sock: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wb"));
    cmd.args(args)
        .env("WB_EDIT_SOCK", sock)
        .env_remove("WB_SESSION");
    cmd
}

/// Runs `wb` to completion.
pub fn run_wb(sock: &Path, args: &[&str], stdin: Option<&str>) -> Run {
    let mut child = wb_command(sock, args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(text) = stdin {
        let mut pipe = child.stdin.take().unwrap();
        pipe.write_all(text.as_bytes()).unwrap();
        drop(pipe);
    }
    let out = child.wait_with_output().unwrap();
    Run {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// Waits for a child with a deadline, so a hung `wb` fails the test instead of the run.
pub fn wait_child(child: &mut Child) -> i32 {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code().unwrap_or(-1);
        }
        if started.elapsed() > WAIT {
            let _ = child.kill();
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            panic!("wb did not exit within {WAIT:?}; stderr:\n{err}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// A scripted edit-protocol client.
pub struct Scripted {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next_rid: u64,
    next_seq: u64,
}

impl Scripted {
    pub fn connect(sock: &Path) -> Scripted {
        let stream = UnixStream::connect(sock).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let writer = stream.try_clone().unwrap();
        let mut c = Scripted {
            reader: BufReader::new(stream),
            writer,
            next_rid: 0,
            next_seq: 0,
        };
        c.send(&json!({
            "t": "hello", "proto": 1, "cid": "0123456789abcdef0123456789abcdef",
            "kind": "cli", "device": "cli:test", "caps": {}
        }));
        let welcome = c.recv();
        assert_eq!(welcome["t"], "welcome", "no welcome: {welcome}");
        c
    }

    pub fn send(&mut self, msg: &Value) {
        let mut line = msg.to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).unwrap();
    }

    /// The next message; panics after `WAIT` or when the server closes.
    pub fn recv(&mut self) -> Value {
        loop {
            let mut line = String::new();
            let n = self
                .reader
                .read_line(&mut line)
                .expect("reading from edwind (timed out?)");
            assert!(n > 0, "edwind closed the connection");
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v["t"] == "ping" {
                    self.send(&json!({"t": "pong", "rid": v["rid"]}));
                    continue;
                }
                return v;
            }
        }
    }

    /// Sends `msg` with a fresh `rid` and returns its `result` or `error`.
    pub fn request(&mut self, mut msg: Value) -> Value {
        self.next_rid += 1;
        let rid = format!("t{}", self.next_rid);
        msg["rid"] = Value::String(rid.clone());
        self.send(&msg);
        loop {
            let m = self.recv();
            if m["rid"].as_str() == Some(&rid) && (m["t"] == "result" || m["t"] == "error") {
                return m;
            }
        }
    }

    /// Opens `buf` and returns `(text, ver, edits batches)` up to `opened`.
    pub fn open(&mut self, buf: &str, since: Option<u64>) -> (Option<String>, u64, Vec<Value>) {
        self.next_rid += 1;
        let rid = format!("t{}", self.next_rid);
        let mut msg = json!({"t": "open", "rid": rid, "buf": buf});
        if let Some(since) = since {
            msg["since"] = since.into();
        }
        self.send(&msg);
        let mut text: Option<String> = None;
        let mut edits = Vec::new();
        loop {
            let m = self.recv();
            match m["t"].as_str() {
                Some("snap") if m["rid"] == rid => {
                    text = Some(m["text"].as_str().unwrap_or("").to_owned());
                }
                Some("chunk") if m["rid"] == rid => {
                    text.get_or_insert_default()
                        .push_str(m["text"].as_str().unwrap_or(""));
                }
                Some("edits") if m["buf"] == buf => edits.push(m),
                Some("opened") if m["rid"] == rid => {
                    return (text, m["ver"].as_u64().unwrap(), edits);
                }
                Some("error") if m["rid"] == rid => panic!("open {buf} failed: {m}"),
                _ => {}
            }
        }
    }

    /// Sends one `edit` and returns the acked version.
    pub fn edit(&mut self, buf: &str, base: u64, ops: Value) -> u64 {
        self.next_seq += 1;
        let seq = self.next_seq;
        self.send(&json!({"t": "edit", "buf": buf, "base": base, "seq": seq, "ops": ops}));
        loop {
            let m = self.recv();
            match m["t"].as_str() {
                Some("ack") if m["seq"] == seq => return m["ver"].as_u64().unwrap(),
                Some("error") if m["seq"] == seq || m.get("rid").is_none() => {
                    panic!("edit failed: {m}")
                }
                _ => {}
            }
        }
    }

    pub fn close(&mut self, buf: &str) {
        self.send(&json!({"t": "close", "buf": buf}));
    }
}
