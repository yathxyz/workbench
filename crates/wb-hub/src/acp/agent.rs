//! One agent process (10-hub §7.1): its spawn and environment, the stdin writer, the
//! stdout reader and the stderr log, and signals to its process group.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustix::process::{Pid, Signal, WaitIdStatus, kill_process, kill_process_group};
use serde_json::{Map, Value};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncWriteExt, BufReader, Interest};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use wb_proto::limits::{MAX_LINE, PROMPT_MAX};

use super::lines::{Read, read_line_capped};
use crate::child::{self, ExitWatch};
use crate::config::{ChildConfig, HostConfig};
use crate::env::Identity;
use crate::escalation::Escalations;
use crate::pty::spawn::spawn_agent;
use crate::{Ctx, lock};

/// Bytes the stdin queue holds before a send fails.
const STDIN_QUEUE: usize = PROMPT_MAX + (1 << 20);
/// The stderr log is rotated at this size; one older generation is kept.
const LOG_MAX: u64 = 1 << 20;
/// How much of a non-JSON stdout line goes to the log.
const STDOUT_NOTE_MAX: usize = 4 << 10;
/// How much of an unterminated stderr line is kept for the exit notice.
const TAIL_MAX: usize = 4 << 10;
const STDERR_CHUNK: usize = 8 << 10;
/// Objects read from stdout that wait for the actor; backpressure on the agent.
const STDOUT_QUEUE: usize = 4;

/// What the stdout reader delivers.
pub enum Out {
    Msg(Map<String, Value>),
    Eof,
}

/// Dropping a live agent transfers its owned group to panic cleanup.
pub struct Agent {
    pub watch: ExitWatch,
    #[cfg(test)]
    pub(super) fail_exit_peek: bool,
    group: Option<Group>,
    escalations: Arc<Escalations>,
    /// `None` once closed: the writer sends what is queued, then closes the pipe.
    pub stdin: Option<Stdin>,
    pub stdout: mpsc::Receiver<Out>,
    pub log: Log,
    stderr: Arc<AsyncFd<ChildStderr>>,
    tasks: [JoinHandle<()>; 3],
}

impl Agent {
    pub fn pid(&self) -> u32 {
        self.group.as_ref().unwrap().child.as_ref().unwrap().id()
    }

    pub fn signal(&self, sig: Signal) {
        if let Some(group) = &self.group {
            group.signal(sig);
        }
    }

    /// Reaping or ECHILD releases the number. Never signal it again, even on unwind.
    pub fn discard_group(&mut self) {
        if let Some(mut group) = self.group.take() {
            group.child.take();
        }
    }

    /// After a failed observation, try once more without reaping. Only use the
    /// reaping fallback if the non-reaping syscall itself still fails.
    pub fn probe_exit(&mut self) -> io::Result<Option<(Option<i32>, Option<i32>)>> {
        match self.peek_exit() {
            Ok(status) => Ok(status.map(|s| (s.exit_status(), s.terminating_signal()))),
            Err(e) if child::is_echild(&e) => Err(e),
            Err(_) => {
                let group = self.group.as_mut().expect("waiting for an owned group");
                let child = group.child.as_mut().expect("owned group leader");
                let Some(status) = child.try_wait()? else {
                    return Ok(None);
                };
                self.discard_group();
                Ok(Some((status.code(), status.signal())))
            }
        }
    }

    fn peek_exit(&self) -> io::Result<Option<WaitIdStatus>> {
        #[cfg(test)]
        if self.fail_exit_peek {
            return Err(rustix::io::Errno::IO.into());
        }
        child::peek_exit(self.pid())
    }

    pub fn end_group(&mut self, grace: Duration) {
        if let Some(group) = self.group.take() {
            group.signal(Signal::TERM);
            self.escalations.arm_group(group, grace);
        }
    }

