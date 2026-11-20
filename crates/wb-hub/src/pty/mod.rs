//! PTY sessions: one actor task per sid owns the child, the master, the VT state, the
//! ring and the files. Every change to a session happens in its actor, so a reply and
//! the output around it are always ordered. A supervisor task per sid reloads the
//! session from disk when its actor panics.

mod io;
mod out;
pub mod spawn;
mod vt;

use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::pin::Pin;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rustix::process::{Pid, PidfdFlags, WaitId, WaitIdOptions, WaitIdStatus, pidfd_open, waitid};
use rustix::termios::{Winsize, tcgetpgrp, tcsetwinsize};
use tokio::io::unix::AsyncFd;
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
use crate::snapshot::fit_summary;
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
        epoch: Option<u64>,
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
    pub fn refuse(self, code: ErrorCode, message: impl Into<String>) {
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
            match ctx.registry.route(&sid, open.spawn.is_some()).await {
                Ok(Route::Send(tx)) => {
                    if let Ok(permit) = tx.reserve().await {
                        return permit.send(Cmd::Open(open));
                    }
                }
                Ok(Route::Created { created_at, rx }) => {
                    return start(ctx.clone(), sid, created_at, rx, Start::Open(open));
                }
                Ok(Route::NotFound) => {
                    return open
                        .reply
                        .err(ErrorCode::NotFound, format!("no session {sid}"));
                }
                Ok(Route::Stopping) => return open.reply.err(ErrorCode::Internal, "hub stopping"),
                Err(e) => {
                    return open
                        .reply
                        .err(ErrorCode::Internal, format!("reserving epoch: {e}"));
                }
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
        let next = match tokio::spawn(actor).await {
            Err(e) if e.is_panic() => {
                error!(%sid, "the session actor panicked: {e}");
                // The panic dropped the actor's queue. Commands sent during the reload
                // wait in a new one for the reloaded actor.
                ctx.registry.reopen(&sid, created_at)
            }
            _ => {
                let _ = writes.await;
                return;
            }
        };
        // Every write the actor queued lands before the session is read back.
        let _ = writes.await;
        let dropped = std::mem::take(&mut *lock(&viewers));
        let Some(next) = next else {
            return tell_reloaded(&sid, dropped);
        };
        let from = match store::load_or_quarantine(ctx.pty_dir.clone(), sid.clone()).await {
            Ok(Some(rec)) => Start::Loaded(rec),
            Ok(None) => {
                ctx.registry.forget(&sid, created_at, &[]);
                tell_reloaded(&sid, dropped);
                // What queued during the reload goes wherever the sid leads now.
                let mut rx = next;
                rx.close();
                while let Some(cmd) = rx.recv().await {
                    redeliver(&ctx, &sid, cmd).await;
                }
                return;
            }
            Err(fault) => Start::Faulted(fault),
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

/// The hub, not the actor or its sleep task, owns targets until KILL is delivered.
pub struct Escalations(Mutex<Option<HashMap<tokio::task::Id, procfs::SessionMembers>>>);

impl Default for Escalations {
    fn default() -> Self {
        Self(Mutex::new(Some(HashMap::new())))
    }
}

impl Escalations {
    fn arm(self: &Arc<Self>, members: procfs::SessionMembers, grace: Duration) {
        let mut pending = lock(&self.0);
        let Some(sets) = pending.as_mut() else {
            return members.kill();
        };
        let owner = Arc::downgrade(self);
        let deadline = Instant::now() + grace;
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let Some(owner) = owner.upgrade() else { return };
            let mut pending = lock(&owner.0);
            if let Some(members) = pending.as_mut().and_then(|s| s.remove(&tokio::task::id())) {
                members.kill();
            }
        });
        sets.insert(timer.id(), members);
    }

    pub fn finish(&self) {
        // Serialize delivery itself with the timers, not just removal from the map.
        let mut pending = lock(&self.0);
        if let Some(sets) = pending.take() {
            for members in sets.into_values() {
                members.kill();
            }
        }
    }
}

impl Drop for Escalations {
    fn drop(&mut self) {
        self.finish();
    }
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

enum Cleanup {
    Unarmed,
    /// Never rescan. A captured but unsignalled leader may already have a pending KILL.
    LeaderOwed(std::sync::Weak<procfs::Member>),
    Armed,
}

enum Event {
    Cmd(Option<Cmd>),
    Read(std::io::Result<usize>),
    Wrote(std::io::Result<usize>),
    Exited(std::io::Result<WaitNotice>),
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
    /// Cleared immediately on ECHILD, even if the PTY is still draining.
    pid: Option<u32>,
    master: Option<Master>,
    /// Normally unreaped through the output drain and final save.
    child: Option<Child>,
    exit_watch: Option<ExitWatch>,
    /// Only the reaping wait fallback needs a pre-reap snapshot for panic cleanup.
    reaped_cleanup: Option<procfs::SessionMembers>,
    /// The master reported end of output.
    eof: bool,
    /// Code and signal of an exited child whose remaining output is being drained.
    status: Option<(Option<i32>, Option<i32>)>,
    fg: Option<Fg>,
    killing: bool,
    cleanup: Cleanup,
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
            exit_watch: None,
            reaped_cleanup: None,
            eof: false,
            status: None,
            fg: None,
            killing: false,
            cleanup: Cleanup::Unarmed,
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
            Start::Faulted(reason) => {
                // A corpse like any other: its attach carries the exit, so a client can
                // offer the respawn that clears the fault.
                self.fault = Some(reason);
                self.rec.exit = Some(Exit {
                    code: None,
                    signal: None,
                    reason: ExitReason::HubRestart,
                    at: now_ms(),
                });
            }
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
                    st = wait(self.exit_watch.as_mut()) => Event::Exited(st),
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
            Cmd::Kill { forget, reply, .. } => self.kill(forget, reply),
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
            _ if self.master.is_some() => self.attach_live(viewer, size, resume, reply),
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
        let spawned = spawn::spawn(Path::new(path), &argv, &env, &cwd, size, ctx.child_umask);
        self.rec.shell = name;
        self.rec.argv = argv;
        self.rec.cwd = cwd;
        self.rec.env = spawn.env.unwrap_or_default();
        self.size = size;
        self.fault = None;
        let spawned = match spawned {
            Ok(spawned) => spawned,
            Err(e) => return self.spawn_failed(&e, reply),
        };
        let pid = spawned.child.id();
        self.child = Some(spawned.child);
        self.cleanup = Cleanup::Unarmed;
        let (master, exit_watch) =
            match AsyncFd::new(spawned.master).and_then(|m| Ok((m, ExitWatch::new(pid)?))) {
                Ok(fds) => fds,
                Err(e) => {
                    self.teardown(KILL_AFTER);
                    self.reap_owned();
                    return self.spawn_failed(&e, reply);
                }
            };
        info!(pid, argv = ?self.rec.argv, cwd = %self.rec.cwd, "spawned");
        self.vt = Some(vt);
        self.pid = Some(pid);
        self.master = Some(master);
        self.exit_watch = Some(exit_watch);
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
            pid: Some(pid),
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

    fn hangup(&mut self, grace: Duration) -> std::io::Result<()> {
        self.hangup_from(Path::new("/proc"), grace)
    }

    fn hangup_from(&mut self, proc_root: &Path, grace: Duration) -> std::io::Result<()> {
        let Some(child) = &self.child else {
            return Ok(()); // Already reaped; its numeric identity is no longer ours.
        };
        let pid = child.id();
        if peek_exit(pid).is_err_and(|e| is_echild(&e)) {
            self.lost_child();
            return Ok(());
        }
        let mut members = match &self.cleanup {
            Cleanup::Unarmed => procfs::session_members(proc_root, pid, &self.sid),
            Cleanup::LeaderOwed(pending) => {
                if let Some(leader) = pending.upgrade() {
                    let hup = leader.signal(&self.sid, rustix::process::Signal::HUP);
                    return self.check_hup(pid, hup);
                }
                match procfs::SessionMembers::leader_only(pid, &self.sid) {
                    Ok(members) => members,
                    Err(e) => return self.check_hup(pid, Err(e)),
                }
            }
            Cleanup::Armed => return Ok(()),
        };
        let hup = self.check_hup(pid, members.hangup());
        if hup.is_err() {
            self.cleanup = Cleanup::LeaderOwed(members.track_leader());
        }
        if self.child.is_some() {
            self.ctx.escalations.arm(members, grace);
        }
        hup
    }

    fn check_hup(&mut self, pid: u32, hup: std::io::Result<()>) -> std::io::Result<()> {
        // Do not mistake a missing handle for an exited leader, or reap it to check.
        if let Err(e) = hup {
            match peek_exit(pid) {
                Ok(Some(_)) => {}
                Err(wait) if is_echild(&wait) => self.lost_child(),
                _ => {
                    warn!(sid = %self.sid, "could not hang up PTY leader {pid}: {e}");
                    return Err(e);
                }
            }
        }
        self.cleanup = Cleanup::Armed;
        Ok(())
    }

    fn teardown(&mut self, grace: Duration) {
        if matches!(self.cleanup, Cleanup::Unarmed) {
            let _ = self.hangup(grace);
        }
        // This can be the last chance to open a handle through the owned Child,
        // even if teardown itself was the first to discover an incomplete capture.
        if matches!(self.cleanup, Cleanup::LeaderOwed(_)) {
            let _ = self.hangup(grace);
        }
    }

    fn kill(&mut self, forget: bool, reply: Reply) {
        self.finish_exit();
        if self.pid.is_some() {
            if !self.killing {
                if let Err(e) = self.hangup(KILL_AFTER) {
                    return reply.err(ErrorCode::Internal, format!("hanging up PTY leader: {e}"));
                }
                self.killing = true;
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
            Some(_) => {
                self.save(true);
                self.teardown(crate::shutdown::HANGUP_WAIT);
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

    fn exited(&mut self, st: std::io::Result<WaitNotice>) {
        let status = match st {
            Ok(WaitNotice::Exited(code, signal)) => (code, signal),
            Ok(WaitNotice::ProbeChild) => {
                let child = self.child.as_mut().expect("waiting for an owned child");
                let pid = child.id();
                // try_wait can release the pid. Keep handles for Drop if the
                // actor unwinds while draining or recording this exit.
                let members = if matches!(self.cleanup, Cleanup::Unarmed) {
                    match peek_exit(pid) {
                        Ok(None) => return, // Still live; no need to scan or reap.
                        Err(e) if is_echild(&e) => return self.lost_child(),
                        _ => Some(procfs::session_members(Path::new("/proc"), pid, &self.sid)),
                    }
                } else {
                    None
                };
                match child.try_wait() {
                    Ok(None) => return,
                    Ok(Some(status)) => {
                        self.reaped_cleanup = members;
                        self.child = None;
                        (status.code(), status.signal())
                    }
                    Err(e) if is_echild(&e) => return self.lost_child(),
                    Err(e) => {
                        warn!(sid = %self.sid, "waiting for owned PTY child: {e}");
                        self.exit_watch.as_mut().unwrap().retry_child();
                        return;
                    }
                }
            }
            Err(e) if is_echild(&e) => return self.lost_child(),
            Err(e) => {
                warn!(sid = %self.sid, "observing PTY exit: {e}; switching to child wait");
                self.exit_watch.as_mut().unwrap().use_child_wait();
                return;
            }
        };
        self.exit_watch = None;
        self.status = Some(status);
        if self.eof {
            self.finish_exit();
        } else {
            self.drain_until = Some(Instant::now() + DRAIN);
        }
    }

    /// Neither the wait status nor the numeric process/session id is ours anymore.
    fn lost_child(&mut self) {
        self.child = None;
        self.exit_watch = None;
        if self.pid.take().is_some() {
            self.fg = None;
            self.status = Some((None, None));
            // A kill/shutdown command may itself have discovered ECHILD. Finish
            // after the command has installed its pending replies, even at EOF.
            let now = Instant::now();
            self.drain_until = Some(if self.eof { now } else { now + DRAIN });
            self.publish(); // In particular, cwd_from must not follow the old pid.
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
        // No more exit handling can panic after the kernel releases this leader's id.
        self.reap_owned();
        self.reaped_cleanup = None;
    }

    fn reap_owned(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        match child.try_wait() {
            Ok(Some(_)) => return,
            Err(e) if is_echild(&e) => return,
            Err(e) => warn!(sid = %self.sid, "reaping PTY leader: {e}"),
            Ok(None) => {}
        }
        // A cancelled actor (or failed master setup) can leave a still-live
        // child. Don't block its Drop, or tie runtime shutdown to HUP delivery.
        if let Err(e) = std::thread::Builder::new().spawn(move || {
            if let Err(e) = child.wait() {
                warn!("reaping abandoned PTY leader: {e}");
            }
        }) {
            warn!(sid = %self.sid, "starting PTY leader reaper: {e}");
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

    /// Uses the same wire projection for live state and restored records.
    fn publish(&mut self) {
        self.updated_at = now_ms().max(self.updated_at);
        let viewers = lock(&self.viewers).len();
        let mut summary = Summary {
            sid: self.sid.clone(),
            kind: Kind::Pty,
            host: self.ctx.cfg.host.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            alive: self.master.is_some(),
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
        };
        fit_summary(&mut summary);
        self.ctx.registry.publish(Arc::new(summary));
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if let Some(members) = self.reaped_cleanup.take() {
            let _ = members.hangup();
            self.ctx.escalations.arm(members, KILL_AFTER);
        }
        self.teardown(KILL_AFTER);
        self.reap_owned();
    }
}

/// Route an open as a new request; other commands keep their original epoch guard.
async fn redeliver(ctx: &Arc<Ctx>, sid: &str, cmd: Cmd) {
    match cmd {
        Cmd::Open(o) => open(ctx.clone(), sid.to_owned(), o).await,
        cmd => ctx.registry.redeliver(sid, cmd).await,
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

fn exit_fd(pid: u32) -> std::io::Result<AsyncFd<OwnedFd>> {
    let pid = Pid::from_raw(pid as i32).expect("positive child pid");
    AsyncFd::new(pidfd_open(pid, PidfdFlags::empty())?)
}

/// Peek, never reap: the actor may still need the leader's kernel session id
/// for panic cleanup during the output drain or final save.
fn peek_exit(pid: u32) -> std::io::Result<Option<WaitIdStatus>> {
    let pid = Pid::from_raw(pid as i32).expect("positive child pid");
    let opts = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
    Ok(rustix::io::retry_on_intr(|| {
        waitid(WaitId::Pid(pid), opts)
    })?)
}

fn is_echild(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(rustix::io::Errno::CHILD.raw_os_error())
}

enum WaitNotice {
    Exited(Option<i32>, Option<i32>),
    ProbeChild,
}

enum ExitWake {
    Fd(AsyncFd<OwnedFd>),
    Sigchld(tokio::signal::unix::Signal, bool),
    Child {
        sigchld: Option<tokio::signal::unix::Signal>,
        probe_at: Option<Instant>,
    },
}

struct ExitWatch {
    pid: u32,
    wake: ExitWake,
}

impl ExitWatch {
    fn new(pid: u32) -> std::io::Result<Self> {
        let wake = match exit_fd(pid) {
            Ok(fd) => ExitWake::Fd(fd),
            // As with Tokio's Child, pidfd_open is not required for an ordinary
            // spawn. Check once *after* subscribing so an early exit isn't lost.
            Err(_) => ExitWake::Sigchld(
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?,
                true,
            ),
        };
        Ok(Self { pid, wake })
    }

    fn use_child_wait(&mut self) {
        self.wake = ExitWake::Child {
            sigchld: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).ok(),
            probe_at: Some(Instant::now()),
        };
    }

    fn retry_child(&mut self) {
        if let ExitWake::Child { probe_at, .. } = &mut self.wake {
            *probe_at = Some(Instant::now() + Duration::from_secs(1));
        }
    }
}

async fn wait(watch: Option<&mut ExitWatch>) -> std::io::Result<WaitNotice> {
    let Some(ExitWatch { pid, wake }) = watch else {
        return std::future::pending().await;
    };
    let status = match wake {
        ExitWake::Fd(fd) => {
            fd.async_io(tokio::io::Interest::READABLE, |_| {
                peek_exit(*pid)?.ok_or(std::io::ErrorKind::WouldBlock.into())
            })
            .await?
        }
        ExitWake::Sigchld(signal, check) => loop {
            if std::mem::take(check)
                && let Some(status) = peek_exit(*pid)?
            {
                break status;
            }
            signal
                .recv()
                .await
                .ok_or_else(|| std::io::Error::other("SIGCHLD stream closed"))?;
            *check = true;
        },
        ExitWake::Child { sigchld, probe_at } => {
            if let Some(at) = *probe_at {
                tokio::time::sleep_until(at).await;
            } else if let Some(signal) = sigchld
                && signal.recv().await.is_none()
            {
                *sigchld = None;
            }
            *probe_at = sigchld
                .is_none()
                .then(|| Instant::now() + Duration::from_secs(1));
            return Ok(WaitNotice::ProbeChild);
        }
    };
    Ok(WaitNotice::Exited(
        status.exit_status(),
        status.terminating_signal(),
    ))
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

    use rustix::process::{Signal, pidfd_send_signal};

    async fn session_with_straggler(ctx: &Arc<Ctx>) -> (Pty, JoinHandle<()>, AsyncFd<OwnedFd>) {
        // The shell exits on HUP; its child installs SIG_IGN before publishing its pid.
        let script = r#"trap 'exit 42' HUP; sh -c 'trap "" HUP; echo $$; exec sleep 60 </dev/null >/dev/null 2>&1' & wait"#;
        let (actor, writes) = test_session(ctx, script);
        let pid = read_test_pid(&actor).await;
        (actor, writes, exit_fd(pid).unwrap())
    }

    fn test_session(ctx: &Arc<Ctx>, script: &str) -> (Pty, JoinHandle<()>) {
        let (mut actor, writes) = Pty::new(ctx.clone(), "job".into(), 17, Viewers::default());
        let spawned = spawn::spawn(
            Path::new("sh"),
            &["sh".into(), "-c".into(), script.into()],
            &[("PATH".into(), std::env::var_os("PATH").unwrap())],
            ctx.cfg.state_dir.to_str().unwrap(),
            actor.size,
            ctx.child_umask,
        )
        .unwrap();
        actor.pid = Some(spawned.child.id());
        actor.exit_watch = Some(ExitWatch::new(actor.pid.unwrap()).unwrap());
        actor.child = Some(spawned.child);
        actor.master = Some(AsyncFd::new(spawned.master).unwrap());
        (actor, writes)
    }

    async fn read_test_pid(actor: &Pty) -> u32 {
        let mut line = Vec::new();
        while !line.contains(&b'\n') {
            let mut buf = [0; 32];
            let n = io::read(actor.master.as_ref(), &mut buf).await.unwrap();
            assert_ne!(n, 0);
            line.extend_from_slice(&buf[..n]);
        }
        std::str::from_utf8(&line).unwrap().trim().parse().unwrap()
    }

    #[tokio::test]
    async fn wait_error_on_live_child_does_not_acknowledge_a_noop_kill() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Arc::new(Ctx::for_test(dir.path()));
        let (mut actor, _writes, descendant) = session_with_straggler(&ctx).await;
        let leader = exit_fd(actor.pid.unwrap()).unwrap();
        actor.exited(Err(std::io::Error::other("injected waitid failure")));
        assert!(actor.status.is_none(), "wait error fabricated an exit");
        let st = wait(actor.exit_watch.as_mut()).await;
        actor.exited(st); // The fallback probes a still-live child.
        actor.kill(false, Reply::for_test(1, Arc::default()));
        if !actor.killing {
            let _ = pidfd_send_signal(leader.get_ref(), Signal::KILL);
            let _ = pidfd_send_signal(descendant.get_ref(), Signal::KILL);
            panic!("kill treated a child with a failed wait as already dead");
        }
        // Hold the captured handles outside the timer's map before yielding.
        // Only HUP can cause the exit observed by this wait.
        let gated = Escalations(Mutex::new(lock(&ctx.escalations.0).take()));
        tokio::time::timeout(Duration::from_secs(30), async {
            while actor.status.is_none() {
                let st = wait(actor.exit_watch.as_mut()).await;
                actor.exited(st);
            }
        })
        .await
        .expect("fallback did not observe the leader's exit after HUP");
        assert_eq!(actor.status, Some((Some(42), None)));
        gated.finish();
        assert_killed(descendant).await;
    }

    fn runtime(paused: bool) -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .start_paused(paused)
            .build()
            .unwrap()
    }

    #[test]
    fn dropping_runtime_flushes_pending_kills_without_shutdown() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime(false);
        let descendant = rt.block_on(async {
            let ctx = Arc::new(Ctx::for_test(dir.path()));
            let (mut actor, _writes, child) = session_with_straggler(&ctx).await;
            actor.hangup(Duration::from_secs(3600)).unwrap();
            // Make runtime teardown itself cancel the last owner, not this scope.
            tokio::spawn(async move {
                std::future::pending::<()>().await;
                drop(actor);
            });
            child.into_inner()
        });
        // No shutdown sequence, no opportunity for the ordinary timer to fire.
        drop(rt);
        runtime(false).block_on(async { assert_killed(AsyncFd::new(descendant).unwrap()).await });
    }

    async fn assert_killed(child: AsyncFd<OwnedFd>) {
        let died = tokio::time::timeout(Duration::from_secs(30), child.readable()).await;
        if died.is_err() {
            pidfd_send_signal(child.get_ref(), Signal::KILL).unwrap();
            panic!("shutdown returned without killing the captured descendant");
        }
        drop(died.unwrap().unwrap());
    }

    #[test]
    fn shutdown_kills_captured_descendant_after_leader_acknowledges() {
        let dir = tempfile::tempdir().unwrap();
        let rt = runtime(true);
        let (_ctx, descendant) = rt.block_on(async {
            let ctx = Arc::new(Ctx::for_test(dir.path()));
            let mut rx = ctx.registry.restore("job", 17);
            let (mut actor, writes, descendant) = session_with_straggler(&ctx).await;
            // A blocking task inhibits Tokio's auto-advance: neither the ordinary
            // escalation nor shutdown's shared five-second deadline can fire.
            let (hold, gate) = oneshot::channel::<()>();
            let _gate = tokio::task::spawn_blocking(move || gate.blocking_recv());
            let acknowledge = async {
                let Some(Cmd::Shutdown { done }) = rx.recv().await else {
                    panic!("expected shutdown");
                };
                let (report, ack) = oneshot::channel();
                actor.shutdown(report);
                tokio::spawn(supervise(actor, writes, rx, None));
                ack.await
                    .expect("actor must acknowledge, not drop its sender");
                done.send(())
                    .expect("hub must still be waiting for the ack");
            };
            tokio::join!(crate::shutdown::run(&ctx), acknowledge);
            drop(hold);
            (ctx, descendant.into_inner())
        });
        // Keep the hub and its dormant runtime alive: neither a timer nor the
        // drop guard can satisfy this check. Only process exit has a watchdog.
        runtime(false).block_on(async { assert_killed(AsyncFd::new(descendant).unwrap()).await });
    }

    #[tokio::test]
    async fn drop_during_exit_drain_arms_cleanup_even_if_shutdown_started() {
        for reaping_fallback in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let ctx = Arc::new(Ctx::for_test(dir.path()));
            let (mut actor, _writes, descendant) = session_with_straggler(&ctx).await;
            let leader = exit_fd(actor.pid.unwrap()).unwrap();
            if reaping_fallback {
                actor.exited(Err(std::io::Error::other("injected waitid failure")));
            }
            pidfd_send_signal(leader.get_ref(), Signal::HUP).unwrap();
            while actor.status.is_none() {
                let st = wait(actor.exit_watch.as_mut()).await;
                actor.exited(st);
            }
            actor.stopping = Some(oneshot::channel().0);
            drop(actor); // Unwind before any explicit hangup was armed.
            crate::shutdown::run(&ctx).await; // No registered actor remains.
            assert_killed(descendant).await;
        }
    }

    #[tokio::test]
    async fn kill_does_not_acknowledge_a_missed_live_leader() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Arc::new(Ctx::for_test(dir.path()));
        let (mut actor, _writes) = Pty::new(ctx, "job".into(), 17, Viewers::default());
        // Not a session leader: no process in /proc can have this live child's
        // pid as its kernel session id. Capture misses it without signalling anyone.
        let child = std::process::Command::new("sh")
            .args(["-c", "read line"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        actor.pid = Some(child.id());
        actor.child = Some(child);
        let outq = Arc::new(OutQ::default());
        actor.kill(true, Reply::for_test(1, outq.clone()));
        outq.finish();
        let crate::outq::WriteItem::Lines(reply) =
            outq.pop_write(|_| unreachable!()).await.unwrap().unwrap()
        else {
            panic!("expected a kill reply");
        };
        assert!(matches!(
            serde_json::from_slice::<HubMessage>(&reply.line).unwrap(),
            HubMessage::Err {
                code: ErrorCode::Internal,
                ..
            }
        ));
        // wait closes stdin, letting our unsignalled child finish the read.
        actor.child.take().unwrap().wait().unwrap();
    }

    enum AfterMiss {
        Retry,
        Shutdown,
        Drop,
    }

    async fn exercise_partial_capture(after: AfterMiss) {
        use std::io::Write;
        use std::os::unix::fs::symlink;

        struct TestChild(AsyncFd<OwnedFd>);
        impl Drop for TestChild {
            fn drop(&mut self) {
                let _ = pidfd_send_signal(self.0.get_ref(), Signal::KILL);
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let ctx = Arc::new(Ctx::for_test(dir.path()));
        let gate = dir.path().join("gate");
        rustix::fs::mkfifoat(rustix::fs::CWD, &gate, rustix::fs::Mode::RWXU).unwrap();
        let mut gate = std::fs::File::options()
            .read(true)
            .write(true)
            .open(gate)
            .unwrap();
        let (mut actor, _writes) = test_session(
            &ctx,
            "trap '' HUP; sleep 60 & echo $!; read fork < gate; \
             (read finish < gate && : > late-survived) & echo $!; wait; : > leader-survived",
        );
        let leader = TestChild(exit_fd(actor.pid.unwrap()).unwrap());
        let pid = read_test_pid(&actor).await;
        let old = TestChild(exit_fd(pid).unwrap());
        // A real captured descendant, but a proc view that missed the live leader.
        let proc = tempfile::tempdir().unwrap();
        symlink(format!("/proc/{pid}"), proc.path().join(pid.to_string())).unwrap();
        actor.hangup_from(proc.path(), KILL_AFTER).unwrap_err();
        writeln!(gate, "fork").unwrap();
        let late = TestChild(exit_fd(read_test_pid(&actor).await).unwrap());

        match after {
            AfterMiss::Retry => {
                actor.kill(false, Reply::for_test(1, Arc::new(OutQ::default())));
                assert!(actor.killing, "retry did not deliver the leader's HUP");
            }
            AfterMiss::Shutdown => actor.shutdown(oneshot::channel().0),
            AfterMiss::Drop => drop(actor),
        }
        ctx.escalations.finish();
        writeln!(gate, "finish").unwrap();
        for child in [&old, &late, &leader] {
            drop(
                tokio::time::timeout(Duration::from_secs(30), child.0.readable())
                    .await
                    .expect("test child still alive after escalation")
                    .unwrap(),
            );
        }
        assert!(
            !dir.path().join("leader-survived").exists(),
            "leader escaped KILL"
        );
        assert!(
            dir.path().join("late-survived").exists(),
            "post-capture child was signalled"
        );
    }

    #[tokio::test]
    async fn partial_capture_retries_only_the_leader() {
        exercise_partial_capture(AfterMiss::Retry).await;
    }

    #[tokio::test]
    async fn partial_capture_shutdown_still_targets_the_leader() {
        exercise_partial_capture(AfterMiss::Shutdown).await;
    }

    #[tokio::test]
    async fn partial_capture_drop_still_targets_the_leader() {
        exercise_partial_capture(AfterMiss::Drop).await;
    }

    #[tokio::test(start_paused = true)]
    async fn escalation_does_not_follow_a_reused_session_id() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::fs::symlink;
        use std::process::{Command, Stdio};

        // Only our children appear in this proc view. All report the same kernel
        // session id; swapping the entries models its reassignment during the grace.
        let proc = tempfile::tempdir().unwrap();
        let spawn = |hup: &str| {
            let mut child = Command::new("sh")
                .args([
                    "-c",
                    &format!("trap '{hup}' HUP; echo ready; read line || :"),
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let mut ready = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut ready)
                .unwrap();
            assert_eq!(ready, "ready\n");
            child
        };
        let expose = |pid: u32| {
            let entry = proc.path().join(pid.to_string());
            symlink(format!("/proc/{pid}"), &entry).unwrap();
            entry
        };
        let mut leader = spawn("exit 42");
        let mut straggler = spawn("");
        let mut replacement = spawn("");
        let leader_entry = expose(leader.id());
        let old_member = expose(straggler.id());
        let stat = std::fs::read_to_string(leader_entry.join("stat")).unwrap();
        let sid = stat
            .split_ascii_whitespace()
            .nth(5)
            .unwrap()
            .parse()
            .unwrap();
        let escalations = Arc::new(Escalations::default());
        let members = procfs::session_members(proc.path(), sid, "test");
        // This synthetic proc view only contains our children, not their session leader.
        let _ = members.hangup();
        escalations.arm(members, KILL_AFTER);

        assert_eq!(leader.wait().unwrap().code(), Some(42));
        std::fs::remove_file(leader_entry).unwrap();
        std::fs::remove_file(&old_member).unwrap();
        // The straggler still lives, but its numeric slot now resolves to a
        // different process. No slot names a reaped pid at escalation time.
        symlink(format!("/proc/{}", replacement.id()), old_member).unwrap();
        expose(replacement.id());
        tokio::time::sleep(KILL_AFTER + Duration::from_millis(1)).await;
        let old = straggler.wait().unwrap();
        let new = replacement.wait().unwrap();
        assert_eq!((old.signal(), new.code()), (Some(9), Some(0)));
    }

    async fn externally_reaped_child(fallback: Option<Cleanup>) {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Arc::new(Ctx::for_test(dir.path()));
        let _rx = ctx.registry.restore::<Cmd>("job", 17);
        let (mut actor, writes) = test_session(&ctx, "exit 7");
        actor.publish();
        assert_eq!(ctx.registry.live_pid("job"), actor.pid);
        let pid = Pid::from_raw(actor.pid.unwrap() as i32).unwrap();
        // Reap only the process this test spawned, bypassing Child's status cache.
        rustix::io::retry_on_intr(|| waitid(WaitId::Pid(pid), WaitIdOptions::EXITED)).unwrap();
        if let Some(cleanup) = fallback {
            actor.cleanup = cleanup;
            actor.exit_watch.as_mut().unwrap().use_child_wait();
        }
        let notice = wait(actor.exit_watch.as_mut()).await;
        actor.exited(notice);

        // Take the stale handle before asserting so even a failing test cannot
        // make the actor scan or signal by the released pid during unwinding.
        let retained = actor.child.take();
        assert_eq!(actor.status, Some((None, None)));
        assert!(retained.is_none());
        assert!(actor.pid.is_none());
        assert!(ctx.registry.live_pid("job").is_none());
        assert!(actor.exit_watch.is_none());
        assert!(actor.reaped_cleanup.is_none());
        actor.finish_exit();
        let exit = actor.rec.exit.as_ref().unwrap();
        assert_eq!((exit.code, exit.signal), (None, None));
        drop(actor);
        writes.await.unwrap();
    }

    #[tokio::test]
    async fn waitid_echild_confirms_exit_without_cleanup_targets() {
        externally_reaped_child(None).await;
    }

    #[tokio::test]
    async fn try_wait_echild_confirms_exit_without_cleanup_targets() {
        // Before capturing a new snapshot, and in try_wait itself when an
        // earlier kill has already armed cleanup.
        externally_reaped_child(Some(Cleanup::Unarmed)).await;
        externally_reaped_child(Some(Cleanup::Armed)).await;
    }

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
