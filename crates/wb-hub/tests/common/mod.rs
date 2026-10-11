//! A real `wb-hub` in a temporary directory, and a blocking line client for it.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use rustix::process::{Pid, Signal, kill_process};
use serde_json::{Value, json};

/// How long any single expectation may take.
pub const PATIENCE: Duration = Duration::from_secs(10);

/// Variables the hub inherits that must never reach a child.
pub const CANARIES: [&str; 3] = ["ANTHROPIC_API_KEY", "NOTIFY_SOCKET", "WB_CANARY_SECRET"];

pub struct Hub {
    child: Option<Child>,
    pub dir: PathBuf,
    pub socket: PathBuf,
    /// The `bash` shell's path, which is also the default shell.
    pub shell: String,
    /// The `sh` shell's path.
    pub sh: String,
    /// Extra variables in the hub's environment.
    env: Vec<(String, String)>,
}

impl Hub {
    pub fn start() -> Hub {
        Hub::start_with(|_| {})
    }

    /// A hub whose `hub.json` is changed by `edit` before it starts.
    pub fn start_with(edit: impl FnOnce(&mut Value)) -> Hub {
        Hub::start_with_env(edit, &[])
    }

    /// A hub with `hub.json` changed by `edit` and `env` added to its environment.
    pub fn start_with_env(edit: impl FnOnce(&mut Value), env: &[(&str, &str)]) -> Hub {
        static N: AtomicUsize = AtomicUsize::new(0);
        // A short name under `$TMPDIR`: `sun_path` holds 108 bytes.
        let dir = std::env::temp_dir().join(format!(
            "wb-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("home")).unwrap();
        let socket = dir.join("hub.sock");
        let shell = find_bash();
        let sh = find_sh(&shell);
        // `sh` lists a missing path first: the first existing one is the one that runs.
        let mut config = json!({
            "socket": socket,
            "stateDir": dir.join("state"),
            "host": "example",
            "shells": [
                {"name": "bash", "paths": [shell], "args": ["-i"]},
                {"name": "sh", "paths": ["/nonexistent/sh", sh], "args": ["-i"]},
            ],
            "defaultShell": "bash",
            "child": {"passEnv": ["PATH"], "setEnv": {"WB_SET": "from-config"}},
        });
        edit(&mut config);
        fs::write(dir.join("hub.json"), config.to_string()).unwrap();
        let mut hub = Hub {
            child: None,
            dir,
            socket,
            shell,
            sh,
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        };
        hub.launch();
        hub
    }

    /// The hub command on this directory, logging to `hub.log`.
    fn command(&self) -> Command {
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("hub.log"))
            .unwrap();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wb-hub"));
        cmd.arg("--config")
            .arg(self.dir.join("hub.json"))
            .env_clear()
            .env("HOME", self.dir.join("home"))
            .env("USER", "alice")
            .env("LOGNAME", "alice")
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("RUST_LOG", "debug")
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log);
        for name in CANARIES {
            cmd.env(name, "canary-value");
        }
        cmd
    }