    /// Include pending pipe bytes in the death notice, not future writes by descendants.
    pub fn finish_stderr(&self) -> String {
        let pipe = self.stderr.get_ref();
        let mut log = lock(&self.log.0);
        // The reader takes this same lock before reading: no chunk can be in flight.
        let mut pending =
            rustix::io::retry_on_intr(|| rustix::io::ioctl_fionread(pipe)).unwrap_or(0) as usize;
        let mut buf = [0; STDERR_CHUNK];
        while pending > 0 {
            let len = pending.min(buf.len());
            match log.read_stderr(pipe, &mut buf[..len]) {
                Ok(n @ 1..) => pending -= n,
                _ => break,
            }
        }
        log.last_line()
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        self.end_group(super::PANIC_GRACE);
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Starts `argv` as the agent of `sid` in `cwd` with the environment of DESIGN §3.7.3,
/// `env` being the agent's own; its stderr goes to `log`. An error is the
/// `setup_error{spawn_failed}` message.
pub fn start(
    ctx: &Ctx,
    sid: &str,
    argv: &[String],
    env: &BTreeMap<String, String>,
    cwd: &str,
    log: PathBuf,
) -> Result<Agent, String> {
    // DELTA-1 §B.3: agents' tool runners expect a POSIX shell, whatever the cards run.
    let bash = ctx
        .cfg
        .shell("bash")
        .and_then(|s| s.resolve())
        .ok_or("shell bash not available for the agent's SHELL")?;
    let env = agent_env(&ctx.cfg.child, env, bash, &ctx.ident, sid, |n| {
        std::env::var_os(n)
    });
    let (program, args) = argv.split_first().ok_or("empty argv")?;
    let setup_error = |e| format!("spawn failed: {e}");
    let child =
        spawn_agent(Path::new(program), args, &env, cwd, ctx.child_umask).map_err(setup_error)?;
    // Arm cleanup before any fallible post-spawn setup.
    let mut group = Group {
        child: Some(child),
        reaper: ctx.reaper.clone(),
    };
    let child = group.child.as_mut().unwrap();
    let watch = ExitWatch::new(child.id()).map_err(setup_error)?;
    let stdin =
        ChildStdin::from_std(child.stdin.take().expect("piped stdin")).map_err(setup_error)?;
    let stdout =
        ChildStdout::from_std(child.stdout.take().expect("piped stdout")).map_err(setup_error)?;
    let stderr = child.stderr.take().expect("piped stderr");
    rustix::io::ioctl_fionbio(&stderr, true)
        .map_err(std::io::Error::from)
        .map_err(setup_error)?;
    let stderr = Arc::new(AsyncFd::with_interest(stderr, Interest::READABLE).map_err(setup_error)?);
    let log = Log::open(log);
    let queued = Arc::new(AtomicUsize::new(0));
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::channel(STDOUT_QUEUE);
    let tasks = [
        tokio::spawn(write_stdin(stdin, in_rx, queued.clone())),
        tokio::spawn(read_stdout(stdout, out_tx, log.clone())),
        tokio::spawn(read_stderr(stderr.clone(), log.clone())),
    ];
    Ok(Agent {
        watch,
        #[cfg(test)]
        fail_exit_peek: false,
        group: Some(group),
        escalations: ctx.escalations.clone(),
        stdin: Some(Stdin { tx: in_tx, queued }),
        stdout: out_rx,
        log,
        stderr,
        tasks,
    })
}

/// The command that starts agent `agent` of another host for session `sid` in `cwd`:
/// the host's `argv`, then the agent, the lowercase hex of `cwd` and the sid
/// (DESIGN §3.8.5).
pub fn remote_argv(host: &HostConfig, agent: &str, cwd: &str, sid: &str) -> Vec<String> {
    let mut argv = host.argv.clone();
    argv.extend([agent.to_owned(), hex(cwd.as_bytes()), sid.to_owned()]);
    argv
}

/// Lowercase hex, two digits per byte.
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// The environment of an agent: `passEnv`, then `setEnv`, then the agent's own `env`,
/// then the names the hub sets, which nothing overrides. `SHELL` is bash's path.
pub fn agent_env(
    child: &ChildConfig,
    agent: &BTreeMap<String, String>,
    bash: &str,
    who: &Identity,
    sid: &str,
    hub_env: impl Fn(&str) -> Option<OsString>,
) -> Vec<(OsString, OsString)> {
    let mut env = BTreeMap::<OsString, OsString>::new();
    for name in &child.pass_env {
        if let Some(value) = hub_env(name) {
            env.insert(name.into(), value);
        }
    }
    for (name, value) in child.set_env.iter().chain(agent) {
        env.insert(name.into(), value.into());
    }
    let fixed = [
        ("HOME", who.home.as_str()),
        ("USER", &who.user),
        ("LOGNAME", &who.logname),
        ("SHELL", bash),
        ("WB_SESSION", sid),
    ];
    for (name, value) in fixed {
        env.insert(name.into(), value.into());
    }
    env.into_iter().collect()
}

/// The agent's stdin queue, capped in bytes.
pub struct Stdin {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    queued: Arc<AtomicUsize>,
}

impl Stdin {
    /// Queues one line; false if the queue is full or the writer has stopped.
    pub fn send(&self, line: Vec<u8>) -> bool {
        let len = line.len();
        if self.queued.load(Ordering::Relaxed) + len > STDIN_QUEUE {
            return false;
        }
        self.queued.fetch_add(len, Ordering::Relaxed);
        self.tx.send(line).is_ok()
    }

    /// Replace the pipe writer with a receptive queue for observing drain-time sends.
    #[cfg(test)]
    pub(super) fn capture(&mut self) -> mpsc::UnboundedReceiver<Vec<u8>> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self = Self {
            tx,
            queued: Arc::default(),
        };
        rx
    }
}

async fn write_stdin(
    mut stdin: ChildStdin,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
    queued: Arc<AtomicUsize>,
) {
    while let Some(line) = rx.recv().await {
        // A write error (EPIPE) ends the task; the exit is noticed through the child.
        if stdin.write_all(&line).await.is_err() {
            return;
        }
        queued.fetch_sub(line.len(), Ordering::Relaxed);
    }
}

async fn read_stdout(stdout: ChildStdout, tx: mpsc::Sender<Out>, log: Log) {
    let mut r = BufReader::with_capacity(64 << 10, stdout);
    loop {
        let line = match read_line_capped(&mut r, MAX_LINE).await {
            Ok(Read::Line(line)) => line,
            Ok(Read::Oversize(n)) => {
                log.write(format!("[stdout] a line of {n} bytes was discarded\n").as_bytes());
                continue;
            }
            Ok(Read::Eof) | Err(_) => break,
        };
        match serde_json::from_slice(&line) {
            Ok(Value::Object(msg)) => {
                if tx.send(Out::Msg(msg)).await.is_err() {
                    return;
                }
            }
            _ if line.is_empty() => {}
            _ => log.stdout(&line),
        }
    }
    let _ = tx.send(Out::Eof).await;
}

async fn read_stderr(stderr: Arc<AsyncFd<ChildStderr>>, log: Log) {
    let mut buf = vec![0; STDERR_CHUNK];
    while let Ok(1..) = stderr
        .async_io(Interest::READABLE, |pipe| {
            lock(&log.0).read_stderr(pipe, &mut buf)
        })
        .await
    {}
}

/// `acp/<sid>.stderr.log`: the agent's stderr, the stdout lines that are not JSON-RPC
/// and the hub's notes about the agent. Write errors are ignored.
#[derive(Clone)]
pub struct Log(Arc<Mutex<LogFile>>);

struct LogFile {
    path: PathBuf,
    file: Option<File>,
    size: u64,
    /// The last non-empty complete stderr line.
    last: String,
    /// The stderr bytes after the last newline.
    tail: Vec<u8>,
}

impl Log {
    fn open(path: PathBuf) -> Log {
        let file = open_log(&path);
        let size = file
            .as_ref()
            .and_then(|f| f.metadata().ok())
            .map_or(0, |m| m.len());
        Log(Arc::new(Mutex::new(LogFile {
            path,
            file,
            size,
            last: String::new(),
            tail: Vec::new(),
        })))
    }

