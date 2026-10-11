//! PTY sessions: one actor task per sid owns the child, the master, the VT state, the
//! ring and the files. Every change to a session happens in its actor, so a reply and
//! the output around it are always ordered. A supervisor task per sid reloads the
//! session from disk when its actor panics.

mod io;
mod out;
mod spawn;
mod vt;

use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustix::process::Signal;
use rustix::termios::{Winsize, tcgetpgrp, tcsetwinsize};
use tokio::io::unix::AsyncFd;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tracing::{Instrument, error, info, info_span, warn};
use wb_proto::hub::{
    CaptureReply, ErrorCode, Exit, ExitReason, Fault, FaultCode, Fg, HubMessage, Kind, PtyFacts,
    PtyOpenReply, Resume, SpawnPty, Summary,
};
use wb_proto::limits::{FG_POLL, PTY_RING, SNAPSHOT_EVERY};

use self::io::{InputQueue, Master};
use self::out::{OutStream, Ring};
use self::vt::Vt;
use crate::conn::{ConnId, Reply, Viewer, line};
use crate::outq::OutQ;
use crate::registry::Route;
use crate::store::{self, Record, Store};
use crate::{Ctx, env, lock, now_ms, procfs};

/// Bytes per read of the master.
const READ_CHUNK: usize = 64 << 10;
/// How long output is still read after the child exited.
const DRAIN: Duration = Duration::from_millis(200);
/// From SIGHUP to SIGKILL of the members of a killed session.
const KILL_AFTER: Duration = Duration::from_secs(3);
/// How long the output stream may hold back an incomplete tail without new output.
const HOLD_IDLE: Duration = Duration::from_millis(20);
/// How long an attach to a full-screen app keeps the PTY one row short.
const NUDGE: Duration = Duration::from_millis(50);

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
    Capture {
        lines: usize,
        reply: Reply,
    },
    /// End the child for a hub shutdown; `done` fires once its exit is recorded.
    Shutdown {
        done: oneshot::Sender<()>,
    },
}

pub struct Open {
    pub viewer: Viewer,
    pub cols: u32,
    pub rows: u32,
    pub spawn: Option<SpawnPty>,
    pub resume: Option<Resume>,
    pub reply: Reply,
}

