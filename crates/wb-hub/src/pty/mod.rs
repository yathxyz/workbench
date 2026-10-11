//! PTY sessions: one actor task per sid owns the child, the master, the ring and the
//! viewers. Every change to a session happens in its actor, so a reply and the output
//! around it are always ordered.

mod io;
mod out;
mod spawn;

use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use rustix::process::Signal;
use rustix::termios::{Winsize, tcsetwinsize};
use tokio::io::unix::AsyncFd;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tracing::{info, warn};
use wb_proto::hub::{
    ErrorCode, Exit, ExitReason, HubMessage, Kind, PtyFacts, PtyOpenReply, SpawnPty, Summary,
};
use wb_proto::limits::PTY_RING;

use self::io::{InputQueue, Master};
use self::out::{OutStream, Ring};
use crate::conn::{ConnId, Reply, Viewer, line};
use crate::outq::OutQ;
use crate::registry::Route;
use crate::{Ctx, env, now_ms, procfs};

/// Bytes per read of the master.
const READ_CHUNK: usize = 64 << 10;
/// How long output is still read after the child exited.
const DRAIN: Duration = Duration::from_millis(200);
/// From SIGHUP to SIGKILL of the members of a killed session.
const KILL_AFTER: Duration = Duration::from_secs(3);

/// A request to a session actor.
pub enum Cmd {
    Open(Open),
    Input {
        d: String,
        from: Arc<OutQ>,
    },
    Resize {
        cols: u32,
        rows: u32,
    },
    Kill {
        forget: bool,
        reply: Reply,
    },
    Detach {
        conn: ConnId,
        reply: Option<Reply>,
    },
    /// End the child for a hub shutdown; `done` fires once it exited.
    Shutdown {
        done: oneshot::Sender<()>,
    },
}

pub struct Open {
    pub viewer: Viewer,
    pub cols: u32,
    pub rows: u32,
    pub spawn: Option<SpawnPty>,
    pub reply: Reply,
}

impl Cmd {
    /// Answers a command that the session can no longer carry out.
    pub fn refuse(self, code: ErrorCode, message: &str) {
        match self {
            Cmd::Open(Open { reply, .. })
            | Cmd::Kill { reply, .. }
            | Cmd::Detach {
                reply: Some(reply), ..
            } => reply.err(code, message),
            Cmd::Shutdown { done } => {
                let _ = done.send(());
            }
            Cmd::Input { .. } | Cmd::Resize { .. } | Cmd::Detach { reply: None, .. } => {}
        }
    }
}

/// Delivers a `pty.open` to its session. An open with spawn fields for an unknown sid
/// registers the session and starts its actor.
///
/// Boxed because a forgotten actor routes its queued opens through here again.
pub fn open(ctx: Arc<Ctx>, sid: String, open: Open) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        // The second round covers an actor that was forgotten between the lookup and
        // the send; it removed its registry entry before it stopped receiving.
        for _ in 0..2 {
            match ctx.registry.route(&sid, open.spawn.is_some()) {
                Route::Send(tx) => {
                    if let Ok(permit) = tx.reserve().await {
                        return permit.send(Cmd::Open(open));
                    }
                }
                Route::Created { created_at, rx } => {
                    let pty = Pty::new(ctx.clone(), sid, created_at);
                    tokio::spawn(pty.run(rx, open));
                    return;
                }
                Route::NotFound => {
                    return open
                        .reply
                        .err(ErrorCode::NotFound, format!("no session {sid}"));
                }
                Route::Stopping => return open.reply.err(ErrorCode::Internal, "hub stopping"),
            }
        }
        open.reply.err(ErrorCode::Internal, "session actor is gone");
    })
}

#[derive(PartialEq, Eq)]
enum Phase {
    Running,
    /// Removed from the registry; queued opens are routed again.
    Forgotten,
    /// The hub is stopping; every request is refused.
    Stopped,
}

enum Event {
    Cmd(Option<Cmd>),
    Read(std::io::Result<usize>),
    Wrote(std::io::Result<usize>),
    Exited(std::io::Result<std::process::ExitStatus>),
    Drained,
}