    pub fn write(&self, bytes: &[u8]) {
        lock(&self.0).write(bytes);
    }

    /// A stdout line that is not a JSON object, cut to 4 KiB.
    pub fn stdout(&self, line: &[u8]) {
        let text = String::from_utf8_lossy(&line[..line.len().min(STDOUT_NOTE_MAX)]);
        self.write(format!("[stdout] {text}\n").as_bytes());
    }
}

impl LogFile {
    fn read_stderr(&mut self, pipe: &ChildStderr, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = rustix::io::retry_on_intr(|| rustix::io::read(pipe, &mut *buf))?;
        if n > 0 {
            self.stderr(&buf[..n]);
        }
        Ok(n)
    }

    fn stderr(&mut self, chunk: &[u8]) {
        self.write(chunk);
        self.tail.extend_from_slice(chunk);
        while let Some(end) = self.tail.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.tail.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line);
            if !text.trim().is_empty() {
                self.last = text.trim().to_owned();
            }
        }
        if self.tail.len() > TAIL_MAX {
            let cut = self.tail.len() - TAIL_MAX;
            self.tail.drain(..cut);
        }
    }

    /// The last non-empty stderr line, an unterminated one included.
    fn last_line(&self) -> String {
        let tail = String::from_utf8_lossy(&self.tail);
        match tail.trim() {
            "" => self.last.clone(),
            tail => tail.to_owned(),
        }
    }

    fn write(&mut self, bytes: &[u8]) {
        if self.size > 0 && self.size + bytes.len() as u64 > LOG_MAX {
            let mut old = self.path.clone().into_os_string();
            old.push(".1");
            let _ = std::fs::rename(&self.path, old);
            self.file = open_log(&self.path);
            self.size = 0;
        }
        if let Some(file) = &mut self.file
            && file.write_all(bytes).is_ok()
        {
            self.size += bytes.len() as u64;
        }
    }
}

