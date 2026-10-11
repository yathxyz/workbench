//! `wb-fake-acp` driven over stdio without a hub, by a minimal ACP client that checks
//! every message both ways against the ACP schema.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use rustix::process::{Pid, Signal, kill_process_group};
use serde_json::{Value, json};

use super::PATIENCE;
use super::schema::{Checker, Side};

/// The `initialize` params the hub sends (DESIGN §3.4.5).
pub fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientInfo": {"name": "workbench", "version": "0.1.0"},
        "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false},
                               "terminal": false, "elicitation": {"form": {}, "url": {}}},
    })
}

pub struct Agent {
    child: Child,
    stdin: Option<ChildStdin>,
    /// stdout lines, terminators included; disconnected at end of stdout.
    lines: Receiver<Vec<u8>>,
    checker: Checker,
    next_id: u64,
    /// Holds the record and stderr; removed on drop.
    dir: PathBuf,
}

impl Agent {
    /// Starts the fake with `args` and `--record`, in its own process group, with an
    /// environment of `PATH`, `SHELL`, `WB_SESSION` and the secret
    /// `WB_CANARY_SECRET=canary-value`.
    pub fn start(args: &[&str]) -> Agent {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "wb-fake-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_wb-fake-acp"))
            .args(args)
            .arg("--record")
            .arg(dir.join("record"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("SHELL", "/bin/sh")
            .env("WB_SESSION", "fake-test")
            .env("WB_CANARY_SECRET", "canary-value")
            .current_dir(&dir)
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(fs::File::create(dir.join("stderr")).unwrap())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match r.read_until(b'\n', &mut line) {
                    Ok(n) if n > 0 && tx.send(line).is_ok() => {}
                    _ => return,
                }
            }
        });
        Agent {
            stdin: child.stdin.take(),
            child,
            lines,
            checker: Checker::default(),
            next_id: 0,
            dir,
        }
    }

    /// Starts the fake with `--scenario name`.
    pub fn scenario(name: &str) -> Agent {
        Agent::start(&["--scenario", name])
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The next stdout line, terminator included; `None` at end of stdout.
    pub fn next_raw(&mut self) -> Option<Vec<u8>> {
        self.next_raw_within(PATIENCE)
    }

    pub fn next_raw_within(&mut self, within: Duration) -> Option<Vec<u8>> {
        match self.lines.recv_timeout(within) {
            Ok(line) => Some(line),
            Err(RecvTimeoutError::Disconnected) => None,
            Err(RecvTimeoutError::Timeout) => panic!("no output from the fake within {within:?}"),
        }
    }

    /// Whether the fake writes nothing for `d`.
    pub fn quiet_for(&mut self, d: Duration) -> bool {
        match self.lines.recv_timeout(d) {
            Ok(line) => panic!("unexpected output {}", String::from_utf8_lossy(&line)),
            Err(RecvTimeoutError::Timeout) => true,
            Err(RecvTimeoutError::Disconnected) => false,
        }
    }

    /// The next message, checked against the schema.
    pub fn next(&mut self) -> Value {
        let line = self.next_raw().expect("the fake closed stdout");
        self.parse(&line)
    }

    /// A line from the fake as a message, checked against the schema.
    pub fn parse(&mut self, line: &[u8]) -> Value {
        let msg: Value = serde_json::from_slice(line)
            .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(line)));
        self.checker.check(Side::Agent, &msg);
        msg
    }

    /// Sends `msg` after checking it against the schema.
    pub fn send(&mut self, msg: Value) {
        self.checker.check(Side::Client, &msg);
        let mut line = msg.to_string();
        line.push('\n');
        let stdin = self.stdin.as_mut().expect("stdin is open");
        stdin.write_all(line.as_bytes()).unwrap();
        stdin.flush().unwrap();
    }

    /// Sends a request and returns its id.
    pub fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = json!(self.next_id);
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        id
    }

    pub fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    pub fn respond(&mut self, id: &Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    pub fn respond_error(&mut self, id: &Value, code: i64, message: &str) {
        self.send(json!({"jsonrpc": "2.0", "id": id,
                         "error": {"code": code, "message": message}}));
    }

    /// Messages until the response to `id`: those before it, and the response.
    pub fn until_response(&mut self, id: &Value) -> (Vec<Value>, Value) {
        let mut before = Vec::new();
        loop {
            let msg = self.next();
            if msg.get("method").is_none() && msg["id"] == *id {
                return (before, msg);
            }
            before.push(msg);
        }
    }

    /// Messages until the first request from the agent: those before it, and it.
    pub fn until_request(&mut self) -> (Vec<Value>, Value) {
        let mut before = Vec::new();
        loop {
            let msg = self.next();
            if msg.get("method").is_some() && msg.get("id").is_some() {
                return (before, msg);
            }
            before.push(msg);
        }
    }

    /// Sends a request and waits for its response; panics on an error response.
    pub fn call(&mut self, method: &str, params: Value) -> (Vec<Value>, Value) {
        let id = self.request(method, params);
        let (before, response) = self.until_response(&id);
        assert!(response.get("error").is_none(), "{method}: {response}");
        (before, response["result"].clone())
    }

    /// `initialize` as the hub sends it; the result.
    pub fn init(&mut self) -> Value {
        self.call("initialize", initialize_params()).1
    }

    /// `initialize` and `session/new`; the `session/new` result.
    pub fn open(&mut self, cwd: &str) -> Value {
        self.init();
        self.call("session/new", json!({"cwd": cwd, "mcpServers": []}))
            .1
    }

    /// Sends a one-text-block prompt; the request id.
    pub fn prompt(&mut self, session: &str, text: &str) -> Value {
        self.request(
            "session/prompt",
            json!({"sessionId": session, "prompt": [{"type": "text", "text": text}]}),
        )
    }

    /// Closes the fake's stdin.
    pub fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// The exit status, if the fake exits within `within`.
    pub fn exit_within(&mut self, within: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + within;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return Some(status);
            }
            if Instant::now() > deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The `--record` file, one value per line.
    pub fn record(&self) -> Vec<Value> {
        fs::read_to_string(self.dir.join("record"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    pub fn stderr(&self) -> String {
        fs::read_to_string(self.dir.join("stderr")).unwrap_or_default()
    }

    /// SIGTERM to the fake's process group.
    pub fn terminate(&self) {
        let pgid = Pid::from_raw(self.pid().try_into().unwrap()).unwrap();
        let _ = kill_process_group(pgid, Signal::TERM);
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let pgid = Pid::from_raw(self.pid().try_into().unwrap()).unwrap();
        let _ = kill_process_group(pgid, Signal::KILL);
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The `update`s of the `session/update` notifications among `msgs`.
pub fn updates(msgs: &[Value]) -> Vec<Value> {
    msgs.iter()
        .filter(|m| m["method"] == "session/update")
        .map(|m| m["params"]["update"].clone())
        .collect()
}

/// The concatenated text of the chunks of kind `kind` among `updates`.
pub fn text_of(updates: &[Value], kind: &str) -> String {
    updates
        .iter()
        .filter(|u| u["sessionUpdate"] == kind)
        .filter_map(|u| u["content"]["text"].as_str())
        .collect()
}