struct Pty {
    ctx: Arc<Ctx>,
    sid: String,
    created_at: u64,
    updated_at: u64,
    /// When this actor started; offsets in `out` count from here.
    stream: u64,
    phase: Phase,
    argv: Vec<String>,
    cwd: String,
    size: Winsize,
    viewers: Vec<Viewer>,
    decoder: OutStream,
    ring: Ring,
    input: InputQueue,
    /// From spawn until the exit is finished; `alive` is `pid.is_some()`.
    pid: Option<u32>,
    master: Option<Master>,
    /// Until `wait` returns.
    child: Option<Child>,
    /// The master reported end of output.
    eof: bool,
    /// Code and signal of an exited child whose remaining output is being drained.
    status: Option<(Option<i32>, Option<i32>)>,
    drain_until: Option<Instant>,
    exit: Option<Exit>,
    killing: bool,
    /// Set on `Shutdown`; fires when the child's exit is finished.
    stopping: Option<oneshot::Sender<()>>,
    /// `pty.kill{forget:true}` replies, sent after the exit and the forget.
    forgets: Vec<Reply>,
}

impl Pty {
    fn new(ctx: Arc<Ctx>, sid: String, created_at: u64) -> Self {
        Self {
            ctx,
            sid,
            created_at,
            updated_at: created_at,
            stream: now_ms(),
            phase: Phase::Running,
            argv: Vec::new(),
            cwd: String::new(),
            size: winsize(80, 24),
            viewers: Vec::new(),
            decoder: OutStream::default(),
            ring: Ring::new(PTY_RING),
            input: InputQueue::default(),
            pid: None,
            master: None,
            child: None,
            eof: false,
            status: None,
            drain_until: None,
            exit: None,
            killing: false,
            stopping: None,
            forgets: Vec::new(),
        }
    }

    async fn run(mut self, mut rx: mpsc::Receiver<Cmd>, first: Open) {
        self.open(first);
        let mut buf = vec![0; READ_CHUNK];
        while self.phase == Phase::Running {
            let event = {
                let reading = self.master.as_ref().filter(|_| !self.eof);
                let writing = self.master.as_ref().filter(|_| !self.input.is_empty());
                tokio::select! {
                    cmd = rx.recv() => Event::Cmd(cmd),
                    r = io::read(reading, &mut buf) => Event::Read(r),
                    r = io::write(writing, self.input.front()) => Event::Wrote(r),
                    st = wait(self.child.as_mut()) => Event::Exited(st),
                    () = sleep_until(self.drain_until) => Event::Drained,
                }
            };
            match event {
                Event::Cmd(Some(cmd)) => self.command(cmd),
                Event::Cmd(None) => return,
                Event::Read(Ok(0)) => self.end_of_output(),
                Event::Read(Ok(n)) => {
                    if let Some(d) = self.decoder.push(&buf[..n]) {
                        self.output(d);
                    }
                }
                Event::Read(Err(e)) => {
                    warn!(sid = %self.sid, "reading the PTY: {e}");
                    self.end_of_output();
                }
                Event::Wrote(Ok(n)) => self.input.advance(n),
                Event::Wrote(Err(e)) => {
                    warn!(sid = %self.sid, "writing the PTY: {e}; dropping queued input");
                    self.input.clear();
                }
                Event::Exited(st) => self.exited(st),
                Event::Drained => self.finish_exit(),
            }
        }
        if self.phase == Phase::Forgotten {
            rx.close();
            while let Some(cmd) = rx.recv().await {
                match cmd {
                    Cmd::Open(o) => {
                        tokio::spawn(open(self.ctx.clone(), self.sid.clone(), o));
                    }
                    cmd => cmd.refuse(ErrorCode::NotFound, "the session was forgotten"),
                }
            }
        } else {
            while let Some(cmd) = rx.recv().await {
                cmd.refuse(ErrorCode::Internal, "hub stopping");
            }
        }
    }

    fn command(&mut self, cmd: Cmd) {
        if self.stopping.is_some() {
            return cmd.refuse(ErrorCode::Internal, "hub stopping");
        }
        match cmd {
            Cmd::Open(o) => self.open(o),
            Cmd::Input { d, from } => {
                if self.master.is_some() && self.input.push(d.into_bytes()).is_err() {
                    let msg = HubMessage::Err {
                        rid: None,
                        sid: Some(self.sid.clone()),
                        code: ErrorCode::InputOverflow,
                        message: "the PTY input queue is full; the input was dropped".into(),
                    };
                    let _ = from.push_event(line(&msg));
                }
            }
            Cmd::Resize { cols, rows } => self.resize(winsize(cols, rows)),
            Cmd::Kill { forget, reply } => self.kill(forget, reply),
            Cmd::Detach { conn, reply } => {
                let before = self.viewers.len();
                self.viewers.retain(|v| v.id != conn);
                if self.viewers.len() != before {
                    self.publish();
                }
                if let Some(reply) = reply {
                    reply.done();
                }
            }
            Cmd::Shutdown { done } => {
                self.finish_exit();
                if self.pid.is_some() {
                    self.stopping = Some(done);
                    self.hangup();
                } else {
                    let _ = done.send(());
                    self.phase = Phase::Stopped;
                }
            }
        }
    }

