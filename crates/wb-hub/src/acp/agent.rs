//! One agent process (10-hub §7.1): its spawn and environment, the stdin writer, the
//! stdout reader and the stderr log, and signals to its process group.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustix::process::{Pid, Signal, kill_process_group, test_kill_process_group};
use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use wb_proto::limits::{MAX_LINE, PROMPT_MAX};

use super::lines::{Read, read_line_capped};
use crate::config::{AgentConfig, ChildConfig};
use crate::env::Identity;
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
/// Objects read from stdout that wait for the actor; backpressure on the agent.
const STDOUT_QUEUE: usize = 4;

/// What the stdout reader delivers.
pub enum Out {
    Msg(Map<String, Value>),
    Eof,
}

/// A running agent. Dropping it stops its I/O tasks; the process is not signalled.
pub struct Agent {
    pub pid: u32,
    pub child: Child,
    /// `None` once closed: the writer sends what is queued, then closes the pipe.
    pub stdin: Option<Stdin>,
    pub stdout: mpsc::Receiver<Out>,
    pub log: Log,
    tasks: [JoinHandle<()>; 3],
}

impl Drop for Agent {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Starts the agent of `sid` in `cwd` with the environment of DESIGN §3.7.3; its stderr
/// goes to `log`. An error is the `setup_error{spawn_failed}` message.
pub fn start(
    ctx: &Ctx,
    sid: &str,
    agent: &AgentConfig,
    cwd: &str,
    log: PathBuf,
) -> Result<Agent, String> {
    // DELTA-1 §B.3: agents' tool runners expect a POSIX shell, whatever the cards run.
    let bash = ctx
        .cfg
        .shell("bash")
        .and_then(|s| s.resolve())
        .ok_or("shell bash not available for the agent's SHELL")?;
    let env = agent_env(&ctx.cfg.child, &agent.env, bash, &ctx.ident, sid, |n| {
        std::env::var_os(n)
    });
    let (program, args) = agent.argv.split_first().ok_or("empty argv")?;
    let mut child = spawn_agent(Path::new(program), args, &env, cwd, ctx.child_umask)
        .map_err(|e| format!("spawn failed: {e}"))?;
    let pid = child.id().ok_or("the agent was reaped at once")?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err("the agent's pipes are missing".into());
    };
    let log = Log::open(log);
    let queued = Arc::new(AtomicUsize::new(0));
    let (in_tx, in_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::channel(STDOUT_QUEUE);
    let tasks = [
        tokio::spawn(write_stdin(stdin, in_rx, queued.clone())),
        tokio::spawn(read_stdout(stdout, out_tx, log.clone())),
        tokio::spawn(read_stderr(stderr, log.clone())),
    ];
    Ok(Agent {
        pid,
        child,
        stdin: Some(Stdin { tx: in_tx, queued }),
        stdout: out_rx,
        log,
        tasks,
    })
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

async fn read_stderr(mut stderr: ChildStderr, log: Log) {
    let mut buf = vec![0; 8 << 10];
    while let Ok(n @ 1..) = stderr.read(&mut buf).await {
        log.stderr(&buf[..n]);
    }
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

    fn stderr(&self, chunk: &[u8]) {
        let mut log = lock(&self.0);
        log.write(chunk);
        log.tail.extend_from_slice(chunk);
        while let Some(end) = log.tail.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = log.tail.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line);
            if !text.trim().is_empty() {
                log.last = text.trim().to_owned();
            }
        }
        if log.tail.len() > TAIL_MAX {
            let cut = log.tail.len() - TAIL_MAX;
            log.tail.drain(..cut);
        }
    }

    /// The last non-empty stderr line, an unterminated one included.
    pub fn last_line(&self) -> String {
        let log = lock(&self.0);
        let tail = String::from_utf8_lossy(&log.tail);
        match tail.trim() {
            "" => log.last.clone(),
            tail => tail.to_owned(),
        }
    }
}

impl LogFile {
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

/// Sends `sig` to the process group `pgid`.
pub fn signal_group(pgid: u32, sig: Signal) {
    if let Some(pid) = i32::try_from(pgid).ok().and_then(Pid::from_raw) {
        let _ = kill_process_group(pid, sig);
    }
}

/// Whether the process group `pgid` still has members.
pub fn group_alive(pgid: u32) -> bool {
    i32::try_from(pgid)
        .ok()
        .and_then(Pid::from_raw)
        .is_some_and(|pid| test_kill_process_group(pid).is_ok())
}

/// SIGTERM to the group now and SIGKILL to what is left of it after `grace`.
pub fn end_group(pgid: u32, grace: Duration) {
    signal_group(pgid, Signal::TERM);
    tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        if group_alive(pgid) {
            signal_group(pgid, Signal::KILL);
        }
    });
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
    fn stderr_last_line() {
        let dir = std::env::temp_dir().join(format!("wb-agent-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let log = Log::open(dir.join("s.stderr.log"));
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