    /// Starts the hub process on this directory and waits for its socket.
    fn launch(&mut self) {
        assert!(self.child.is_none(), "the hub is running");
        self.child = Some(self.command().spawn().unwrap());
        let deadline = Instant::now() + PATIENCE;
        while UnixStream::connect(&self.socket).is_err() {
            assert!(Instant::now() < deadline, "the hub did not start");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Runs a second hub on this directory while this one runs; its exit status.
    pub fn run_second(&self) -> ExitStatus {
        let mut second = self.command().spawn().unwrap();
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(status) = second.try_wait().unwrap() {
                return status;
            }
            if Instant::now() > deadline {
                let _ = second.kill();
                let _ = second.wait();
                panic!("the second hub kept running");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Starts a new hub process on the same state directory after the last one exited.
    pub fn restart(&mut self) {
        self.launch();
    }

    /// Kills the hub with SIGKILL, as a crash would, and reaps it.
    pub fn kill9(&mut self) {
        let mut child = self.child.take().expect("the hub is running");
        child.kill().unwrap();
        child.wait().unwrap();
    }

    /// `stateDir/pty/<name>`.
    pub fn pty_file(&self, name: &str) -> PathBuf {
        self.dir.join("state").join("pty").join(name)
    }

    pub fn connect(&self) -> Client {
        Client::connect(&self.socket)
    }

    pub fn pid(&self) -> u32 {
        self.child.as_ref().unwrap().id()
    }

    /// Sends SIGTERM and waits for the exit.
    pub fn terminate(&mut self) -> ExitStatus {
        self.stop().expect("the hub ignored SIGTERM")
    }

    /// SIGTERM, then SIGKILL if the hub has not exited within [`PATIENCE`]; `None` then.
    fn stop(&mut self) -> Option<ExitStatus> {
        let mut child = self.child.take()?;
        signal(child.id(), Signal::TERM);
        let deadline = Instant::now() + PATIENCE;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = child.kill();
        let _ = child.wait();
        None
    }
}

impl Drop for Hub {
    fn drop(&mut self) {
        let killed = self.child.is_some() && self.stop().is_none();
        let log = fs::read_to_string(self.dir.join("hub.log")).unwrap_or_default();
        let _ = fs::remove_dir_all(&self.dir);
        if std::thread::panicking() {
            eprintln!("--- hub log ---\n{log}");
        } else if killed {
            panic!("the hub ignored SIGTERM\n--- hub log ---\n{log}");
        }
    }
}

pub fn signal(pid: u32, sig: Signal) {
    let pid = Pid::from_raw(pid.try_into().unwrap()).unwrap();
    let _ = kill_process(pid, sig);
}

/// Whether `pid` exists and is not a zombie.
pub fn running(pid: u32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            let state = stat.rsplit_once(')').map(|(_, rest)| rest.trim_start());
            !state.is_some_and(|s| s.starts_with('Z'))
        }
        Err(_) => false,
    }
}

/// Waits up to `within` for `cond`.
pub fn eventually(within: Duration, what: &str, cond: impl Fn() -> bool) {
    let deadline = Instant::now() + within;
    while !cond() {
        assert!(Instant::now() < deadline, "{what} within {within:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Waits until `pid` is gone (or a zombie, which the next check treats as a failure).
pub fn wait_gone(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while running(pid) {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

/// A second shell for the shell-choice tests: the `sh` next to `bash` (bash's own sh
/// mode in nixpkgs), else the first `sh` on `PATH`.
fn find_sh(bash: &str) -> String {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::iter::once(Path::new(bash).with_file_name("sh"))
        .chain(std::env::split_paths(&path).map(|dir| dir.join("sh")))
        .find(|p| p.is_absolute() && p.is_file())
        .expect("sh next to bash or on PATH")
        .to_string_lossy()
        .into_owned()
}

/// `$BASH` when it is exported (the design's choice for test configs), else the first
/// `bash` on `PATH`; build sandboxes have no `/run/current-system`.
fn find_bash() -> String {
    let from_env = std::env::var_os("BASH").map(PathBuf::from);
    let path = std::env::var_os("PATH").unwrap_or_default();
    from_env
        .into_iter()
        .chain(std::env::split_paths(&path).map(|dir| dir.join("bash")))
        .find(|p| p.is_absolute() && p.is_file())
        .expect("bash in $BASH or on PATH")
        .to_string_lossy()
        .into_owned()
}

pub struct Client {
    r: BufReader<UnixStream>,
    w: UnixStream,
    pending: VecDeque<Value>,
    next_rid: u64,
    pub hello: Value,
}

impl Client {
    pub fn connect(socket: &Path) -> Client {
        let mut c = Client::raw(socket);
        c.hello = c.next().expect("hello");
        assert_eq!(c.hello["t"], "hello", "{}", c.hello);
        c.send(&json!({"t": "hello", "proto": 1, "client": "wb-hub-tests"}));
        c
    }

    /// Connected, nothing read or sent.
    pub fn raw(socket: &Path) -> Client {
        let w = UnixStream::connect(socket).unwrap();
        w.set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        Client {
            r: BufReader::new(w.try_clone().unwrap()),
            w,
            pending: VecDeque::new(),
            next_rid: 1,
            hello: Value::Null,
        }
    }

    pub fn send(&mut self, msg: &Value) {
        let mut line = msg.to_string();
        line.push('\n');
        self.w.write_all(line.as_bytes()).unwrap();
    }

    /// Shuts down the sending side only; the hub sees end of input.
    pub fn shutdown_write(&self) {
        self.w.shutdown(std::net::Shutdown::Write).unwrap();
    }

    pub fn write_raw(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.w.write_all(bytes)
    }

    /// Sends `msg` with a fresh rid and returns the `ok` or `err` with that rid. Other
    /// messages read meanwhile stay queued for [`next`](Self::next).
    pub fn request(&mut self, mut msg: Value) -> Value {
        let rid = self.next_rid;
        self.next_rid += 1;
        msg["rid"] = rid.into();
        self.send(&msg);
        let deadline = Instant::now() + PATIENCE;
        let mut seen = VecDeque::new();
        let reply = loop {
            let m = self
                .read_line(deadline)
                .expect("connection closed before the reply");
            if m["rid"] == rid {
                break m;
            }
            seen.push_back(m);
        };
        seen.extend(self.pending.drain(..));
        self.pending = seen;
        reply
    }

    pub fn ok(&mut self, msg: Value) -> Value {
        let reply = self.request(msg);
        assert_eq!(reply["t"], "ok", "{reply}");
        reply
    }

    /// The next message; `None` once the hub closed the connection.
    pub fn next(&mut self) -> Option<Value> {
        if let Some(m) = self.pending.pop_front() {
            return Some(m);
        }
        self.read_line(Instant::now() + PATIENCE)
    }

    /// Skips messages until one matches.
    pub fn until(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
        loop {
            let m = self
                .next()
                .unwrap_or_else(|| panic!("closed while waiting for {what}"));
            if pred(&m) {
                return m;
            }
        }
    }

    /// Collects `pty.out` text of `sid` until it contains `needle`.
    pub fn output_until(&mut self, sid: &str, needle: &str) -> String {
        self.output_until_at(sid, needle).0
    }

    /// Like [`output_until`](Self::output_until), also returning the stream offset after
    /// the last chunk.
    pub fn output_until_at(&mut self, sid: &str, needle: &str) -> (String, u64) {
        let mut text = String::new();
        let mut out = 0;
        // Where an occurrence can start that the last search did not see: searching only
        // from there keeps a long stream linear.
        let mut from = 0;
        while !text[from..].contains(needle) {
            from = text.len().saturating_sub(needle.len());
            while !text.is_char_boundary(from) {
                from -= 1;
            }
            let m = self
                .next()
                .unwrap_or_else(|| panic!("closed before {needle:?} in {text:?}"));
            if m["t"] == "pty.out" && m["sid"] == sid {
                text += m["d"].as_str().unwrap();
                out = m["out"].as_u64().unwrap();
            }
        }
        (text, out)
    }

    pub fn input(&mut self, sid: &str, d: &str) {
        self.send(&json!({"t": "pty.input", "sid": sid, "d": d}));
    }

    /// Opens `sid`, spawning `argv` in the default shell if needed; returns the `ok`
    /// result.
    pub fn spawn(&mut self, sid: &str, argv: &[&str]) -> Value {
        self.ok(json!({"t": "pty.open", "sid": sid, "cols": 80, "rows": 24,
                       "spawn": {"argv": argv}}))
    }

    /// Opens `sid` at 80x24 without spawn fields; returns the reply.
    pub fn attach(&mut self, sid: &str) -> Value {
        self.request(json!({"t": "pty.open", "sid": sid, "cols": 80, "rows": 24}))
    }

    /// Reads until the hub closes the connection; the number of bytes read.
    pub fn read_to_close(&mut self) -> usize {
        let deadline = Instant::now() + PATIENCE;
        let mut n = self.pending.len();
        let mut buf = [0; 64 << 10];
        loop {
            match self.r.read(&mut buf) {
                Ok(0) => return n,
                Ok(k) => n += k,
                Err(e) if e.kind() == ErrorKind::ConnectionReset => return n,
                Err(e) if is_timeout(&e) => assert!(Instant::now() < deadline, "not closed"),
                Err(e) => panic!("{e}"),
            }
        }
    }

    fn read_line(&mut self, deadline: Instant) -> Option<Value> {
        let mut line = Vec::new();
        loop {
            match self.r.read_until(b'\n', &mut line) {
                Ok(0) => return None,
                Ok(_) if line.ends_with(b"\n") => {
                    return Some(serde_json::from_slice(&line).unwrap());
                }
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::ConnectionReset => return None,
                Err(e) if is_timeout(&e) => {
                    assert!(Instant::now() < deadline, "no message within {PATIENCE:?}");
                }
                Err(e) => panic!("{e}"),
            }
        }
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}