    fn open(&mut self, o: Open) {
        let Open {
            viewer,
            cols,
            rows,
            spawn,
            reply,
        } = o;
        let size = winsize(cols, rows);
        match spawn {
            Some(spawn) if self.pid.is_none() || self.status.is_some() => {
                self.finish_exit();
                self.spawn(viewer, size, spawn, reply);
            }
            _ => {
                if self.viewers.iter().all(|v| v.id == viewer.id) {
                    self.resize(size);
                }
                let cwd = self.pid.and_then(procfs::cwd);
                reply.ok(&PtyOpenReply {
                    new: false,
                    pid: self.pid,
                    cwd: cwd.unwrap_or_else(|| self.cwd.clone()),
                    exit: self.exit.clone(),
                    epoch: self.created_at,
                    stream: self.stream,
                    out: self.ring.end(),
                    resumed: false,
                    replay: Some(self.ring.text()),
                });
                self.attach(viewer);
            }
        }
    }

    fn spawn(&mut self, viewer: Viewer, size: Winsize, spawn: SpawnPty, reply: Reply) {
        let ctx = &self.ctx;
        let cwd = self.spawn_cwd(&spawn);
        let env = env::pty_env(
            &ctx.cfg.child,
            &ctx.ident,
            &self.sid,
            spawn.env.as_ref(),
            |name| std::env::var_os(name),
        );
        let spawned = spawn::spawn(&spawn.argv, &env, &cwd, size, ctx.child_umask)
            .and_then(|s| Ok((AsyncFd::new(s.master)?, s.child)));
        let (master, child) = match spawned {
            Ok(spawned) => spawned,
            Err(e) => {
                warn!(sid = %self.sid, argv = ?spawn.argv, "spawn failed: {e}");
                reply.err(ErrorCode::SpawnFailed, format!("spawn failed: {e}"));
                if self.ctx.registry.abandon(&self.sid, self.created_at) {
                    self.phase = Phase::Forgotten;
                }
                return;
            }
        };
        let pid = child.id();
        info!(sid = %self.sid, ?pid, argv = ?spawn.argv, cwd = %cwd, "spawned");
        self.argv = spawn.argv;
        self.cwd = cwd;
        self.size = size;
        self.pid = pid;
        self.master = Some(master);
        self.child = Some(child);
        self.eof = false;
        self.exit = None;
        self.killing = false;
        reply.ok(&PtyOpenReply {
            new: true,
            pid,
            cwd: self.cwd.clone(),
            exit: None,
            epoch: self.created_at,
            stream: self.stream,
            out: self.ring.end(),
            resumed: false,
            replay: None,
        });
        self.attach(viewer);
        self.publish();
    }

    /// The cwd of a live `cwdFrom`, then `cwd`, then `$HOME`; the first that is a
    /// directory.
    fn spawn_cwd(&self, spawn: &SpawnPty) -> String {
        let from = spawn
            .cwd_from
            .as_deref()
            .and_then(|sid| self.ctx.registry.live_pid(sid))
            .and_then(procfs::cwd);
        [from, spawn.cwd.clone()]
            .into_iter()
            .flatten()
            .find(|dir| Path::new(dir).is_dir())
            .unwrap_or_else(|| self.ctx.ident.home.clone())
    }

    fn attach(&mut self, viewer: Viewer) {
        if self.viewers.iter().any(|v| v.id == viewer.id) {
            return;
        }
        self.viewers.push(viewer);
        self.publish();
    }

    fn resize(&mut self, size: Winsize) {
        if (size.ws_col, size.ws_row) == (self.size.ws_col, self.size.ws_row) {
            return;
        }
        self.size = size;
        if let Some(master) = &self.master
            && let Err(e) = tcsetwinsize(master.get_ref(), size)
        {
            warn!(sid = %self.sid, "resizing the PTY: {e}");
        }
    }

    fn kill(&mut self, forget: bool, reply: Reply) {
        self.finish_exit();
        if self.pid.is_some() {
            self.hangup();
            if forget {
                self.forgets.push(reply);
            } else {
                reply.done();
            }
        } else {
            if forget {
                self.forget();
            }
            reply.done();
        }
    }