impl Cmd {
    /// Answers a command that the session can no longer carry out.
    pub fn refuse(self, code: ErrorCode, message: &str) {
        match self {
            Cmd::Open(Open { reply, .. })
            | Cmd::Kill { reply, .. }
            | Cmd::Capture { reply, .. }
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

/// What a session's actor starts from.
pub enum Start {
    /// A new sid, and the open with spawn fields that created it.
    Open(Open),
    /// A record from the state directory: a dead session.
    Loaded(Record),
    /// A session whose files failed to load and were quarantined; the reason.
    Faulted(String),
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
                    return start(ctx.clone(), sid, created_at, rx, Start::Open(open));
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

/// Starts the supervised actor of a registered session. A loaded or faulted session is
/// published before this returns.
pub fn start(ctx: Arc<Ctx>, sid: String, created_at: u64, rx: mpsc::Receiver<Cmd>, from: Start) {
    let (mut pty, writes) = Pty::new(ctx, sid, created_at, Viewers::default());
    let first = pty.begin(from);
    tokio::spawn(supervise(pty, writes, rx, first));
}

/// Runs the actor of one session. After a panic it kills the session's processes, tells
/// the attached connections, and reloads the session from disk the way startup does.
async fn supervise(
    mut pty: Pty,
    mut writes: JoinHandle<()>,
    mut rx: mpsc::Receiver<Cmd>,
    mut first: Option<Open>,
) {
    let (ctx, sid, created_at) = (pty.ctx.clone(), pty.sid.clone(), pty.created_at);
    let viewers = pty.viewers.clone();
    loop {
        // The span names the session in the actor's logs, the parser's included.
        let actor = pty.run(rx, first).instrument(info_span!("pty", %sid));
        let ended = tokio::spawn(actor).await;
        // Every write the actor queued lands before the session is read back.
        let _ = writes.await;
        match ended {
            Err(e) if e.is_panic() => error!(%sid, "the session actor panicked: {e}"),
            _ => return,
        }
        if let Some(pid) = ctx.registry.live_pid(&sid) {
            kill_session(pid);
        }
        let dropped = std::mem::take(&mut *lock(&viewers));
        let back = match store::load_or_quarantine(ctx.pty_dir.clone(), sid.clone()).await {
            Ok(Some(rec)) => Some(Start::Loaded(rec)),
            Ok(None) => {
                ctx.registry.forget(&sid, created_at, &[]);
                None
            }
            Err(fault) => Some(Start::Faulted(fault)),
        }
        .and_then(|from| Some((from, ctx.registry.reopen(&sid, created_at)?)));
        let Some((from, next)) = back else {
            return tell_reloaded(&sid, dropped);
        };
        rx = next;
        (pty, writes) = Pty::new(ctx.clone(), sid.clone(), created_at, viewers.clone());
        first = pty.begin(from);
        tell_reloaded(&sid, dropped);
    }
}

/// Detaches the viewers of a reloaded session with `err{internal}`, once the reloaded
/// session is in the registry.
fn tell_reloaded(sid: &str, viewers: Vec<Viewer>) {
    let reloaded = line(&HubMessage::Err {
        rid: None,
        sid: Some(sid.to_owned()),
        code: ErrorCode::Internal,
        message: "session reloaded".into(),
    });
    for v in viewers {
        let _ = v.outq.push_event(reloaded.clone());
    }
}

/// SIGHUP to every member of the session of `leader` now, SIGKILL to the survivors later.
fn kill_session(leader: u32) {
    procfs::signal_session(leader, Signal::HUP);
    tokio::spawn(async move {
        tokio::time::sleep(KILL_AFTER).await;
        procfs::signal_session(leader, Signal::KILL);
    });
}

/// The connections attached to a session, shared with its supervisor.
type Viewers = Arc<Mutex<Vec<Viewer>>>;

#[derive(PartialEq, Eq)]
enum Phase {
    Running,
    /// Delete the files and the registry entry, answer `forgets`, then route the queued
    /// commands again, in order.
    Forget,
    /// Already removed from the registry: route the queued commands again.
    Abandoned,
    /// The hub is stopping; every request is refused.
    Stopped,
}

enum Event {
    Cmd(Option<Cmd>),
    Read(std::io::Result<usize>),
    Wrote(std::io::Result<usize>),
    Exited(std::io::Result<std::process::ExitStatus>),
    Drained,
    Release,
    NudgeEnd,
    Poll,
    Snapshot,
}

struct Pty {
    ctx: Arc<Ctx>,
    sid: String,
    created_at: u64,
    updated_at: u64,
    /// When this actor started; offsets in `out` count from here.
    stream: u64,
    phase: Phase,
    store: Store,
    viewers: Viewers,
    /// What `<sid>.json` holds; `cwd` follows the live child.
    rec: Record,
    /// Why the session's files could not be loaded.
    fault: Option<String>,
    /// The desired size: the last resize, or the size of the last sizing open.
    size: Winsize,
    /// The screen of a live child. Dead sessions hold none; their snapshot is on disk.
    vt: Option<Vt>,
    /// Output or a resize since the last snapshot was written.
    dirty: bool,
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
    fg: Option<Fg>,
    killing: bool,
    /// Set on `Shutdown`; fires once the exit is recorded on disk.
    stopping: Option<oneshot::Sender<()>>,
    /// `pty.kill{forget:true}` replies, sent after the exit and the forget.
    forgets: Vec<Reply>,
    /// An open whose exit handling forgot this session; routed again before the queue.
    rerouted: Option<Open>,
    drain_until: Option<Instant>,
    /// When the output stream releases what it holds back.
    release_at: Option<Instant>,
    /// When a nudge restores the desired size.
    nudge_until: Option<Instant>,
    poll_at: Option<Instant>,
    snapshot_at: Option<Instant>,
}

impl Pty {
    fn new(
        ctx: Arc<Ctx>,
        sid: String,
        created_at: u64,
        viewers: Viewers,
    ) -> (Self, JoinHandle<()>) {
        let (store, writes) = Store::start(ctx.pty_dir.clone(), sid.clone());
        let size = winsize(80, 24);
        let rec = Record {
            sid: sid.clone(),
            shell: String::new(),
            argv: Vec::new(),
            cwd: String::new(),
            env: Default::default(),
            created_at,
            cols: size.ws_col,
            rows: size.ws_row,
            exit: None,
        };
        let pty = Self {
            ctx,
            sid,
            created_at,
            updated_at: created_at,
            stream: now_ms(),
            phase: Phase::Running,
            store,
            viewers,
            rec,
            fault: None,
            size,
            vt: None,
            dirty: false,
            decoder: OutStream::new(),
            ring: Ring::new(PTY_RING),
            input: InputQueue::default(),
            pid: None,
            master: None,
            child: None,
            eof: false,
            status: None,
            fg: None,
            killing: false,
            stopping: None,
            forgets: Vec::new(),
            rerouted: None,
            drain_until: None,
            release_at: None,
            nudge_until: None,
            poll_at: None,
            snapshot_at: None,
        };
        (pty, writes)
    }

    /// Takes on the starting state; the open of a new session is returned to `run`.
    fn begin(&mut self, from: Start) -> Option<Open> {
        match from {
            Start::Open(o) => return Some(o),
            Start::Loaded(rec) => {
                self.size = winsize(rec.cols.into(), rec.rows.into());
                self.rec = rec;
            }
            Start::Faulted(reason) => self.fault = Some(reason),
        }
        self.publish();
        None
    }

    async fn run(mut self, mut rx: mpsc::Receiver<Cmd>, first: Option<Open>) {
        if let Some(o) = first {
            self.open(o).await;
        }
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
                    () = sleep_until(self.release_at) => Event::Release,
                    () = sleep_until(self.nudge_until) => Event::NudgeEnd,
                    () = sleep_until(self.poll_at) => Event::Poll,
                    () = sleep_until(self.snapshot_at) => Event::Snapshot,
                }
            };
            match event {
                Event::Cmd(Some(cmd)) => self.command(cmd).await,
                Event::Cmd(None) => return,
                Event::Read(Ok(0)) => self.end_of_output(),
                Event::Read(Ok(n)) => {
                    if let Some(d) = self.decoder.push(&buf[..n]) {
                        self.output(d);
                    }
                    self.release_at = Some(Instant::now() + HOLD_IDLE);
                }
                Event::Read(Err(e)) => {
                    warn!("reading the PTY: {e}");
                    self.end_of_output();
                }
                Event::Wrote(Ok(n)) => self.input.advance(n),
                Event::Wrote(Err(e)) => {
                    warn!("writing the PTY: {e}; dropping queued input");
                    self.input.clear();
                }
                Event::Exited(st) => self.exited(st),
                Event::Drained => self.finish_exit(),
                Event::Release => {
                    self.release_at = None;
                    if let Some(d) = self.decoder.flush() {
                        self.output(d);
                    }
                }
                Event::NudgeEnd => self.nudge_end(),
                Event::Poll => {
                    self.poll_at = Some(Instant::now() + FG_POLL);
                    self.poll_fg();
                }
                Event::Snapshot => {
                    self.snapshot_at = Some(Instant::now() + SNAPSHOT_EVERY);
                    if self.dirty {
                        self.save(true);
                    }
                }
            }
        }
        match self.phase {
            Phase::Forget => {
                self.store.delete().await;
                let viewers = std::mem::take(&mut *lock(&self.viewers));
                self.ctx
                    .registry
                    .forget(&self.sid, self.created_at, &viewers);
                for reply in self.forgets.drain(..) {
                    reply.done();
                }
                if let Some(done) = self.stopping.take() {
                    let _ = done.send(());
                }
                self.reroute(rx).await;
            }
            Phase::Abandoned => self.reroute(rx).await,
            Phase::Stopped => {
                self.store.flush().await;
                if let Some(done) = self.stopping.take() {
                    let _ = done.send(());
                }
                while let Some(cmd) = rx.recv().await {
                    cmd.refuse(ErrorCode::Internal, "hub stopping");
                }
            }
            Phase::Running => {}
        }
    }

    /// Routes the commands that reached this forgotten actor to whatever now holds the
    /// sid, one at a time and in order, so input sent after an open follows it to the
    /// new incarnation the open creates.
    async fn reroute(&mut self, mut rx: mpsc::Receiver<Cmd>) {
        rx.close();
        if let Some(o) = self.rerouted.take() {
            redeliver(&self.ctx, &self.sid, Cmd::Open(o)).await;
        }
        while let Some(cmd) = rx.recv().await {
            redeliver(&self.ctx, &self.sid, cmd).await;
        }
    }

    async fn command(&mut self, cmd: Cmd) {
        if self.stopping.is_some() {
            return cmd.refuse(ErrorCode::Internal, "hub stopping");
        }
        match cmd {
            Cmd::Open(o) => self.open(o).await,
            Cmd::Input { d, from } => self.input(d, &from),
            Cmd::Resize { cols, rows } => {
                // A nudge left the PTY at another size: apply even an unchanged size.
                let nudged = self.nudge_until.take().is_some();
                self.resize(winsize(cols, rows), nudged);
            }
            Cmd::Kill { forget, reply } => self.kill(forget, reply),
            Cmd::Detach { conn, reply } => {
                let detached = {
                    let mut viewers = lock(&self.viewers);
                    let before = viewers.len();
                    viewers.retain(|v| v.id != conn);
                    viewers.len() != before
                };
                if detached {
                    self.publish();
                }
                if let Some(reply) = reply {
                    reply.done();
                }
            }
            Cmd::Capture { lines, reply } => {
                let text = match &mut self.vt {
                    Some(vt) => vt.capture(lines),
                    None => self
                        .corpse_vt()
                        .await
                        .map(|mut vt| vt.capture(lines))
                        .unwrap_or_default(),
                };
                reply.ok(&CaptureReply { text });
            }
            Cmd::Shutdown { done } => self.shutdown(done),
        }
    }

    fn input(&mut self, d: String, from: &OutQ) {
        #[cfg(debug_assertions)]
        if self.ctx.test_panic_input.as_deref() == Some(d.as_str()) {
            panic!("WB_HUB_TEST_PANIC_INPUT received");
        }
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

    async fn open(&mut self, o: Open) {
        let Open {
            viewer,
            cols,
            rows,
            spawn,
            resume,
            reply,
        } = o;
        let size = winsize(cols, rows);
        match spawn {
            Some(spawn) if self.pid.is_none() || self.status.is_some() => {
                self.finish_exit();
                if self.phase != Phase::Running {
                    // The exit completed a `pty.kill{forget:true}`: the open belongs to
                    // the next incarnation.
                    self.rerouted = Some(Open {
                        viewer,
                        cols,
                        rows,
                        spawn: Some(spawn),
                        resume,
                        reply,
                    });
                    return;
                }
                self.spawn(viewer, size, spawn, reply).await;
            }
            _ if self.pid.is_some() => self.attach_live(viewer, size, resume, reply),
            _ => self.attach_corpse(viewer, size, reply).await,
        }
    }

    /// Attaches to a live session: the ring tail when `resume` still matches, else the
    /// snapshot. The requested size applies only to a sole viewer.
    fn attach_live(&mut self, viewer: Viewer, size: Winsize, resume: Option<Resume>, reply: Reply) {
        if lock(&self.viewers).iter().all(|v| v.id == viewer.id) {
            self.resize(size, false);
        }
        self.poll_fg();
        let tail = resume
            .filter(|r| r.stream == self.stream)
            .and_then(|r| self.ring.since(r.out));
        let resumed = tail.is_some();
        let replay = tail.unwrap_or_else(|| self.vt.as_mut().map(Vt::snapshot).unwrap_or_default());
        let nudge = !resumed && self.vt.as_ref().is_some_and(Vt::alternate_screen);
        reply.ok(&PtyOpenReply {
            new: false,
            pid: self.pid,
            cwd: self.rec.cwd.clone(),
            exit: None,
            epoch: self.created_at,
            stream: self.stream,
            out: self.ring.end(),
            resumed,
            replay: Some(replay),
        });
        let _ = viewer.outq.push_event(self.fg_line());
        self.attach(viewer);
        if nudge {
            self.nudge();
        }
    }

    /// Attaches to a dead session: its last snapshot at the requested size, and its exit.
    /// Nothing runs.
    async fn attach_corpse(&mut self, viewer: Viewer, size: Winsize, reply: Reply) {
        let replay = match self.corpse_vt().await {
            Some(mut vt) => {
                vt.resize(size.ws_col, size.ws_row);
                vt.snapshot()
            }
            None => String::new(),
        };
        reply.ok(&PtyOpenReply {
            new: false,
            pid: None,
            cwd: self.rec.cwd.clone(),
            exit: self.rec.exit.clone(),
            epoch: self.created_at,
            stream: self.stream,
            out: self.ring.end(),
            resumed: false,
            replay: Some(replay),
        });
        self.attach(viewer);
    }

    /// The screen of a dead session, from its snapshot.
    async fn corpse_vt(&self) -> Option<Vt> {
        let snap = self.store.load_snap().await?;
        Vt::from_snap(&snap)
            .inspect_err(|e| warn!("restoring the snapshot: {e:#}"))
            .ok()
    }

    /// Starts the child of a new session or a respawn. The shell is the one named in
    /// `spawn`, else the one the session last ran, else the default.
    async fn spawn(&mut self, viewer: Viewer, size: Winsize, spawn: SpawnPty, reply: Reply) {
        let ctx = self.ctx.clone();
        let name = spawn
            .shell
            .clone()
            .or_else(|| Some(self.rec.shell.clone()).filter(|s| !s.is_empty()))
            .unwrap_or_else(|| ctx.cfg.default_shell.clone());
        let Some((shell, path)) = ctx.cfg.shell(&name).and_then(|s| Some((s, s.resolve()?))) else {
            reply.err(ErrorCode::BadRequest, format!("shell {name} not available"));
            if ctx.registry.abandon(&self.sid, self.created_at) {
                self.phase = Phase::Abandoned;
            }
            return;
        };
        let mut argv = spawn.argv;
        argv[0] = path.to_owned();
        if argv.len() == 1 {
            argv.extend(shell.args.iter().cloned());
        }
        let cwd = self.spawn_cwd(spawn.cwd_from.as_deref(), spawn.cwd.as_deref());
        let env = env::pty_env(
            &ctx.cfg.child,
            path,
            &ctx.ident,
            &self.sid,
            spawn.env.as_ref(),
            |name| std::env::var_os(name),
        );
        // A respawn continues the screen the viewers already show.
        let mut vt = self
            .corpse_vt()
            .await
            .unwrap_or_else(|| Vt::new(size.ws_col, size.ws_row));
        vt.resize(size.ws_col, size.ws_row);
        let spawned = spawn::spawn(Path::new(path), &argv, &env, &cwd, size, ctx.child_umask)
            .and_then(|s| Ok((AsyncFd::new(s.master)?, s.child)));
        self.rec.shell = name;
        self.rec.argv = argv;
        self.rec.cwd = cwd;
        self.rec.env = spawn.env.unwrap_or_default();
        self.size = size;
        self.fault = None;
        let (master, child) = match spawned {
            Ok(spawned) => spawned,
            Err(e) => return self.spawn_failed(&e, reply),
        };
        let pid = child.id();
        info!(?pid, argv = ?self.rec.argv, cwd = %self.rec.cwd, "spawned");
        self.vt = Some(vt);
        self.pid = pid;
        self.master = Some(master);
        self.child = Some(child);
        // The stream continues, but a character the last child left unfinished does not.
        self.decoder = OutStream::new();
        self.eof = false;
        self.killing = false;
        self.fg = None;
        self.rec.exit = None;
        let now = Instant::now();
        self.poll_at = Some(now + FG_POLL);
        self.snapshot_at = Some(now + SNAPSHOT_EVERY);
        self.save(false);
        // `list` shows the new process before the opener hears of it. Nothing reaches the
        // viewer's queue before the `ok`: output is fanned out only by the loop.
        self.add_viewer(viewer);
        self.publish();
        reply.ok(&PtyOpenReply {
            new: true,
            pid,
            cwd: self.rec.cwd.clone(),
            exit: None,
            epoch: self.created_at,
            stream: self.stream,
            out: self.ring.end(),
            resumed: false,
            replay: None,
        });
    }

    /// The exec failed: the session stays as a corpse with `exit{reason:"spawn_failed"}`
    /// (H-20).
    fn spawn_failed(&mut self, e: &std::io::Error, reply: Reply) {
        let msg = format!("spawn failed: {e}");
        warn!(argv = ?self.rec.argv, "{msg}");
        let reason = ExitReason::SpawnFailed;
        self.rec.exit = Some(Exit {
            code: None,
            signal: None,
            reason,
            at: now_ms(),
        });
        let exit = line(&HubMessage::PtyExit {
            sid: self.sid.clone(),
            code: None,
            signal: None,
            reason,
        });
        self.fan_out(&exit);
        self.save(false);
        // `list` shows the corpse before the opener hears of the failure.
        self.publish();
        reply.err(ErrorCode::SpawnFailed, msg);
    }

    /// The cwd of a live `cwd_from`, then `cwd`, then `$HOME`; the first that is a
    /// directory.
    fn spawn_cwd(&self, cwd_from: Option<&str>, cwd: Option<&str>) -> String {
        let from = cwd_from
            .and_then(|sid| self.ctx.registry.live_pid(sid))
            .and_then(procfs::cwd);
        [from, cwd.map(str::to_owned)]
            .into_iter()
            .flatten()
            .find(|dir| Path::new(dir).is_dir())
            .unwrap_or_else(|| self.ctx.ident.home.clone())
    }

    fn attach(&mut self, viewer: Viewer) {
        if self.add_viewer(viewer) {
            self.publish();
        }
    }

    /// Adds `viewer` unless its connection is attached already; whether it was added.
    fn add_viewer(&self, viewer: Viewer) -> bool {
        let mut viewers = lock(&self.viewers);
        if viewers.iter().any(|v| v.id == viewer.id) {
            return false;
        }
        viewers.push(viewer);
        true
    }

    /// Makes `size` the desired size. `force` applies it to the PTY even when it is
    /// unchanged.
    fn resize(&mut self, size: Winsize, force: bool) {
        let changed = (size.ws_col, size.ws_row) != (self.size.ws_col, self.size.ws_row);
        if !changed && !force {
            return;
        }
        self.size = size;
        if let Some(master) = &self.master
            && let Err(e) = tcsetwinsize(master.get_ref(), size)
        {
            warn!("resizing the PTY: {e}");
        }
        if changed && let Some(vt) = &mut self.vt {
            vt.resize(size.ws_col, size.ws_row);
            self.dirty = true;
        }
    }

    /// Makes a full-screen app repaint: one row less now, the desired size after
    /// [`NUDGE`]. The VT state stays at the desired size throughout.
    fn nudge(&mut self) {
        let Some(master) = &self.master else { return };
        let mut short = self.size;
        short.ws_row = if short.ws_row > 1 {
            short.ws_row - 1
        } else {
            2
        };
        match tcsetwinsize(master.get_ref(), short) {
            Ok(()) => self.nudge_until = Some(Instant::now() + NUDGE),
            Err(e) => warn!("nudging the PTY: {e}"),
        }
    }

    fn nudge_end(&mut self) {
        self.nudge_until = None;
        if let Some(master) = &self.master
            && let Err(e) = tcsetwinsize(master.get_ref(), self.size)
        {
            warn!("resizing the PTY: {e}");
        }
    }

    fn kill(&mut self, forget: bool, reply: Reply) {
        self.finish_exit();
        if let Some(pid) = self.pid {
            if !self.killing {
                self.killing = true;
                kill_session(pid);
            }
            if forget {
                self.forgets.push(reply);
            } else {
                reply.done();
            }
        } else if forget {
            self.forgets.push(reply);
            self.phase = Phase::Forget;
        } else {
            reply.done();
        }
    }

    /// The hub is stopping: the snapshot as the user last saw it, then SIGHUP to the
    /// session. The shutdown sequence sends SIGKILL to what survives.
    fn shutdown(&mut self, done: oneshot::Sender<()>) {
        self.finish_exit();
        self.stopping = Some(done);
        if self.phase != Phase::Running {
            return;
        }
        match self.pid {
            Some(pid) => {
                self.save(true);
                procfs::signal_session(pid, Signal::HUP);
            }
            None => self.phase = Phase::Stopped,
        }
    }

    fn output(&mut self, d: String) {
        if let Some(vt) = &mut self.vt {
            vt.feed(&d);
            self.dirty = true;
        }
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
        let dropped = {
            let mut viewers = lock(&self.viewers);
            let before = viewers.len();
            viewers.retain(|v| v.outq.push_event(msg.clone()).is_ok());
            viewers.len() != before
        };
        if dropped {
            self.publish();
        }
    }

    /// Reads the foreground process group and the cwd; a change goes to the viewers and
    /// the watchers.
    fn poll_fg(&mut self) {
        let (Some(pid), Some(master), None) = (self.pid, &self.master, self.status) else {
            return;
        };
        let fg = tcgetpgrp(master.get_ref())
            .ok()
            .and_then(|pgid| u32::try_from(pgid.as_raw_nonzero().get()).ok())
            .map(|pgid| Fg {
                comm: procfs::comm(pgid).unwrap_or_default(),
                pgid,
                leader: pgid == pid,
            });
        let cwd = procfs::cwd(pid).unwrap_or_else(|| self.rec.cwd.clone());
        if fg == self.fg && cwd == self.rec.cwd {
            return;
        }
        self.fg = fg;
        self.rec.cwd = cwd;
        let msg = self.fg_line();
        self.fan_out(&msg);
        self.publish();
    }

    fn fg_line(&self) -> Arc<[u8]> {
        line(&HubMessage::PtyFg {
            sid: self.sid.clone(),
            comm: self.fg.as_ref().map(|f| f.comm.clone()).unwrap_or_default(),
            cwd: self.rec.cwd.clone(),
        })
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
                warn!("waiting for the child: {e}");
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
    /// writes the final record and snapshot, tells the viewers and the watchers, and
    /// answers what waited for the exit. A no-op unless the child has exited.
    fn finish_exit(&mut self) {
        let Some((code, signal)) = self.status.take() else {
            return;
        };
        if let Some(d) = self.decoder.flush() {
            self.output(d);
        }
        self.master = None;
        self.pid = None;
        self.fg = None;
        self.input.clear();
        self.drain_until = None;
        self.release_at = None;
        self.nudge_until = None;
        self.poll_at = None;
        self.snapshot_at = None;
        let reason = if self.stopping.is_some() {
            ExitReason::HubRestart
        } else if self.killing {
            ExitReason::Killed
        } else {
            ExitReason::Exited
        };
        self.killing = false;
        info!(?code, ?signal, ?reason, "exited");
        self.rec.exit = Some(Exit {
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
        // On a hub stop, the snapshot taken before the hangup stays.
        self.save(self.stopping.is_none());
        self.vt = None;
        self.publish();
        if !self.forgets.is_empty() {
            self.phase = Phase::Forget;
        } else if self.stopping.is_some() {
            self.phase = Phase::Stopped;
        }
    }

    /// Queues a write of the record and, with `snapshot`, of the screen.
    fn save(&mut self, snapshot: bool) {
        self.rec.cols = self.size.ws_col;
        self.rec.rows = self.size.ws_row;
        let snap = self.vt.as_mut().filter(|_| snapshot).map(Vt::to_snap);
        if snap.is_some() {
            self.dirty = false;
        }
        self.store.write(&self.rec, snap);
    }

    fn publish(&mut self) {
        self.updated_at = now_ms().max(self.updated_at);
        let viewers = lock(&self.viewers).len();
        self.ctx.registry.publish(&Summary {
            sid: self.sid.clone(),
            kind: Kind::Pty,
            host: self.ctx.cfg.host.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            alive: self.pid.is_some(),
            viewers: u32::try_from(viewers).unwrap_or(u32::MAX),
            cwd: self.rec.cwd.clone(),
            fault: self.fault.clone().map(|message| Fault {
                code: FaultCode::LoadFailed,
                message,
            }),
            pty: Some(PtyFacts {
                argv: self.rec.argv.clone(),
                pid: self.pid,
                fg: self.fg.clone(),
                exit: self.rec.exit.clone(),
            }),
            acp: None,
        });
    }
}

/// Delivers a command that reached a forgotten actor to whatever now holds `sid`: an
/// open is routed as a new request, anything else goes to the current session, if any.
async fn redeliver(ctx: &Arc<Ctx>, sid: &str, cmd: Cmd) {
    const FORGOTTEN: &str = "the session was forgotten";
    match cmd {
        Cmd::Open(o) => open(ctx.clone(), sid.to_owned(), o).await,
        cmd => match ctx.registry.sender(sid) {
            Some(tx) => {
                if let Err(unsent) = tx.send(cmd).await {
                    unsent.0.refuse(ErrorCode::NotFound, FORGOTTEN);
                }
            }
            None => cmd.refuse(ErrorCode::NotFound, FORGOTTEN),
        },
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