fn open_log(path: &Path) -> Option<File> {
    OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .ok()
}

/// Sole wait owner from spawn through the last killpg. Never give a timer just the pid.
pub(crate) struct Group {
    child: Option<Child>,
    reaper: Sender<Child>,
}

impl Group {
    fn signal(&self, sig: Signal) {
        let pid = Pid::from_child(self.child.as_ref().expect("owned group leader"));
        let _ = kill_process_group(pid, sig);
        if sig == Signal::KILL {
            // The direct child can change groups; its unreaped pid is still ours.
            let _ = kill_process(pid, sig);
        }
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        if self.child.is_some() {
            self.signal(Signal::KILL);
            child::reap(self.child.take().unwrap(), &self.reaper);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_environment() {
        let child = ChildConfig {
            pass_env: vec!["LANG".into(), "MISSING".into()],
            set_env: [("PATH".to_string(), "/etc/workbench/bin".to_string())].into(),
        };
        let agent = [
            ("RUST_LOG".to_string(), "error".to_string()),
            ("LANG".to_string(), "C.UTF-8".to_string()),
            ("SHELL".to_string(), "/bin/zsh".to_string()),
        ]
        .into();
        let who = Identity {
            home: "/home/alice".into(),
            user: "alice".into(),
            logname: "alice".into(),
        };
        let hub_env = |name: &str| (name == "LANG").then(|| OsString::from("en_IE.UTF-8"));
        let env = agent_env(&child, &agent, "/bin/bash", &who, "n_1", hub_env);
        let env: BTreeMap<String, String> = env
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap()))
            .collect();
        let want: BTreeMap<String, String> = [
            ("HOME", "/home/alice"),
            ("USER", "alice"),
            ("LOGNAME", "alice"),
            ("SHELL", "/bin/bash"),
            ("WB_SESSION", "n_1"),
            ("PATH", "/etc/workbench/bin"),
            ("LANG", "C.UTF-8"),
            ("RUST_LOG", "error"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
        assert_eq!(env, want);
    }

    #[test]
    fn hex_is_lowercase_two_digits_per_byte() {
        assert_eq!(hex(b""), "");
        assert_eq!(hex(b"/a b\n\x00\xff"), "2f6120620a00ff");
        assert_eq!(hex("/ä".as_bytes()), "2fc3a4");
    }

    #[test]
    fn remote_argv_appends_three_plain_words() {
        let host = HostConfig {
            argv: vec!["/bin/ssh".into(), "-T".into(), "laptop".into()],
            agents: BTreeMap::new(),
        };
        let cwd = "/home/alice/my proj/$(rm -rf ~);'x'\nü";
        let argv = remote_argv(&host, "claude-2", cwd, "n_k3m-9");
        assert_eq!(argv[..3], ["/bin/ssh", "-T", "laptop"]);
        assert_eq!(argv[3], "claude-2");
        assert_eq!(argv[5], "n_k3m-9");
        assert_eq!(argv.len(), 6);
        let decoded: Vec<u8> = (0..argv[4].len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&argv[4][i..i + 2], 16).unwrap())
            .collect();
        assert_eq!(decoded, cwd.as_bytes());
        for arg in &argv[3..] {
            let plain = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
            assert!(!arg.is_empty() && arg.bytes().all(plain), "{arg:?}");
        }
    }

    #[test]
    fn stderr_last_line() {
        let dir = std::env::temp_dir().join(format!("wb-agent-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let log = Log::open(dir.join("s.stderr.log"));
        let mut log = lock(&log.0);
        log.stderr(b"first\n\n  \nbo");
        assert_eq!(log.last_line(), "bo");
        log.stderr(b"om\n");
        assert_eq!(log.last_line(), "boom");
        log.stderr(b" \n");
        assert_eq!(log.last_line(), "boom");
        let text = std::fs::read_to_string(dir.join("s.stderr.log")).unwrap();
        assert_eq!(text, "first\n\n  \nboom\n \n");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