    /// SIGHUP to every member of the child's session now, SIGKILL to the survivors later.
    fn hangup(&mut self) {
        let Some(pid) = self.pid else { return };
        if self.killing {
            return;
        }
        self.killing = true;
        procfs::signal_session(pid, Signal::HUP);
        tokio::spawn(async move {
            tokio::time::sleep(KILL_AFTER).await;
            procfs::signal_session(pid, Signal::KILL);
        });
    }

    fn output(&mut self, d: String) {
        let out = self.ring.push(&d);
        let msg = line(&HubMessage::PtyOut {
            sid: self.sid.clone(),
            d,
            out,
        });
        self.fan_out(&msg);
    }

    /// Sends `msg` to every viewer, dropping viewers whose connection overflowed.
    fn fan_out(&mut self, msg: &Arc<[u8]>) {
        let before = self.viewers.len();
        self.viewers
            .retain(|v| v.outq.push_event(msg.clone()).is_ok());
        if self.viewers.len() != before {
            self.publish();
        }
    }

    fn end_of_output(&mut self) {
        self.eof = true;
        self.finish_exit();
    }

    fn exited(&mut self, st: std::io::Result<std::process::ExitStatus>) {
        self.child = None;
        let status = match st {
            Ok(st) => (st.code(), st.signal()),
            Err(e) => {
                warn!(sid = %self.sid, "waiting for the child: {e}");
                (None, None)
            }
        };
        self.status = Some(status);
        if self.eof {
            self.finish_exit();
        } else {
            self.drain_until = Some(Instant::now() + DRAIN);
        }
    }

    /// Completes the exit of a child whose output was being drained: closes the master,
    /// tells the viewers and the watchers, and answers what waited for the exit. A no-op
    /// unless the child has exited.
    fn finish_exit(&mut self) {
        let Some((code, signal)) = self.status.take() else {
            return;
        };
        if let Some(d) = self.decoder.flush() {
            self.output(d);
        }
        self.master = None;
        self.pid = None;
        self.drain_until = None;
        self.input.clear();
        let reason = if self.stopping.is_some() {
            ExitReason::HubRestart
        } else if self.killing {
            ExitReason::Killed
        } else {
            ExitReason::Exited
        };
        self.killing = false;
        info!(sid = %self.sid, ?code, ?signal, ?reason, "exited");
        self.exit = Some(Exit {
            code,
            signal,
            reason,
            at: now_ms(),
        });
        let msg = line(&HubMessage::PtyExit {
            sid: self.sid.clone(),
            code,
            signal,
            reason,
        });
        self.fan_out(&msg);
        self.publish();
        if !self.forgets.is_empty() {
            self.forget();
            for reply in self.forgets.drain(..) {
                reply.done();
            }
        }
        if let Some(done) = self.stopping.take() {
            let _ = done.send(());
            self.phase = Phase::Stopped;
        }
    }

    /// Removes the session from the registry; `gone` goes to the watchers and viewers.
    fn forget(&mut self) {
        self.ctx
            .registry
            .forget(&self.sid, self.created_at, &self.viewers);
        self.viewers.clear();
        self.phase = Phase::Forgotten;
    }

    fn publish(&mut self) {
        self.updated_at = now_ms().max(self.updated_at);
        self.ctx.registry.publish(&Summary {
            sid: self.sid.clone(),
            kind: Kind::Pty,
            host: self.ctx.cfg.host.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            alive: self.pid.is_some(),
            viewers: u32::try_from(self.viewers.len()).unwrap_or(u32::MAX),
            cwd: self.cwd.clone(),
            fault: None,
            pty: Some(PtyFacts {
                argv: self.argv.clone(),
                pid: self.pid,
                fg: None,
                exit: self.exit.clone(),
            }),
            acp: None,
        });
    }
}

/// The terminal size, clamped to cols 2..=1000 and rows 1..=500.
fn winsize(cols: u32, rows: u32) -> Winsize {
    Winsize {
        ws_col: cols.clamp(2, 1000) as u16,
        ws_row: rows.clamp(1, 500) as u16,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

async fn wait(child: Option<&mut Child>) -> std::io::Result<std::process::ExitStatus> {
    match child {
        Some(child) => child.wait().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_are_clamped() {
        let ws = winsize(0, 0);
        assert_eq!((ws.ws_col, ws.ws_row), (2, 1));
        let ws = winsize(u32::MAX, 100_000);
        assert_eq!((ws.ws_col, ws.ws_row), (1000, 500));
        let ws = winsize(120, 40);
        assert_eq!((ws.ws_col, ws.ws_row), (120, 40));
    }
}
