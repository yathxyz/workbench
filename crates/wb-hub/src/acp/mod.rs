//! ACP sessions (DESIGN §3.4.4-§3.4.5, 10-hub §7): one actor task per sid owns the
//! agent process, the journal, the fold over it and the attached connections. Every
//! state change goes through [`Acp::record`]: append to the journal, then fold, fan out
//! and publish, so the live facts are always the fold of what is on disk (H-9). A
//! supervisor task per sid reloads the session from disk when its actor panics.

mod agent;
mod config;
mod facts;
mod journal;
mod lines;
mod replay;
mod rpc;
mod worktree;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use rustix::process::Signal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{JoinError, JoinSet};
use tokio::time::Instant;
use tracing::{Instrument, error, info, info_span, warn};
use wb_proto::hub::{
    AcpFacts, AcpOpenReply, AcpSessionInfo, Activity, ConfigError, ConfigOption, ErrorCode,
    ExitReason, Fault, FaultCode, HubMessage, Kind, ManagedWorktree, PendingKind, SpawnAcp,
    Summary,
};
use wb_proto::journal::{
    EventBody, JournalEvent, NoticeLevel, ResolvedBy, SessionVia, SetupErrorCode, SpawnVia,
    TurnErrorCode,
};
use wb_proto::limits::{
    ACP_CONFIG_MAX, ACP_REPLAY_MAX, CONN_QUEUE, PROMPT_MAX, SETUP_IDLE_TIMEOUT,
};
use wb_proto::policy::{CompiledPolicy, Policy, PolicyMatch};

pub(crate) use self::agent::Group;
use self::agent::{Agent, Out};
use self::facts::Facts;
use self::journal::{Journal, SyncGate, WriteFault};
use self::replay::Replay;
use self::rpc::Incoming;
use self::worktree::CreateFailure::{self, Clean, PossibleLeftover};
use crate::child::{self, WaitNotice};
use crate::conn::{ConnId, Reply, Viewer, line};
use crate::outq::OutQ;
use crate::registry::Route;
use crate::snapshot::fit_summary;
use crate::store::write_atomic;
use crate::{Ctx, lock, now_ms};

/// Longest `cwd` of a spawn on another host, in bytes.
const REMOTE_CWD_MAX: usize = 4096;

const INVALID_POLICY_NOTICE: &str = "stored permission policy is no longer valid and was cleared during replay; requests ask unless a later valid policy is set";

/// How long `session/set_mode` may take.
const SET_MODE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long `session/set_config_option` may take.
const SET_CONFIG_TIMEOUT: Duration = Duration::from_secs(30);
/// Teardown stages of a kill (DESIGN §3.4.5): `session/close`, closed stdin, SIGTERM.
const CLOSE_WAIT: Duration = Duration::from_secs(2);
const STDIN_WAIT: Duration = Duration::from_secs(3);
const TERM_WAIT: Duration = Duration::from_secs(3);
/// The same stages during a hub stop (10-hub §8).
const STOP_STDIN_WAIT: Duration = Duration::from_secs(5);
const STOP_TERM_WAIT: Duration = Duration::from_secs(1);
/// After the agent exited, how long its stdout may still deliver.
const EXIT_DRAIN: Duration = Duration::from_secs(1);
/// After the agent closed stdout, how long it has to exit before SIGKILL.
const EOF_WAIT: Duration = Duration::from_secs(3);
/// From SIGTERM to SIGKILL of what is left of the process group after an exit (H-11).
const LEFTOVER_GRACE: Duration = Duration::from_secs(2);
/// From SIGTERM to SIGKILL of the process group of a panicked actor.
const PANIC_GRACE: Duration = Duration::from_secs(3);
/// `headSeq`-only changes are published at most this often (deviation 10).
const INFO_EVERY: Duration = Duration::from_millis(500);
/// `seenSeq` reaches the session record at most this often.
const SEEN_SAVE: Duration = Duration::from_secs(2);
/// A faulted journal is retried this often.
const PROBE_EVERY: Duration = Duration::from_secs(60);
/// Characters of the agent's last stderr line in the exit notice.
const NOTICE_MAX: usize = 500;
/// The JSON-RPC error code that means the agent needs a login.
const AUTH_REQUIRED: i64 = -32000;
/// The `session/update` variants a `session/load` replays, which are not journaled
/// again (deviation 7).
const HISTORY: [&str; 6] = [
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
];
/// The files of a session, by extension.
const FILES: [&str; 4] = ["json", "jsonl", "stderr.log", "stderr.log.1"];
const JOURNAL_FAILED: &str = "the journal could not be written";
const NOT_RUNNING: &str = "the agent is not running";
const ENQUEUE_FAILED: &str = "could not queue input for the agent";
const NO_WORKTREE_GIT: &str = "git is not configured for managed worktrees";
const WORKTREE_BUSY: &str = "worktree operation in progress";

/// A request to a session actor.
pub enum Cmd {
    Open(Open),
    Detach {
        conn: ConnId,
        reply: Option<Reply>,
    },
    Act {
        epoch: Option<u64>,
        act: Act,
        reply: Reply,
    },
    /// End the agent for a hub stop; `done` fires once its exit is journaled.
    Shutdown {
        done: oneshot::Sender<()>,
    },
}

pub struct Open {
    pub viewer: Viewer,
    pub since: u64,
    pub epoch: Option<u64>,
    pub spawn: Option<SpawnAcp>,
    pub reply: Reply,
}

/// An `acp.*` request to an existing session.
pub enum Act {
    Prompt(Vec<Value>),
    Cancel,
    Permission {
        req: u64,
        epoch: u64,
        outcome: Value,
    },
    Elicitation {
        req: u64,
        epoch: u64,
        response: Value,
    },
    SetMode(String),
    SetConfigOption {
        epoch: u64,
        config_id: String,
        value: Value,
    },
    SetTask(Option<String>),
    SetPolicy {
        epoch: u64,
        policy: Policy,
    },
    Seen(u64),
    Revive,
    Authenticate(String),
    Kill {
        forget: bool,
    },
    RemoveWorktree,
    #[cfg(test)]
    Panic,
}

impl Cmd {
    /// Answers a command that the session can no longer carry out.
    pub fn refuse(self, code: ErrorCode, message: impl Into<String>) {
        match self {
            Cmd::Open(Open { reply, .. })
            | Cmd::Act { reply, .. }
            | Cmd::Detach {
                reply: Some(reply), ..
            } => reply.err(code, message),
            Cmd::Shutdown { done } => {
                let _ = done.send(());
            }
            Cmd::Detach { reply: None, .. } => {}
        }
    }
}

/// Delivers an `acp.open` to its session. An open with spawn fields for an unknown sid
/// registers the session and starts its actor.
///
/// Boxed because a forgotten actor routes its queued opens through here again.
pub fn open(
    ctx: Arc<Ctx>,
    sid: String,
    mut open: Open,
) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        if let Some(spawn) = &mut open.spawn {
            if spawn.config.len() > ACP_CONFIG_MAX {
                return open
                    .reply
                    .err(ErrorCode::BadRequest, "config has more than 16 entries");
            }
            let mut ids = BTreeSet::new();
            if spawn.config.iter().any(|option| !ids.insert(&option.id)) {
                return open
                    .reply
                    .err(ErrorCode::BadRequest, "config has duplicate ids");
            }
            if let Some(request) = &spawn.worktree {
                if !request.valid() {
                    return open
                        .reply
                        .err(ErrorCode::BadRequest, "invalid worktree branch or base");
                }
                if spawn.host.as_ref().is_some_and(|h| *h != ctx.cfg.host) {
                    return open
                        .reply
                        .err(ErrorCode::BadRequest, "managed worktrees are local only");
                }
                if ctx.cfg.git.is_none() {
                    return open.reply.err(ErrorCode::BadRequest, NO_WORKTREE_GIT);
                }
            }
            spawn.task = match checked_task(spawn.task.take()) {
                Ok(task) => task,
                Err(msg) => return open.reply.err(ErrorCode::BadRequest, msg),
            };
            if let Some(policy) = &spawn.policy
                && let Err(message) = policy.validate()
            {
                return open.reply.err(ErrorCode::BadRequest, message);
            }
        }
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
                    return start(
                        ctx.clone(),
                        sid,
                        created_at,
                        rx,
                        Arc::default(),
                        Start::Create(Box::new(open)),
                    );
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

/// Retains the request string when it is already canonical.
fn checked_task(task: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(raw) = &task else { return Ok(None) };
    match wb_proto::hub::normalize_task(raw)? {
        Some(trimmed) if trimmed.len() == raw.len() => Ok(task),
        trimmed => Ok(trimmed.map(str::to_owned)),
    }
}

/// Held until the startup scan has made its creation-time seed durable.
pub struct RestoreFault {
    sid: String,
    error: anyhow::Error,
    shared: Arc<Shared>,
}

/// Seed from valid metadata even if the PTY namespace shadows it or its journal
/// cannot be loaded. Defer quarantine until the seed is durable.
pub async fn restore(
    ctx: &Arc<Ctx>,
    sid: String,
    shadowed: bool,
    high: &mut u64,
) -> Result<(), RestoreFault> {
    let meta = match read_meta(ctx, &sid).await {
        Ok(Some(meta)) => meta,
        Ok(None) => return Ok(()),
        Err(_) if shadowed => return Ok(()),
        Err(error) => {
            return Err(RestoreFault {
                sid,
                error,
                shared: Arc::default(),
            });
        }
    };
    let created_at = meta.created_at;
    *high = (*high).max(created_at);
    if shadowed {
        return Ok(());
    }
    let shared = Arc::<Shared>::default();
    let loaded = match read_journal(ctx, meta, shared.sync.clone()).await {
        Ok(loaded) => loaded,
        Err(error) => return Err(RestoreFault { sid, error, shared }),
    };
    let rx = ctx.registry.restore(&sid, created_at);
    start(
        ctx.clone(),
        sid,
        created_at,
        rx,
        shared,
        Start::Loaded(Box::new(loaded)),
    );
    Ok(())
}

pub async fn load_faulted(ctx: &Arc<Ctx>, fault: RestoreFault) -> io::Result<()> {
    let RestoreFault { sid, error, shared } = fault;
    let (created_at, rx) = ctx.registry.register_faulted(&sid).await?;
    let fault = load_failure(ctx, &sid, error).await;
    start(
        ctx.clone(),
        sid,
        created_at,
        rx,
        shared,
        Start::Faulted(fault),
    );
    Ok(())
}

/// What a session's actor starts from.
enum Start {
    /// A new sid, and the open with spawn fields that created it.
    Create(Box<Open>),
    /// A session read from the state directory: a dead one.
    Loaded(Box<Loaded>),
    Faulted(String),
}

struct Loaded {
    meta: Meta,
    journal: Journal,
    facts: Facts,
    policy: Option<CompiledPolicy>,
    announced: BTreeMap<u64, PendingKind>,
}

/// `acp/<sid>.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    sid: String,
    agent: String,
    cwd: String,
    /// The other host the agent runs on; absent for a local agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    created_at: u64,
    agent_session_id: Option<String>,
    /// The last `initialize` result, verbatim.
    init: Option<Value>,
    seen_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    managed_worktree: Option<ManagedWorktree>,
}

async fn read_blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .context("session load task failed")?
}

async fn read_meta(ctx: &Ctx, sid: &str) -> anyhow::Result<Option<Meta>> {
    let (dir, sid) = (ctx.acp_dir.clone(), sid.to_owned());
    read_blocking(move || {
        let name = format!("{sid}.json");
        let text = match fs::read(dir.join(&name)) {
            Ok(text) => text,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e).context(name),
        };
        let meta: Meta = serde_json::from_slice(&text).with_context(|| name.clone())?;
        if meta.sid != sid {
            bail!("{name} holds sid {:?}", meta.sid);
        }
        Ok(Some(meta))
    })
    .await
}

async fn read(ctx: &Ctx, sid: &str, sync: Arc<SyncGate>) -> anyhow::Result<Option<Loaded>> {
    let Some(meta) = read_meta(ctx, sid).await? else {
        return Ok(None);
    };
    ctx.registry
        .seed_recovered(meta.created_at)
        .await
        .context("seeding the recovered session's creation time")?;
    read_journal(ctx, meta, sync).await.map(Some)
}

async fn read_journal(ctx: &Ctx, meta: Meta, sync: Arc<SyncGate>) -> anyhow::Result<Loaded> {
    let dir = ctx.acp_dir.clone();
    let (loaded, appended) = read_blocking(move || load_journal(&dir, meta, sync)).await?;
    if appended {
        loaded
            .journal
            .sync()
            .await
            .context("journal sync task failed")?
            .context("syncing completed journal")?;
    }
    Ok(loaded)
}

async fn load_failure(ctx: &Ctx, sid: &str, error: anyhow::Error) -> String {
    let message = format!("{error:#}");
    if error
        .chain()
        .any(|cause| cause.is::<io::Error>() || cause.is::<JoinError>())
    {
        warn!(%sid, "leaving session files in place for the next start: {message}");
        return message;
    }

    warn!(%sid, "quarantining the session: {message}");
    let (dir, s) = (ctx.acp_dir.clone(), sid.to_owned());
    let moved = tokio::task::spawn_blocking(move || quarantine(&dir, &s))
        .await
        .unwrap_or_else(|e| Err(io::Error::other(e)));
    if let Err(e) = &moved {
        warn!(%sid, "quarantining the session: {e}");
    }
    message
}

/// The record, the journal and its fold, normalised; whether normalisation appended.
fn load_journal(dir: &Path, meta: Meta, sync: Arc<SyncGate>) -> anyhow::Result<(Loaded, bool)> {
    let mut facts = Facts::default();
    let mut announced = BTreeMap::new();
    let mut policy_notice = false;
    let path = dir.join(format!("{}.jsonl", meta.sid));
    let mut journal = Journal::open(&path, sync, |ev| {
        facts.apply(&ev);
        announce(&mut announced, &ev);
        match &ev.body {
            // The fold already validated it; nonempty rules folding to none were invalid.
            EventBody::Policy { policy } => {
                policy_notice = !policy.rules.is_empty() && facts.policy.is_none();
            }
            EventBody::Notice {
                level: NoticeLevel::Warn,
                text,
            } if text == INVALID_POLICY_NOTICE => policy_notice = false,
            _ => {}
        }
    })?;
    let policy = facts
        .policy
        .as_ref()
        .map(|policy| CompiledPolicy::new(policy, &meta.cwd, meta.agent == "omp"))
        .transpose()
        .map_err(anyhow::Error::msg)?;
    let mut appended = !journal
        .normalise(&mut facts, now_ms())
        .map_err(|fault| fault.error)
        .context("completing the journal")?
        .is_empty();
    if policy_notice {
        let notice = EventBody::Notice {
            level: NoticeLevel::Warn,
            text: INVALID_POLICY_NOTICE.into(),
        };
        let ev = journal
            .append(notice, now_ms())
            .map_err(|fault| fault.error)
            .context("recording the cleared policy notice")?;
        facts.apply(&ev);
        appended = true;
    }
    let loaded = Loaded {
        meta,
        journal,
        facts,
        policy,
        announced,
    };
    Ok((loaded, appended))
}

/// Notes the kind of a permission or elicitation request by its `req`.
fn announce(announced: &mut BTreeMap<u64, PendingKind>, ev: &JournalEvent) {
    let kind = match ev.body {
        EventBody::Permission { .. } | EventBody::PermissionAuto { .. } => PendingKind::Permission,
        EventBody::Elicitation { .. } => PendingKind::Elicitation,
        _ => return,
    };
    announced.insert(ev.seq, kind);
}

fn fault_message(f: &WriteFault) -> String {
    format!("journal write failed: {}", f.error)
}

/// Renames the files of `sid` to `<sid>.quarantine-<ms>.<ext>`: kept for inspection,
/// never loaded.
fn quarantine(dir: &Path, sid: &str) -> io::Result<()> {
    let ms = now_ms();
    for ext in FILES {
        let to = dir.join(format!("{sid}.quarantine-{ms}.{ext}"));
        match fs::rename(dir.join(format!("{sid}.{ext}")), to) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    File::open(dir)?.sync_all()
}

/// Deletes the files of `sid`; quarantined ones stay.
fn delete(dir: &Path, sid: &str) -> io::Result<()> {
    // Remove the metadata last: startup can still find the sid after a failed unlink.
    for ext in FILES.into_iter().rev() {
        match fs::remove_file(dir.join(format!("{sid}.{ext}"))) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    File::open(dir)?.sync_all()
}

/// Starts the supervised actor of a registered session. A loaded or faulted session is
/// published before this returns.
fn start(
    ctx: Arc<Ctx>,
    sid: String,
    created_at: u64,
    rx: mpsc::Receiver<Cmd>,
    shared: Arc<Shared>,
    from: Start,
) {
    let mut acp = Acp::new(ctx, sid, created_at, shared);
    let first = acp.begin(from);
    tokio::spawn(supervise(acp, rx, first));
}

/// Runs the actor of one session. After a panic it ends the agent's process group,
/// tells the attached connections, and reloads the session from disk the way startup
/// does.
async fn supervise(mut acp: Acp, mut rx: mpsc::Receiver<Cmd>, mut first: Option<Open>) {
    let (ctx, sid, created_at) = (acp.ctx.clone(), acp.sid.clone(), acp.created_at);
    let shared = acp.shared.clone();
    loop {
        let actor = acp.run(rx, first).instrument(info_span!("acp", %sid));
        let next = match tokio::spawn(actor).await {
            Err(e) if e.is_panic() => {
                error!(%sid, "the session actor panicked: {e}");
                // The panic dropped the actor's queue. Commands sent during the reload
                // wait in a new one for the reloaded actor.
                ctx.registry.reopen(&sid, created_at)
            }
            _ => return,
        };
        let dropped = take_viewers(&shared);
        let Some(next) = next else {
            return tell_reloaded(&sid, dropped);
        };
        let from = match read(&ctx, &sid, shared.sync.clone()).await {
            Ok(Some(loaded)) => Start::Loaded(Box::new(loaded)),
            Ok(None) => {
                // The files are gone: so is the session.
                ctx.registry.forget(&sid, created_at, &dropped);
                // What queued during the reload goes wherever the sid leads now.
                let mut rx = next;
                rx.close();
                while let Some(cmd) = rx.recv().await {
                    redeliver(&ctx, &sid, cmd).await;
                }
                return;
            }
            Err(error) => Start::Faulted(load_failure(&ctx, &sid, error).await),
        };
        rx = next;
        acp = Acp::new(ctx.clone(), sid.clone(), created_at, shared.clone());
        first = acp.begin(from);
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

/// Route an open as a new request; other commands keep their original epoch guard.
async fn redeliver(ctx: &Arc<Ctx>, sid: &str, cmd: Cmd) {
    match cmd {
        Cmd::Open(o) => open(ctx.clone(), sid.to_owned(), o).await,
        cmd => ctx.registry.redeliver(sid, cmd).await,
    }
}

/// State that survives an actor panic and belongs to this incarnation only.
#[derive(Default)]
struct Shared {
    sync: Arc<SyncGate>,
    viewers: Mutex<Vec<Attached>>,
}

struct Attached {
    viewer: Viewer,
    /// While the connection's replay is being sent: the live events held back for
    /// after it.
    backlog: Option<Backlog>,
}

struct Backlog {
    lines: Vec<Arc<[u8]>>,
    bytes: usize,
    /// Stops the replay.
    cancel: Arc<AtomicBool>,
}

/// Ends an attachment: its replay stops.
fn stop(a: Attached) -> Viewer {
    if let Some(b) = &a.backlog {
        b.cancel.store(true, Ordering::Relaxed);
    }
    a.viewer
}

fn take_viewers(shared: &Shared) -> Vec<Viewer> {
    lock(&shared.viewers).drain(..).map(stop).collect()
}

/// A replay that ended, as its pump reports it to the actor.
struct Replayed {
    conn: ConnId,
    cancel: Arc<AtomicBool>,
    /// The whole replay was sent.
    ok: bool,
}

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

/// Why the hub is ending the agent.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Cause {
    /// `acp.kill`.
    User,
    /// The setup failed (deviation 9).
    Setup,
    /// The journal could not be written (H-9).
    Fault,
}

#[derive(Clone, Copy)]
enum Stage {
    Close,
    Stdin,
    Term,
    Kill,
}

/// A running agent and the JSON-RPC state of its connection.
struct Proc {
    agent: Agent,
    via: SpawnVia,
    next_id: u64,
    outstanding: HashMap<u64, Purpose>,
    /// Code and signal once exit or loss of the child has been confirmed.
    status: Option<(Option<i32>, Option<i32>)>,
    /// Stdout reached its end.
    eof: bool,
    /// After the exit, until when stdout may still deliver; after the end of stdout,
    /// until when the agent may still exit before SIGKILL.
    drain_until: Option<Instant>,
}

impl Proc {
    /// True only if the stdin queue accepted `msg`, not if the agent read it.
    fn send(&self, msg: &Value) -> bool {
        self.agent
            .stdin
            .as_ref()
            .is_some_and(|s| s.send(rpc::encode(msg)))
    }
}

/// What a request to the agent is for.
enum Purpose {
    Init,
    Session(SessionVia),
    Prompt,
    SetMode {
        mode_id: String,
        reply: Reply,
        deadline: Instant,
    },
    SetConfigOption {
        reply: Reply,
        deadline: Instant,
    },
    StartupConfig {
        deadline: Instant,
    },
    Authenticate(Reply),
    Close,
}

impl Purpose {
    /// Answers the request that waited on this one, if any.
    fn fail(self, code: ErrorCode, message: &str) {
        if let Purpose::SetMode { reply, .. }
        | Purpose::SetConfigOption { reply, .. }
        | Purpose::Authenticate(reply) = self
        {
            reply.err(code, message);
        }
    }
}

/// An agent request that waits for a viewer's answer.
struct HeldReq {
    rpc_id: Value,
    kind: PendingKind,
    option_ids: Vec<String>,
}

/// The creating open waits for this ordered batch; no live action may interleave.
struct StartupConfig {
    open: Open,
    remaining: VecDeque<ConfigOption>,
    current: Option<ConfigOption>,
    errors: Vec<ConfigError>,
}

/// The request stays with the actor while git runs. In particular shutdown can
/// refuse it explicitly, even when it has to abort a rollback.
enum WorktreeOp {
    Create {
        open: Open,
        cancel: Option<oneshot::Sender<()>>,
    },
    Remove(Reply),
    Rollback {
        reply: Reply,
        failure: CreateFailure,
        path: String,
    },
}

enum WorktreeResult {
    Created(Result<ManagedWorktree, CreateFailure>),
    Removed(Result<bool, (ErrorCode, String)>),
}

enum Event {
    Cmd(Option<Cmd>),
    Worktree(Result<WorktreeResult, JoinError>),
    Replayed(Replayed),
    Out(Option<Out>),
    Exited(io::Result<WaitNotice>),
    Drained,
    SetupIdle,
    RpcTimeout,
    Stage,
    Info,
    Meta,
    Probe,
}

struct Acp {
    ctx: Arc<Ctx>,
    sid: String,
    created_at: u64,
    updated_at: u64,
    phase: Phase,
    shared: Arc<Shared>,
    meta: Meta,
    /// `None` until creation succeeds, or for a session whose files failed to load.
    journal: Option<Journal>,
    facts: Facts,
    /// The kind of every permission and elicitation request ever announced, by `req`.
    announced: BTreeMap<u64, PendingKind>,
    fault: Option<Fault>,
    /// How the agent ended while the journal was faulted, for the probe's `exit`.
    fault_exit: Option<(Option<i32>, Option<i32>, ExitReason)>,
    proc: Option<Proc>,
    startup_config: Option<StartupConfig>,
    worktree_op: Option<WorktreeOp>,
    /// The first kill of an unpublished checkout waits through its cleanup.
    create_kill: Option<Reply>,
    /// At most one git task; dropping the actor also aborts it and its process group.
    git: JoinSet<WorktreeResult>,
    policy: Option<CompiledPolicy>,
    /// A cancelled turn may still deliver requests before its prompt response.
    turn_cancelled: bool,
    /// The agent's requests waiting for an answer, by `req`.
    held: BTreeMap<u64, HeldReq>,
    /// A `session` event follows the last `spawn`.
    has_session: bool,
    /// From sending `session/load` to its response (deviation 7).
    load_filter: bool,
    cause: Option<Cause>,
    /// The teardown stage and when the next one starts.
    stage: Option<(Stage, Option<Instant>)>,
    /// Set on `Shutdown`; fires once the exit is journaled.
    stopping: Option<oneshot::Sender<()>>,
    /// `acp.kill{forget:true}` replies, sent after the exit and the forget.
    forgets: Vec<Reply>,
    replayed_tx: mpsc::UnboundedSender<Replayed>,
    replayed_rx: mpsc::UnboundedReceiver<Replayed>,
    /// What the watchers and viewers last got, and when.
    published: Option<(Summary, AcpSessionInfo)>,
    published_at: Option<Instant>,
    /// Holds Summaries back while creating or finalising a session: watchers see the
    /// initial task with the spawn, and never a user kill's interim `error` (ROB-13).
    quiet: bool,
    /// When the setup gives up on a silent agent.
    setup_at: Option<Instant>,
    /// When a held-back `headSeq` change goes out.
    info_at: Option<Instant>,
    meta_at: Option<Instant>,
    probe_at: Option<Instant>,
}

impl Acp {
    fn new(ctx: Arc<Ctx>, sid: String, created_at: u64, shared: Arc<Shared>) -> Self {
        let (replayed_tx, replayed_rx) = mpsc::unbounded_channel();
        Acp {
            ctx,
            sid,
            created_at,
            updated_at: created_at,
            phase: Phase::Running,
            shared,
            meta: Meta::default(),
            journal: None,
            facts: Facts::default(),
            announced: BTreeMap::new(),
            fault: None,
            fault_exit: None,
            proc: None,
            startup_config: None,
            worktree_op: None,
            create_kill: None,
            git: JoinSet::new(),
            policy: None,
            turn_cancelled: false,
            held: BTreeMap::new(),
            has_session: false,
            load_filter: false,
            cause: None,
            stage: None,
            stopping: None,
            forgets: Vec::new(),
            replayed_tx,
            replayed_rx,
            published: None,
            published_at: None,
            quiet: false,
            setup_at: None,
            info_at: None,
            meta_at: None,
            probe_at: None,
        }
    }

    /// Takes on the starting state; the open of a new session is returned to `run`.
    fn begin(&mut self, from: Start) -> Option<Open> {
        match from {
            Start::Create(o) => return Some(*o),
            Start::Loaded(loaded) => {
                let Loaded {
                    meta,
                    journal,
                    facts,
                    policy,
                    announced,
                } = *loaded;
                self.meta = meta;
                self.journal = Some(journal);
                self.facts = facts;
                self.policy = policy;
                self.announced = announced;
            }
            Start::Faulted(message) => {
                self.fault = Some(Fault {
                    code: FaultCode::LoadFailed,
                    message,
                });
            }
        }
        self.publish();
        None
    }

    async fn run(mut self, mut rx: mpsc::Receiver<Cmd>, first: Option<Open>) {
        if let Some(o) = first {
            self.create(o).await;
        }
        loop {
            if self.phase == Phase::Forget
                && let Err(e) = self.delete_files().await
            {
                // A partial unlink may have removed the journal. Never append to it.
                let message = format!("deleting the session's files: {e}");
                warn!("{message}");
                self.journal = None;
                self.probe_at = None;
                self.fault = Some(Fault {
                    code: FaultCode::LoadFailed,
                    message: message.clone(),
                });
                self.publish();
                for reply in self.forgets.drain(..) {
                    reply.err(ErrorCode::Internal, &message);
                }
                self.phase = if self.stopping.is_some() {
                    Phase::Stopped
                } else {
                    Phase::Running
                };
            }
            if self.phase != Phase::Running {
                break;
            }
            // A due record goes to disk before the next event: revive depends on `init`,
            // and a hub killed after the `session` line must still find it (10 §7.4).
            if self.meta_at.is_some_and(|at| at <= Instant::now()) {
                self.save_meta().await;
            }
            let setup_at = self.setup_at.filter(|_| self.setup_waiting());
            let rpc_at = self.rpc_deadline();
            let stage_at = self.stage.and_then(|(_, at)| at);
            let (info_at, meta_at, probe_at) = (self.info_at, self.meta_at, self.probe_at);
            let (out, watch, drain_until) = match &mut self.proc {
                Some(p) => (
                    (!p.eof).then_some(&mut p.agent.stdout),
                    p.status.is_none().then_some(&mut p.agent.watch),
                    p.drain_until,
                ),
                None => (None, None, None),
            };
            let event = tokio::select! {
                cmd = rx.recv() => Event::Cmd(cmd),
                Some(result) = self.git.join_next(), if self.worktree_op.is_some() => Event::Worktree(result),
                Some(r) = self.replayed_rx.recv() => Event::Replayed(r),
                out = recv(out) => Event::Out(out),
                st = child::wait(watch) => Event::Exited(st),
                () = sleep_until(drain_until) => Event::Drained,
                () = sleep_until(setup_at) => Event::SetupIdle,
                () = sleep_until(rpc_at) => Event::RpcTimeout,
                () = sleep_until(stage_at) => Event::Stage,
                () = sleep_until(info_at) => Event::Info,
                () = sleep_until(meta_at) => Event::Meta,
                () = sleep_until(probe_at) => Event::Probe,
            };
            match event {
                Event::Cmd(Some(cmd)) => self.command(cmd).await,
                Event::Cmd(None) => return,
                Event::Worktree(result) => self.worktree_done(result).await,
                Event::Replayed(r) => self.replayed(&r),
                Event::Out(Some(Out::Msg(msg))) => self.agent_message(msg).await,
                Event::Out(Some(Out::Eof) | None) => self.stdout_closed(),
                Event::Exited(st) => self.child_exited(st),
                Event::Drained => self.drained(),
                Event::SetupIdle => self.setup_timeout(),
                Event::RpcTimeout => self.rpc_timeout(),
                Event::Stage => self.next_stage(),
                Event::Info => self.flush_info(),
                Event::Meta => self.save_meta().await,
                Event::Probe => self.probe(),
            }
        }
        match self.phase {
            Phase::Forget => {
                let viewers = take_viewers(&self.shared);
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
                self.save_meta().await;
                if let Some(journal) = self.journal.take()
                    && let Ok(Err(e)) = journal.close().await
                {
                    warn!("syncing the journal: {e}");
                }
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
    /// sid, one at a time and in order.
    async fn reroute(&self, mut rx: mpsc::Receiver<Cmd>) {
        rx.close();
        while let Some(cmd) = rx.recv().await {
            redeliver(&self.ctx, &self.sid, cmd).await;
        }
    }

    async fn command(&mut self, cmd: Cmd) {
        if self.stopping.is_some() {
            return cmd.refuse(ErrorCode::Internal, "hub stopping");
        }
        if let Some(op) = &mut self.worktree_op {
            match cmd {
                // Kill/forget cancels an unpublished create. Once rolling back, we
                // only need to wait; never interrupt the cleanup to answer a kill.
                Cmd::Act {
                    act: Act::Kill { .. },
                    reply,
                    ..
                } if matches!(op, WorktreeOp::Create { .. } | WorktreeOp::Rollback { .. }) => {
                    if self.create_kill.is_some() {
                        return reply.err(ErrorCode::Conflict, WORKTREE_BUSY);
                    }
                    if let WorktreeOp::Create { cancel, .. } = op
                        && let Some(cancel) = cancel.take()
                    {
                        let _ = cancel.send(());
                    }
                    self.create_kill = Some(reply);
                    return;
                }
                Cmd::Open(o)
                    if self.journal.is_none()
                        || o.spawn.as_ref().is_some_and(|s| s.worktree.is_some()) =>
                {
                    return o.reply.err(ErrorCode::Conflict, WORKTREE_BUSY);
                }
                Cmd::Act { act, reply, .. }
                    if self.journal.is_none()
                        || matches!(act, Act::Revive | Act::Kill { .. } | Act::RemoveWorktree) =>
                {
                    return reply.err(ErrorCode::Conflict, WORKTREE_BUSY);
                }
                _ => {}
            }
        }
        match cmd {
            Cmd::Open(o) => self.open(o, false),
            Cmd::Detach { conn, reply } => {
                self.detach(conn);
                if let Some(reply) = reply {
                    reply.done();
                }
            }
            Cmd::Act { act, reply, .. } => self.act(act, reply),
            Cmd::Shutdown { done } => self.shutdown(done).await,
        }
    }

    fn path(&self, ext: &str) -> PathBuf {
        self.ctx.acp_dir.join(format!("{}.{ext}", self.sid))
    }

    async fn delete_files(&self) -> io::Result<()> {
        let (dir, sid) = (self.ctx.acp_dir.clone(), self.sid.clone());
        tokio::task::spawn_blocking(move || delete(&dir, &sid))
            .await
            .map_err(io::Error::other)?
    }

    /// Creates the session of a new sid: its record and journal, then the agent. A
    /// failed spawn is journaled, and the session stays.
    async fn create(&mut self, mut o: Open) {
        let Some(spawn) = &mut o.spawn else {
            let msg = format!("no session {}", self.sid);
            return self.abandon(o.reply, Clean((ErrorCode::NotFound, msg)));
        };
        if spawn.host.as_ref() == Some(&self.ctx.cfg.host) {
            spawn.host = None;
        }
        if let Some(host) = &spawn.host {
            if let Err(error) = self.check_remote(host, &spawn.agent, &spawn.cwd) {
                return self.abandon(o.reply, Clean(error));
            }
        } else {
            if !self.ctx.cfg.agents.contains_key(&spawn.agent) {
                let msg = format!("no agent {}", spawn.agent);
                return self.abandon(o.reply, Clean((ErrorCode::UnknownAgent, msg)));
            }
            if !spawn.cwd.starts_with('/') || !Path::new(&spawn.cwd).is_dir() {
                let msg = "cwd must be an absolute path of an existing directory".to_owned();
                return self.abandon(o.reply, Clean((ErrorCode::BadRequest, msg)));
            }
        }
        if let Some(request) = spawn.worktree.take() {
            let ctx = self.ctx.clone();
            let sid = self.sid.clone();
            let cwd = std::mem::take(&mut spawn.cwd);
            let (cancel, cancelled) = oneshot::channel();
            self.worktree_op = Some(WorktreeOp::Create {
                open: o,
                cancel: Some(cancel),
            });
            self.git.spawn(async move {
                let git = worktree::Git {
                    program: ctx.cfg.git.as_deref().expect("validated worktree request"),
                    reaper: &ctx.reaper,
                };
                WorktreeResult::Created(
                    worktree::create(
                        git,
                        Path::new(&cwd),
                        ctx.cfg.worktree_root.as_deref(),
                        &request,
                        &sid,
                        cancelled,
                    )
                    .await,
                )
            });
        } else {
            self.finish_create(o, None).await;
        }
    }

    async fn finish_create(&mut self, mut o: Open, managed_worktree: Option<ManagedWorktree>) {
        let spawn = o.spawn.take().expect("validated creating open");
        let cwd = managed_worktree
            .as_ref()
            .map_or(spawn.cwd, |r| r.path.clone());
        self.meta = Meta {
            sid: self.sid.clone(),
            agent: spawn.agent,
            cwd,
            host: spawn.host,
            created_at: self.created_at,
            managed_worktree,
            ..Meta::default()
        };
        self.policy = match spawn
            .policy
            .as_ref()
            .map(|policy| CompiledPolicy::new(policy, &self.meta.cwd, self.meta.agent == "omp"))
            .transpose()
        {
            Ok(policy) => policy,
            Err(message) => {
                return self.refuse_create(o.reply, Clean((ErrorCode::BadRequest, message)));
            }
        };
        let (dir, sid) = (self.ctx.acp_dir.clone(), self.sid.clone());
        let sync = self.shared.sync.clone();
        let json = serde_json::to_vec(&self.meta);
        let made = tokio::task::spawn_blocking(move || {
            // Files an earlier incarnation failed to delete must not leak into this one.
            delete(&dir, &sid)?;
            let opened = write_atomic(&dir, &format!("{sid}.json"), &json?).and_then(|()| {
                Journal::open(&dir.join(format!("{sid}.jsonl")), sync, drop)
                    .map_err(|e| io::Error::other(format!("{e:#}")))
            });
            if opened.is_err() {
                let _ = delete(&dir, &sid);
            }
            opened
        })
        .await
        .unwrap_or_else(|e| Err(io::Error::other(e)));
        match made {
            Ok(journal) => self.journal = Some(journal),
            Err(e) => {
                warn!("creating the session's files: {e}");
                let msg = format!("creating the session's files: {e}");
                return self.refuse_create(o.reply, Clean((ErrorCode::Internal, msg)));
            }
        }
        // A create with a task stays unpublished until both initial events are written.
        let has_task = spawn.task.is_some();
        self.quiet = has_task;
        let written = spawn
            .task
            .is_none_or(|task| self.record(EventBody::Task { task: Some(task) }))
            && spawn
                .policy
                .is_none_or(|policy| self.record(EventBody::Policy { policy }));
        if !written {
            if has_task {
                // Nothing has been published. Keep the sid reserved until its files
                // are gone, so cleanup cannot delete a racing retry's journal.
                self.journal = None;
                if let Err(e) = self.delete_files().await {
                    let msg = format!("deleting the session's files: {e}");
                    warn!("{msg}");
                    return self
                        .refuse_create(o.reply, PossibleLeftover((ErrorCode::Internal, msg)));
                }
                return self
                    .refuse_create(o.reply, Clean((ErrorCode::Faulted, JOURNAL_FAILED.into())));
            }
            // A policy-only write fault returns a faulted session with per-option errors.
            let errors = spawn
                .config
                .into_iter()
                .map(|option| ConfigError {
                    id: option.id,
                    value: option.value,
                    code: ErrorCode::Faulted,
                    error: JOURNAL_FAILED.into(),
                })
                .collect();
            self.open_with_config_errors(o, true, errors);
            return;
        }
        self.quiet = false;
        if spawn.config.is_empty() {
            let _ = self.spawn(SpawnVia::New);
            self.open(o, true);
        } else {
            self.startup_config = Some(StartupConfig {
                open: o,
                remaining: spawn.config.into(),
                current: None,
                errors: Vec::new(),
            });
            let _ = self.spawn(SpawnVia::New);
        }
    }

    /// Checks a spawn on another host (DESIGN §3.8.5); the cwd is not looked up here.
    fn check_remote(&self, host: &str, agent: &str, cwd: &str) -> Result<(), (ErrorCode, String)> {
        let Some(cfg) = self.ctx.cfg.hosts.get(host) else {
            return Err((ErrorCode::BadRequest, format!("no host {host}")));
        };
        if !cfg.agents.contains_key(agent) {
            return Err((
                ErrorCode::UnknownAgent,
                format!("no agent {agent} on {host}"),
            ));
        }
        if !cwd.starts_with('/') || cwd.contains('\0') || cwd.len() > REMOTE_CWD_MAX {
            let msg = format!("cwd must be an absolute path of at most {REMOTE_CWD_MAX} bytes");
            return Err((ErrorCode::BadRequest, msg));
        }
        Ok(())
    }

    /// Keep the sid reserved until any unpublished checkout has been rolled back.
    fn refuse_create(&mut self, reply: Reply, failure: CreateFailure) {
        if let Some(record) = self.meta.managed_worktree.take() {
            self.rollback(record, reply, failure);
        } else {
            self.abandon(reply, failure);
        }
    }

    /// Releases the unpublished sid only after cleanup, before clients can retry.
    fn abandon(&mut self, reply: Reply, failure: CreateFailure) {
        if self.ctx.registry.abandon(&self.sid, self.created_at) {
            self.phase = Phase::Abandoned;
        }
        let ((code, message), clean) = match failure {
            Clean(error) => (error, true),
            PossibleLeftover(error) => (error, false),
        };
        if let Some(kill) = self.create_kill.take() {
            if clean {
                kill.done();
            } else {
                kill.err(code, message.clone());
            }
        }
        reply.err(code, message);
    }

    /// Starts the agent and sends `initialize` only after recording `spawn`.
    /// An agent start failure is `spawn_failed` if its `setup_error` was recorded;
    /// a journal failure in either path is `faulted` (DESIGN §3.4.4).
    fn spawn(&mut self, via: SpawnVia) -> Result<(), (ErrorCode, String)> {
        // A previous background sync can have latched EIO without the actor noticing.
        let journal = self.journal.as_ref().expect("spawn requires a journal");
        if let Err(error) = journal.healthy() {
            self.journal_fault(&WriteFault { error });
            return Err((ErrorCode::Faulted, JOURNAL_FAILED.into()));
        }
        let (sid, meta, log) = (&self.sid, &self.meta, self.path("stderr.log"));
        let started = match &meta.host {
            None => match self.ctx.cfg.agents.get(&meta.agent) {
                Some(cfg) => agent::start(&self.ctx, sid, &cfg.argv, &cfg.env, &meta.cwd, log),
                None => Err(format!("agent {} is not in the hub's table", meta.agent)),
            },
            Some(host) => match self.ctx.cfg.hosts.get(host) {
                Some(cfg) if cfg.agents.contains_key(&meta.agent) => {
                    let argv = agent::remote_argv(cfg, &meta.agent, &meta.cwd, sid);
                    let home = &self.ctx.ident.home;
                    agent::start(&self.ctx, sid, &argv, &BTreeMap::new(), home, log)
                }
                Some(_) => Err(format!(
                    "agent {} is not in the table of {host}",
                    meta.agent
                )),
                None => Err(format!("host {host} is not in the hub's table")),
            },
        };
        let agent = match started {
            Ok(agent) => agent,
            Err(message) => {
                warn!(agent = %self.meta.agent, "{message}");
                if !self.record(EventBody::SetupError {
                    code: SetupErrorCode::SpawnFailed,
                    message: message.clone(),
                    rpc: None,
                }) {
                    return Err((ErrorCode::Faulted, JOURNAL_FAILED.into()));
                }
                return Err((ErrorCode::SpawnFailed, message));
            }
        };
        let pid = agent.pid();
        info!(pid, agent = %self.meta.agent, ?via, "spawned");
        // Register the child first so journal_fault can stop it if the append fails.
        self.proc = Some(Proc {
            agent,
            via,
            next_id: 1,
            outstanding: HashMap::new(),
            status: None,
            eof: false,
            drain_until: None,
        });
        if !self.record(EventBody::Spawn { pid, via }) {
            return Err((ErrorCode::Faulted, JOURNAL_FAILED.into()));
        }
        self.setup_at = Some(Instant::now() + SETUP_IDLE_TIMEOUT);
        let _ = self.request(Purpose::Init, rpc::initialize);
        Ok(())
    }

    /// Returns the purpose to its caller if the stdin queue rejects the request.
    fn request(
        &mut self,
        purpose: Purpose,
        build: impl FnOnce(u64) -> Value,
    ) -> Result<(), Purpose> {
        let Some(p) = &mut self.proc else {
            return Err(purpose);
        };
        let id = p.next_id;
        if !p.send(&build(id)) {
            return Err(purpose);
        }
        p.next_id += 1;
        p.outstanding.insert(id, purpose);
        Ok(())
    }

    /// Queues `msg` for the agent, if the process and its stdin queue are available.
    fn send(&self, msg: &Value) -> bool {
        self.proc.as_ref().is_some_and(|p| p.send(msg))
    }

    /// Writes a hub note to the agent's stderr log.
    fn log(&self, note: &str) {
        if let Some(p) = &self.proc {
            p.agent.log.write(format!("[hub] {note}\n").as_bytes());
        }
    }

    /// Whether the last `initialize` result has a non-null, non-false value at
    /// `pointer`.
    fn advertised(&self, pointer: &str) -> bool {
        let value = self.meta.init.as_ref().and_then(|i| i.pointer(pointer));
        value.is_some_and(|v| !v.is_null() && *v != Value::Bool(false))
    }

    fn auth_methods(&self) -> impl Iterator<Item = &Value> {
        let methods = self.meta.init.as_ref().and_then(|i| i.get("authMethods"));
        methods.and_then(Value::as_array).into_iter().flatten()
    }

    /// Journals `body`, then folds it, sends it to the viewers and publishes (H-9).
    /// False if nothing was written: the session is faulted, or this write faulted it.
    fn record(&mut self, body: EventBody) -> bool {
        if self.fault.is_some() {
            return false;
        }
        let Some(journal) = &mut self.journal else {
            return false;
        };
        match journal.append(body, now_ms()) {
            Ok(ev) => {
                self.applied(ev);
                true
            }
            Err(fault) => {
                self.journal_fault(&fault);
                false
            }
        }
    }

    /// Folds an event that is on disk, sends it to the viewers and publishes.
    fn applied(&mut self, ev: JournalEvent) {
        let setup_error = match &ev.body {
            // Keep the agent's buffered setup error in the journal. The initial
            // options, however, can no longer be attempted.
            EventBody::SetupError { .. } if self.draining() => {
                Some((ErrorCode::NotAlive, NOT_RUNNING.to_owned()))
            }
            EventBody::SetupError { code, message, .. } => Some((
                match code {
                    SetupErrorCode::AgentExited | SetupErrorCode::Interrupted => {
                        ErrorCode::NotAlive
                    }
                    SetupErrorCode::Timeout => ErrorCode::Timeout,
                    SetupErrorCode::SpawnFailed => ErrorCode::SpawnFailed,
                    _ => ErrorCode::AgentError,
                },
                message.clone(),
            )),
            _ => None,
        };
        match ev.body {
            EventBody::Spawn { .. } => self.has_session = false,
            EventBody::Session { .. } => self.has_session = true,
            _ => {}
        }
        let durable = matches!(
            ev.body,
            EventBody::Session { .. }
                | EventBody::SetupError { .. }
                | EventBody::TurnEnd { .. }
                | EventBody::TurnError { .. }
                | EventBody::Config { .. }
                | EventBody::Task { .. }
                | EventBody::Policy { .. }
                | EventBody::Exit { .. }
        );
        if durable && let Some(journal) = &self.journal {
            drop(journal.sync());
        }
        announce(&mut self.announced, &ev);
        let materialized = self.facts.apply(&ev);
        // A session/update has no actor-side Summary changes outside the fold. Other
        // records can accompany one (e.g. a notice after taking startup_config).
        let head_only_update = !materialized && matches!(ev.body, EventBody::Update { .. });
        let msg = line(&HubMessage::AcpEv {
            sid: self.sid.clone(),
            ev: Box::new(ev),
        });
        let dropped = self.fan_out(&msg);
        if dropped || !head_only_update {
            self.publish();
        } else if !self.quiet && !self.defer_head() {
            self.flush_info();
        }
        if let Some((code, message)) = setup_error {
            self.fail_startup_config(code, &message);
        }
    }

    /// A journal write failed (H-9): the agent's requests are cancelled, the agent is
    /// stopped, and nothing more is journaled until a probe succeeds.
    fn journal_fault(&mut self, fault: &WriteFault) {
        error!(sid = %self.sid, "journal write failed: {}", fault.error);
        self.fault = Some(Fault {
            code: FaultCode::JournalWrite,
            message: fault_message(fault),
        });
        for held in std::mem::take(&mut self.held).into_values() {
            self.send(&rpc::result(
                &held.rpc_id,
                to_agent(held.kind, cancelled(held.kind)),
            ));
        }
        self.fail_startup_config(ErrorCode::Faulted, JOURNAL_FAILED);
        self.stop_agent(Cause::Fault);
        self.probe_at = Some(Instant::now() + PROBE_EVERY);
        self.publish();
    }

    /// Retries a faulted journal (H-9): the death invariant the fault held back, or a
    /// notice when nothing is outstanding. Success clears the fault.
    fn probe(&mut self) {
        let faulted = self.fault.as_ref().map(|f| (f.code, f.message.clone()));
        let Some((FaultCode::JournalWrite, message)) = faulted else {
            return;
        };
        if self.proc.is_some() || self.journal.is_none() {
            // An agent that outlives its SIGKILL holds the fault: the probe waits
            // another period rather than firing again at once.
            self.probe_at = self.proc.is_some().then(|| Instant::now() + PROBE_EVERY);
            return;
        }
        let lines = if self.facts.running {
            let (code, signal, reason) =
                self.fault_exit
                    .unwrap_or((None, None, ExitReason::HubRestart));
            let why = if reason == ExitReason::HubRestart {
                "interrupted by a hub restart"
            } else {
                "the agent was stopped after a journal write failure"
            };
            let mut lines = self.facts.death_lines(true, why);
            lines.push(EventBody::Exit {
                code,
                signal,
                reason,
            });
            lines
        } else {
            vec![EventBody::Notice {
                level: NoticeLevel::Warn,
                text: format!("{message}; events of that time may be missing"),
            }]
        };
        for body in lines {
            let Some(journal) = &mut self.journal else {
                return;
            };
            match journal.append(body, now_ms()) {
                Ok(ev) => self.applied(ev),
                Err(f) => {
                    warn!("the journal still fails: {}", f.error);
                    self.probe_at = Some(Instant::now() + PROBE_EVERY);
                    return;
                }
            }
        }
        info!("the journal works again; the fault is cleared");
        self.fault = None;
        self.fault_exit = None;
        self.probe_at = None;
        self.publish();
    }

    /// The wire Summary and session info as they are now.
    fn snapshot(&self, updated_at: u64) -> (Summary, AcpSessionInfo) {
        let viewers = lock(&self.shared.viewers).len();
        let facts = &self.facts;
        let mut summary = Summary {
            sid: self.sid.clone(),
            kind: Kind::Acp,
            host: self
                .meta
                .host
                .as_ref()
                .unwrap_or(&self.ctx.cfg.host)
                .clone(),
            created_at: self.created_at,
            updated_at,
            alive: self.proc.is_some(),
            viewers: u32::try_from(viewers).unwrap_or(u32::MAX),
            cwd: self.meta.cwd.clone(),
            fault: self.fault.clone(),
            pty: None,
            acp: Some(AcpFacts {
                agent: self.meta.agent.clone(),
                agent_session_id: facts.agent_session_id.clone(),
                revivable: facts.revivable(self.meta.init.as_ref()),
                activity: if self.startup_config.is_some() {
                    Activity::Setup
                } else {
                    facts.activity
                },
                pending: facts.pending.clone(),
                last: facts.last.clone(),
                head_seq: facts.head_seq,
                seen_seq: self.meta.seen_seq,
                title: facts.title.clone(),
                mode_id: facts.mode_id.clone(),
                policy: facts.policy.clone(),
                config_options: facts.config_options.clone(),
                managed_worktree: self.meta.managed_worktree.clone(),
                task: facts.task.clone(),
            }),
        };
        fit_summary(&mut summary);
        let init = self.meta.init.as_ref();
        let field = |key: &str| init.and_then(|i| i.get(key)).cloned();
        let session = AcpSessionInfo {
            protocol_version: init
                .and_then(|i| i.get("protocolVersion"))
                .and_then(Value::as_u64),
            agent_info: field("agentInfo"),
            agent_capabilities: field("agentCapabilities"),
            prompt_capabilities: init
                .and_then(|i| i.pointer("/agentCapabilities/promptCapabilities"))
                .cloned(),
            auth_methods: field("authMethods"),
            modes: facts.modes.clone(),
            config_options: facts.config_options.clone(),
            available_commands: facts.available_commands.clone(),
            plan: facts.plan.clone(),
            usage: facts.usage.clone(),
        };
        (summary, session)
    }

    /// Publishes a change to the watchers and the attached connections: at once, unless
    /// only `headSeq` changed, which goes out at most every 500 ms (deviation 10).
    fn publish(&mut self) {
        if self.quiet {
            return;
        }
        let updated_at = now_ms().max(self.updated_at);
        let (mut summary, session) = self.snapshot(updated_at);
        if let Some((last, last_session)) = &self.published
            && let (Some(now), Some(then)) = (&mut summary.acp, &last.acp)
        {
            // Compare at the published head and time without copying the Summary.
            now.head_seq = then.head_seq;
            summary.updated_at = last.updated_at;
            if summary == *last
                && session == *last_session
                && (self.facts.head_seq == then.head_seq || self.defer_head())
            {
                return;
            }
            summary.acp.as_mut().unwrap().head_seq = self.facts.head_seq;
            summary.updated_at = updated_at;
        }
        self.send_info(summary, session);
    }

    /// Arms the deadline relative to the last publication, not the latest event.
    fn defer_head(&mut self) -> bool {
        if let Some(next) = self.published_at.map(|at| at + INFO_EVERY)
            && next > Instant::now()
        {
            self.info_at = Some(next);
            return true;
        }
        false
    }

    fn flush_info(&mut self) {
        let (summary, session) = self.snapshot(now_ms().max(self.updated_at));
        self.send_info(summary, session);
    }

    fn send_info(&mut self, summary: Summary, session: AcpSessionInfo) {
        self.info_at = None;
        self.updated_at = summary.updated_at;
        self.ctx.registry.publish(Arc::new(summary.clone()));
        let msg = line(&HubMessage::AcpInfo {
            sid: self.sid.clone(),
            summary: Box::new(summary.clone()),
            session: Box::new(session.clone()),
        });
        self.published = Some((summary, session));
        self.published_at = Some(Instant::now());
        if self.fan_out(&msg) {
            // The viewer count changed.
            self.publish();
        }
    }

    /// Sends `msg` to every attached connection, or holds it back for one whose replay
    /// is running. A connection that overflows is dropped and closed. Whether any was.
    fn fan_out(&self, msg: &Arc<[u8]>) -> bool {
        let mut viewers = lock(&self.shared.viewers);
        let before = viewers.len();
        viewers.retain_mut(|a| match &mut a.backlog {
            None => a.viewer.outq.push_event(msg.clone()).is_ok(),
            // Deviation 13: a held-back event always fits into an empty backlog.
            Some(b) if b.bytes > 0 && b.bytes + msg.len() > CONN_QUEUE => {
                b.cancel.store(true, Ordering::Relaxed);
                a.viewer.outq.close();
                false
            }
            Some(b) => {
                b.bytes += msg.len();
                b.lines.push(msg.clone());
                true
            }
        });
        viewers.len() != before
    }

    /// Attaches a connection: its `ok`, the replay and `acp.replayed` are sent by a pump
    /// task, and live events wait in its backlog until the pump is done (10-hub §7.9).
    fn open(&mut self, o: Open, new: bool) {
        self.open_with_config_errors(o, new, Vec::new());
    }

    fn open_with_config_errors(&mut self, o: Open, new: bool, config_errors: Vec<ConfigError>) {
        let Open {
            viewer,
            since,
            epoch,
            reply,
            ..
        } = o;
        let head = self.journal.as_ref().map_or(0, Journal::len);
        let reset = since > head || epoch.is_some_and(|e| e != self.created_at);
        let since = if reset { 0 } else { since };
        let cancel = Arc::new(AtomicBool::new(false));
        let (conn, outq) = (viewer.id, viewer.outq.clone());
        {
            let mut viewers = lock(&self.shared.viewers);
            if let Some(i) = viewers.iter().position(|a| a.viewer.id == conn) {
                stop(viewers.remove(i));
            }
            viewers.push(Attached {
                viewer,
                backlog: Some(Backlog {
                    lines: Vec::new(),
                    bytes: 0,
                    cancel: cancel.clone(),
                }),
            });
        }
        self.publish();
        let (summary, session) = self.snapshot(self.updated_at);
        let ok = AcpOpenReply {
            new,
            summary,
            session,
            head,
            from: since + 1,
            reset,
            config_errors,
        };
        let pump = Pump {
            sid: self.sid.clone(),
            path: self.path("jsonl"),
            offset: self.journal.as_ref().map_or(0, |j| j.replay_offset(since)),
            since,
            pinned: self.facts.pending.iter().map(|p| p.req).collect(),
            ok,
            reply,
            outq,
            conn,
            cancel,
            done: self.replayed_tx.clone(),
        };
        tokio::spawn(pump.run());
    }

    /// A pump finished: the connection's backlog follows its replay, and it is live.
    fn replayed(&mut self, r: &Replayed) {
        let dropped = {
            let mut viewers = lock(&self.shared.viewers);
            let Some(i) = viewers.iter().position(|a| {
                a.viewer.id == r.conn
                    && a.backlog
                        .as_ref()
                        .is_some_and(|b| Arc::ptr_eq(&b.cancel, &r.cancel))
            }) else {
                return;
            };
            let flushed = r.ok && {
                let a = &mut viewers[i];
                let lines = a.backlog.take().map(|b| b.lines).unwrap_or_default();
                lines
                    .into_iter()
                    .all(|l| a.viewer.outq.push_event(l).is_ok())
            };
            if !flushed {
                stop(viewers.remove(i));
            }
            !flushed
        };
        if dropped {
            self.publish();
        }
    }

    fn detach(&mut self, conn: ConnId) {
        let detached = {
            let mut viewers = lock(&self.shared.viewers);
            let i = viewers.iter().position(|a| a.viewer.id == conn);
            i.map(|i| stop(viewers.remove(i))).is_some()
        };
        if detached {
            self.publish();
        }
    }

    fn act(&mut self, act: Act, reply: Reply) {
        if self.startup_config.is_some()
            && matches!(
                &act,
                Act::Prompt(_)
                    | Act::Cancel
                    | Act::SetMode(_)
                    | Act::SetConfigOption { .. }
                    | Act::Revive
                    | Act::Authenticate(_)
            )
        {
            if !matches!(act, Act::Revive | Act::Authenticate(_)) && self.draining() {
                return reply.err(ErrorCode::NotAlive, NOT_RUNNING);
            }
            return reply.err(ErrorCode::Busy, "startup configuration is being applied");
        }
        match act {
            #[cfg(test)]
            Act::Panic => panic!("test actor panic"),
            Act::Prompt(blocks) => self.prompt(blocks, reply),
            Act::Cancel => self.cancel(reply),
            Act::Permission {
                req,
                epoch,
                outcome,
            } => self.answer(req, epoch, PendingKind::Permission, outcome, reply),
            Act::Elicitation {
                req,
                epoch,
                response,
            } => self.answer(req, epoch, PendingKind::Elicitation, response, reply),
            Act::SetMode(mode_id) => self.set_mode(mode_id, reply),
            Act::SetPolicy { epoch, policy } => self.set_policy(epoch, policy, reply),
            Act::SetConfigOption {
                epoch,
                config_id,
                value,
            } => {
                self.set_config_option(epoch, config_id, value, reply);
            }
            Act::SetTask(task) => match checked_task(task) {
                Err(msg) => reply.err(ErrorCode::BadRequest, msg),
                Ok(task) => {
                    if self.record(EventBody::Task { task }) {
                        reply.done();
                    } else {
                        reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
                    }
                }
            },
            Act::Seen(seq) => {
                self.set_seen(seq);
                reply.done();
            }
            Act::Revive => self.revive(reply),
            Act::Authenticate(method_id) => self.authenticate(&method_id, reply),
            Act::Kill { forget } => self.kill(forget, reply),
            Act::RemoveWorktree => self.remove_worktree(reply),
        }
    }

    /// Still collecting the final output or wait status, not accepting new agent work.
    fn draining(&self) -> bool {
        self.proc
            .as_ref()
            .is_some_and(|p| p.status.is_some() || p.eof)
    }

    /// Refuses an action on a session without a working agent and ACP session; the
    /// error, if any.
    fn check_live(&self) -> Result<(), (ErrorCode, &'static str)> {
        if self.fault.is_some() {
            Err((ErrorCode::Faulted, "the session has a fault"))
        } else if self.proc.is_none() || self.stage.is_some() || self.draining() {
            Err((ErrorCode::NotAlive, NOT_RUNNING))
        } else if !self.has_session {
            Err((
                ErrorCode::BadRequest,
                "no ACP session: authenticate or revive",
            ))
        } else {
            Ok(())
        }
    }

    fn prompt(&mut self, blocks: Vec<Value>, reply: Reply) {
        if let Err((code, msg)) = self.check_live() {
            return reply.err(code, msg);
        }
        if self.facts.activity != Activity::None {
            return reply.err(ErrorCode::Busy, "a turn is running");
        }
        let caps = self
            .meta
            .init
            .as_ref()
            .and_then(|i| i.pointer("/agentCapabilities/promptCapabilities"));
        if let Err(msg) = check_prompt(&blocks, caps) {
            return reply.err(ErrorCode::BadRequest, msg);
        }
        let session = self.facts.agent_session_id.clone().unwrap_or_default();
        if !self.record(EventBody::Prompt {
            prompt: blocks.clone(),
        }) {
            return reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
        }
        self.turn_cancelled = false;
        self.set_seen(self.facts.head_seq);
        match self.request(Purpose::Prompt, |id| rpc::prompt(id, &session, blocks)) {
            Ok(()) => reply.done(),
            Err(_) => {
                if self.record(EventBody::TurnError {
                    code: TurnErrorCode::AgentError,
                    message: ENQUEUE_FAILED.into(),
                    rpc: None,
                }) {
                    reply.err(ErrorCode::Internal, ENQUEUE_FAILED);
                } else {
                    reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
                }
            }
        }
    }

    fn cancel(&mut self, reply: Reply) {
        if self.draining() {
            return reply.err(ErrorCode::NotAlive, NOT_RUNNING);
        }
        let mut queued = true;
        if self.facts.activity == Activity::Turn {
            self.turn_cancelled = true;
            if let Some(session) = &self.facts.agent_session_id {
                queued = self.send(&rpc::cancel(session));
            }
        }
        while let Some((&req, held)) = self.held.first_key_value() {
            match self.resolve(req, cancelled(held.kind), ResolvedBy::Cancel) {
                Some(sent) => queued &= sent,
                None => return reply.err(ErrorCode::Faulted, JOURNAL_FAILED),
            }
        }
        self.set_seen(self.facts.head_seq);
        if queued {
            reply.done();
        } else {
            reply.err(ErrorCode::Internal, ENQUEUE_FAILED);
        }
    }

    /// `acp.permission` and `acp.elicitation`: the first answer wins.
    fn answer(&mut self, req: u64, epoch: u64, kind: PendingKind, answer: Value, reply: Reply) {
        if epoch != self.created_at {
            return reply.err(ErrorCode::Stale, "the session was created again");
        }
        let name = match kind {
            PendingKind::Permission => "permission",
            _ => "elicitation",
        };
        let Some(held) = self.held.get(&req).filter(|h| h.kind == kind) else {
            return match self.announced.get(&req) {
                Some(k) if *k == kind => reply.err(
                    ErrorCode::AlreadyResolved,
                    format!("{name} {req} was already answered"),
                ),
                _ => reply.err(ErrorCode::BadRequest, format!("no {name} {req}")),
            };
        };
        if self.draining() {
            return reply.err(ErrorCode::NotAlive, NOT_RUNNING);
        }
        let checked = match kind {
            PendingKind::Permission => check_outcome(&answer, &held.option_ids),
            _ => check_response(&answer),
        };
        if let Err((code, msg)) = checked {
            return reply.err(code, msg);
        }
        let Some(queued) = self.resolve(req, answer, ResolvedBy::User) else {
            return reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
        };
        self.set_seen(self.facts.head_seq);
        if queued {
            reply.done();
        } else {
            reply.err(
                ErrorCode::Internal,
                "agent input was not queued; the answer is already recorded and final",
            );
        }
    }

    /// None if not resolved; otherwise whether the journaled answer was queued.
    fn resolve(&mut self, req: u64, answer: Value, by: ResolvedBy) -> Option<bool> {
        let kind = self.held.get(&req)?.kind;
        let body = match kind {
            PendingKind::Permission => EventBody::PermissionResolved {
                req,
                outcome: answer.clone(),
                by,
            },
            _ => EventBody::ElicitationResolved {
                req,
                response: answer.clone(),
                by,
            },
        };
        if !self.record(body) {
            return None;
        }
        let held = self
            .held
            .remove(&req)
            .expect("just journaled a held answer");
        let queued = self.send(&rpc::result(&held.rpc_id, to_agent(kind, answer)));
        if self.held.is_empty() {
            // Deviation 8: the setup clock restarts once nobody is waited for.
            self.setup_at = Some(Instant::now() + SETUP_IDLE_TIMEOUT);
        }
        Some(queued)
    }
    fn set_policy(&mut self, epoch: u64, policy: Policy, reply: Reply) {
        if epoch != self.created_at {
            return reply.err(ErrorCode::Stale, "the session was created again");
        }
        if self.fault.is_some() {
            return reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
        }
        let compiled = match CompiledPolicy::new(&policy, &self.meta.cwd, self.meta.agent == "omp")
        {
            Ok(compiled) => compiled,
            Err(message) => return reply.err(ErrorCode::BadRequest, message),
        };
        if !self.record(EventBody::Policy { policy }) {
            return reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
        }
        self.policy = Some(compiled);
        reply.done();
    }

    fn set_mode(&mut self, mode_id: String, reply: Reply) {
        if let Err((code, msg)) = self.check_live() {
            return reply.err(code, msg);
        }
        let modes = self
            .facts
            .modes
            .as_ref()
            .and_then(|m| m.get("availableModes"));
        let offered = modes.and_then(Value::as_array).is_some_and(|ms| {
            ms.iter()
                .any(|m| m.get("id").and_then(Value::as_str) == Some(mode_id.as_str()))
        });
        if !offered {
            return reply.err(
                ErrorCode::BadOption,
                format!("mode {mode_id} is not offered"),
            );
        }
        let session = self.facts.agent_session_id.clone().unwrap_or_default();
        let msg = |id| rpc::set_mode(id, &session, &mode_id);
        let purpose = Purpose::SetMode {
            mode_id: mode_id.clone(),
            reply,
            deadline: Instant::now() + SET_MODE_TIMEOUT,
        };
        let sent = self.request(purpose, msg);
        if let Err(purpose) = sent {
            purpose.fail(ErrorCode::Internal, "agent not reading stdin");
        }
    }

    fn set_config_option(&mut self, epoch: u64, config_id: String, value: Value, reply: Reply) {
        if let Err((code, msg)) = self.check_live() {
            return reply.err(code, msg);
        }
        if epoch != self.created_at {
            return reply.err(ErrorCode::Stale, "the session was created again");
        }
        if let Err((code, message)) = self.check_config_option(&config_id, &value) {
            return reply.err(code, message);
        }
        let session = self.facts.agent_session_id.clone().unwrap_or_default();
        let purpose = Purpose::SetConfigOption {
            reply,
            deadline: Instant::now() + SET_CONFIG_TIMEOUT,
        };
        if let Err(purpose) = self.request(purpose, |id| {
            rpc::set_config_option(id, &session, &config_id, &value)
        }) {
            purpose.fail(ErrorCode::Internal, "agent not reading stdin");
        }
    }

    fn check_config_option(
        &self,
        config_id: &str,
        value: &Value,
    ) -> Result<(), (ErrorCode, String)> {
        let offered = self
            .facts
            .config_options
            .as_ref()
            .and_then(Value::as_array)
            .and_then(|options| {
                options
                    .iter()
                    .find(|option| option["id"].as_str() == Some(config_id))
            });
        let valid = offered.is_some_and(|option| match option["type"].as_str() {
            Some("boolean") => value.is_boolean(),
            Some("select") => value.as_str().is_some_and(|value| {
                option["options"].as_array().is_some_and(|options| {
                    options.iter().any(|option| {
                        option["value"].as_str() == Some(value)
                            || option["options"].as_array().is_some_and(|group| {
                                group
                                    .iter()
                                    .any(|option| option["value"].as_str() == Some(value))
                            })
                    })
                })
            }),
            _ => false,
        });
        if !valid {
            return Err((
                ErrorCode::BadOption,
                format!("configuration {config_id} or its value is not offered"),
            ));
        }
        Ok(())
    }

    fn advance_startup_config(&mut self) {
        if self.draining() {
            return self.fail_startup_config(ErrorCode::NotAlive, NOT_RUNNING);
        }
        let Some(batch) = &mut self.startup_config else {
            return;
        };
        let Some(option) = batch.remaining.pop_front() else {
            let batch = self.startup_config.take().unwrap();
            return self.open_with_config_errors(batch.open, true, batch.errors);
        };
        let value = match &option.value {
            wb_proto::hub::ConfigValue::String(value) => Value::String(value.clone()),
            wb_proto::hub::ConfigValue::Boolean(value) => Value::Bool(*value),
        };
        let config_id = option.id.clone();
        batch.current = Some(option);
        if let Err(error) = self.check_config_option(&config_id, &value) {
            return self.startup_config_result(Err(error));
        }
        let session = self.facts.agent_session_id.clone().unwrap_or_default();
        let purpose = Purpose::StartupConfig {
            deadline: Instant::now() + SET_CONFIG_TIMEOUT,
        };
        if self
            .request(purpose, |id| {
                rpc::set_config_option(id, &session, &config_id, &value)
            })
            .is_err()
        {
            self.startup_config_result(Err((
                ErrorCode::Internal,
                "agent not reading stdin".into(),
            )));
        }
    }

    fn startup_config_result(&mut self, result: Result<(), (ErrorCode, String)>) {
        let Some(option) = self
            .startup_config
            .as_ref()
            .and_then(|batch| batch.current.as_ref())
        else {
            return;
        };
        let failure = result.err();
        if let Some((code, error)) = &failure {
            let text = format!(
                "startup configuration {} failed ({code:?}): {error}",
                option.id
            );
            if !self.record(EventBody::Notice {
                level: NoticeLevel::Warn,
                text,
            }) {
                return;
            }
            if let Some(journal) = &self.journal {
                drop(journal.sync());
            }
        }
        let Some(batch) = &mut self.startup_config else {
            return;
        };
        let Some(option) = batch.current.take() else {
            return;
        };
        if let Some((code, error)) = failure {
            batch.errors.push(ConfigError {
                id: option.id,
                value: option.value,
                code,
                error,
            });
        }
        self.advance_startup_config();
    }

    /// Releases the accepted creating open, accounting for every unapplied entry.
    fn fail_startup_config(&mut self, code: ErrorCode, error: &str) {
        let Some(mut batch) = self.startup_config.take() else {
            return;
        };
        if let Some(p) = &mut self.proc {
            p.outstanding
                .retain(|_, purpose| !matches!(purpose, Purpose::StartupConfig { .. }));
        }
        for option in batch.current.into_iter().chain(batch.remaining) {
            if self.record(EventBody::Notice {
                level: NoticeLevel::Warn,
                text: format!(
                    "startup configuration {} failed ({code:?}): {error}",
                    option.id
                ),
            }) && let Some(journal) = &self.journal
            {
                drop(journal.sync());
            }
            batch.errors.push(ConfigError {
                id: option.id,
                value: option.value,
                code,
                error: error.to_owned(),
            });
        }
        self.open_with_config_errors(batch.open, true, batch.errors);
    }

    fn config_result(&mut self, outcome: Result<Value, Value>) -> Result<(), (ErrorCode, String)> {
        if self.fault.is_some() {
            return Err((ErrorCode::Faulted, JOURNAL_FAILED.into()));
        }
        if self.stage.is_some() {
            return Err((ErrorCode::NotAlive, "the agent is being stopped".into()));
        }
        let result = outcome.map_err(|error| (ErrorCode::AgentError, rpc_message(&error)))?;
        let Some(options) = result
            .get("configOptions")
            .filter(|options| config::valid_options(options))
        else {
            return Err((
                ErrorCode::AgentError,
                "the session/set_config_option result has invalid configOptions".into(),
            ));
        };
        if self.record(EventBody::Config {
            config_options: options.clone(),
        }) {
            Ok(())
        } else {
            Err((ErrorCode::Faulted, JOURNAL_FAILED.into()))
        }
    }

    /// `seenSeq = max(seenSeq, min(seq, headSeq))`, saved within 2 s.
    fn set_seen(&mut self, seq: u64) {
        let seen = self.meta.seen_seq.max(seq.min(self.facts.head_seq));
        if seen == self.meta.seen_seq {
            return;
        }
        self.meta.seen_seq = seen;
        let at = Instant::now() + SEEN_SAVE;
        self.meta_at = Some(self.meta_at.map_or(at, |t| t.min(at)));
        self.publish();
    }

    /// Saves the session record at the next turn of the loop.
    fn save_meta_soon(&mut self) {
        self.meta_at = Some(Instant::now());
    }

    async fn save_meta(&mut self) {
        if let Err(e) = self.write_meta().await {
            warn!("writing the session record: {e}");
        }
    }

    async fn write_meta(&mut self) -> io::Result<()> {
        self.meta_at = None;
        // Never replace an unreadable record with the faulted actor's default metadata.
        if self.journal.is_none() {
            return Ok(());
        }
        let json = serde_json::to_vec(&self.meta)?;
        let (dir, name) = (self.ctx.acp_dir.clone(), format!("{}.json", self.sid));
        tokio::task::spawn_blocking(move || write_atomic(&dir, &name, &json))
            .await
            .map_err(io::Error::other)?
    }

    fn revive(&mut self, reply: Reply) {
        self.probe();
        if self.fault.is_some() {
            return reply.err(ErrorCode::Faulted, "the session has a fault");
        }
        if self.proc.is_none() && self.meta.host.is_none() && !Path::new(&self.meta.cwd).is_dir() {
            return reply.err(
                ErrorCode::NotRevivable,
                format!(
                    "session working directory no longer exists: {}",
                    self.meta.cwd
                ),
            );
        }
        if self.proc.is_some() || !self.facts.revivable(self.meta.init.as_ref()) {
            return reply.err(ErrorCode::NotRevivable, "the session cannot be revived");
        }
        self.set_seen(self.facts.head_seq);
        match self.spawn(SpawnVia::Revive) {
            Ok(()) => reply.done(),
            Err((code, message)) => reply.err(code, message),
        }
    }

    fn authenticate(&mut self, method_id: &str, reply: Reply) {
        let method = self
            .auth_methods()
            .find(|m| m.get("id").and_then(Value::as_str) == Some(method_id));
        match method {
            None => {
                let msg = format!("auth method {method_id} is not offered");
                return reply.err(ErrorCode::BadOption, msg);
            }
            Some(m) if m.get("type").is_some() => {
                let msg = "this method needs a terminal: log in from a terminal card, then start a new session";
                return reply.err(ErrorCode::BadOption, msg);
            }
            Some(_) => {}
        }
        if self.fault.is_some() {
            return reply.err(ErrorCode::Faulted, "the session has a fault");
        }
        if self.proc.is_none()
            || self.stage.is_some()
            || self.facts.activity != Activity::None
            || self.has_session
        {
            return reply.err(
                ErrorCode::BadRequest,
                "authenticate only after a failed setup",
            );
        }
        if self.draining() {
            return reply.err(ErrorCode::NotAlive, NOT_RUNNING);
        }
        if !self.record(EventBody::Authenticate {
            method_id: method_id.to_owned(),
        }) {
            return reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
        }
        self.set_seen(self.facts.head_seq);
        self.setup_at = Some(Instant::now() + SETUP_IDLE_TIMEOUT);
        let sent = self.request(Purpose::Authenticate(reply), |id| {
            rpc::authenticate(id, method_id)
        });
        if let Err(purpose) = sent {
            purpose.fail(ErrorCode::Internal, "agent not reading stdin");
        }
    }

    fn kill(&mut self, forget: bool, reply: Reply) {
        self.probe();
        if self.proc.is_some() {
            self.stop_agent(Cause::User);
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

    fn rollback(&mut self, record: ManagedWorktree, reply: Reply, failure: CreateFailure) {
        let op = WorktreeOp::Rollback {
            reply,
            failure,
            path: record.path.clone(),
        };
        self.start_remove(op, record);
    }

    fn start_remove(&mut self, op: WorktreeOp, record: ManagedWorktree) {
        let ctx = self.ctx.clone();
        let sid = self.sid.clone();
        self.worktree_op = Some(op);
        self.git.spawn(async move {
            let git = worktree::Git {
                program: ctx.cfg.git.as_deref().expect("configured worktree removal"),
                reaper: &ctx.reaper,
            };
            WorktreeResult::Removed(worktree::remove(git, &record, &sid).await)
        });
    }

    fn remove_worktree(&mut self, reply: Reply) {
        if self.journal.is_none() {
            return reply.err(ErrorCode::Faulted, "the session has no journal writer");
        }
        let Some(record) = &self.meta.managed_worktree else {
            return reply.err(ErrorCode::NotFound, "the session has no managed worktree");
        };
        if self.proc.is_some() {
            return reply.err(ErrorCode::Conflict, "the agent is still running");
        }
        if self.ctx.cfg.git.is_none() {
            return reply.err(ErrorCode::BadRequest, NO_WORKTREE_GIT);
        }
        self.start_remove(WorktreeOp::Remove(reply), record.clone());
    }

    async fn worktree_done(&mut self, joined: Result<WorktreeResult, JoinError>) {
        use WorktreeResult::{Created, Removed};
        let op = self
            .worktree_op
            .take()
            .expect("git completion without a request");
        let result = joined.unwrap_or_else(|e| {
            let error = (ErrorCode::Internal, format!("git task failed: {e}"));
            match op {
                // A failed task cannot attest to cleanup of its private checkout.
                WorktreeOp::Create { .. } => Created(Err(PossibleLeftover(error))),
                WorktreeOp::Rollback { .. } | WorktreeOp::Remove(_) => Removed(Err(error)),
            }
        });
        match (op, result) {
            (WorktreeOp::Create { open, .. }, Created(Ok(record))) => {
                if self.create_kill.is_none() {
                    self.finish_create(open, Some(record)).await;
                } else {
                    // The add won its race with cancellation. Undo the owned checkout
                    // before releasing the sid or answering either request.
                    self.rollback(
                        record,
                        open.reply,
                        Clean((ErrorCode::Conflict, worktree::CANCELLED.into())),
                    );
                }
            }
            (WorktreeOp::Create { open, .. }, Created(Err(failure))) => {
                self.abandon(open.reply, failure);
            }
            (
                WorktreeOp::Rollback {
                    reply,
                    failure,
                    path,
                },
                Removed(result),
            ) => {
                let leftover = match result {
                    Ok(true) => return self.abandon(reply, failure),
                    Ok(false) => format!("worktree at {path} no longer owned; nothing deleted"),
                    Err((_, error)) => format!("worktree left at {path}: {error}"),
                };
                let (Clean((code, message)) | PossibleLeftover((code, message))) = failure;
                self.abandon(
                    reply,
                    PossibleLeftover((code, format!("{message}; {leftover}"))),
                );
            }
            (WorktreeOp::Remove(reply), Removed(Ok(deleted))) => {
                self.removed(reply, deleted).await;
            }
            (WorktreeOp::Remove(reply), Removed(Err((code, message)))) => reply.err(code, message),
            _ => unreachable!("git result does not match request"),
        }
    }

    async fn removed(&mut self, reply: Reply, deleted: bool) {
        let record = self.meta.managed_worktree.take();
        let meta_at = self.meta_at;
        if let Err(e) = self.write_meta().await {
            // Preserve the last committed record so the caller can retry the clear.
            self.meta.managed_worktree = record;
            self.meta_at = meta_at;
            let state = if deleted {
                "worktree removed"
            } else {
                "session worktree already gone; nothing deleted"
            };
            return reply.err(
                ErrorCode::Internal,
                format!("{state}, but writing the session record failed: {e}"),
            );
        }
        self.publish();
        if deleted {
            reply.done();
        } else {
            reply.err(
                ErrorCode::NotFound,
                "session worktree already gone; record cleared; nothing deleted",
            );
        }
    }

    /// The hub is stopping: close the agent's stdin so it saves its own state, then
    /// SIGTERM and SIGKILL its group (10-hub §8).
    async fn shutdown(&mut self, done: oneshot::Sender<()>) {
        self.stopping = Some(done);
        if let Some(op) = self.worktree_op.take() {
            // Wait for the aborted future to drop its git process-group guard before
            // acknowledging shutdown; never wait for the git command's own timeout.
            self.git.shutdown().await;
            let reply = match op {
                WorktreeOp::Create { open, .. } => open.reply,
                WorktreeOp::Remove(reply) | WorktreeOp::Rollback { reply, .. } => reply,
            };
            reply.err(ErrorCode::Internal, "hub stopping");
            if let Some(reply) = self.create_kill.take() {
                reply.err(ErrorCode::Internal, "hub stopping");
            }
        }
        if self.proc.is_none() {
            self.phase = Phase::Stopped;
        } else if matches!(self.stage, None | Some((Stage::Close, _))) {
            self.enter(Stage::Stdin);
        }
        self.fail_startup_config(ErrorCode::NotAlive, "the hub is stopping");
    }

    /// Starts ending the agent in stages (DESIGN §3.4.5). A no-op when there is no agent
    /// or it is being ended already, by a kill or a hub stop.
    fn stop_agent(&mut self, cause: Cause) {
        if self.proc.is_none() || self.stage.is_some() {
            return;
        }
        self.cause = Some(cause);
        let close =
            self.has_session && self.advertised("/agentCapabilities/sessionCapabilities/close");
        self.enter(if close { Stage::Close } else { Stage::Stdin });
        self.fail_startup_config(
            if cause == Cause::Fault {
                ErrorCode::Faulted
            } else {
                ErrorCode::NotAlive
            },
            if cause == Cause::Fault {
                JOURNAL_FAILED
            } else {
                "the agent is being stopped"
            },
        );
    }

    fn enter(&mut self, stage: Stage) {
        let stopping = self.stopping.is_some();
        let wait = match stage {
            Stage::Close => {
                let session = self.facts.agent_session_id.clone().unwrap_or_default();
                let _ = self.request(Purpose::Close, |id| rpc::close_session(id, &session));
                Some(CLOSE_WAIT)
            }
            Stage::Stdin => {
                if let Some(p) = &mut self.proc {
                    p.agent.stdin = None;
                }
                Some(if stopping {
                    STOP_STDIN_WAIT
                } else {
                    STDIN_WAIT
                })
            }
            Stage::Term => {
                self.signal(Signal::TERM);
                Some(if stopping { STOP_TERM_WAIT } else { TERM_WAIT })
            }
            Stage::Kill => {
                self.signal(Signal::KILL);
                None
            }
        };
        self.stage = Some((stage, wait.map(|w| Instant::now() + w)));
    }

    fn next_stage(&mut self) {
        let next = match self.stage {
            Some((Stage::Close, _)) => Stage::Stdin,
            Some((Stage::Stdin, _)) => Stage::Term,
            Some((Stage::Term, _)) => Stage::Kill,
            Some((Stage::Kill, _)) | None => return,
        };
        self.enter(next);
    }

    /// Staged signals stop at observed exit; finalise handles the surviving group.
    fn signal(&self, sig: Signal) {
        if let Some(p) = self.proc.as_ref().filter(|p| p.status.is_none()) {
            p.agent.signal(sig);
        }
    }

    /// The setup clock runs: a setup step is outstanding and no request waits for a
    /// viewer (deviation 8).
    fn setup_waiting(&self) -> bool {
        self.proc.is_some()
            && self.stage.is_none()
            && self.facts.activity == Activity::Setup
            && self.held.is_empty()
    }

    fn rpc_deadline(&self) -> Option<Instant> {
        let p = self.proc.as_ref()?;
        p.outstanding
            .values()
            .filter_map(|purpose| match purpose {
                Purpose::SetMode { deadline, .. }
                | Purpose::SetConfigOption { deadline, .. }
                | Purpose::StartupConfig { deadline } => Some(*deadline),
                _ => None,
            })
            .min()
    }

    fn rpc_timeout(&mut self) {
        let now = Instant::now();
        let Some(p) = &mut self.proc else { return };
        let late: Vec<u64> = p
            .outstanding
            .iter()
            .filter(|(_, purpose)| matches!(purpose, Purpose::SetMode { deadline, .. } | Purpose::SetConfigOption { deadline, .. } | Purpose::StartupConfig { deadline } if *deadline <= now))
            .map(|(id, _)| *id)
            .collect();
        let late: Vec<Purpose> = late
            .into_iter()
            .filter_map(|id| p.outstanding.remove(&id))
            .collect();
        for purpose in late {
            if matches!(purpose, Purpose::StartupConfig { .. }) {
                self.startup_config_result(Err((
                    ErrorCode::Timeout,
                    "the agent did not answer session/set_config_option in 30 s".into(),
                )));
            } else {
                let method = match &purpose {
                    Purpose::SetConfigOption { .. } => "session/set_config_option",
                    _ => "session/set_mode",
                };
                purpose.fail(
                    ErrorCode::Timeout,
                    &format!("the agent did not answer {method} in 30 s"),
                );
            }
        }
    }

    fn setup_timeout(&mut self) {
        self.setup_at = None;
        let msg = format!(
            "the agent sent nothing for {} s during setup",
            SETUP_IDLE_TIMEOUT.as_secs()
        );
        if let Some(p) = &mut self.proc {
            let auth: Vec<u64> = p
                .outstanding
                .iter()
                .filter(|(_, purpose)| matches!(purpose, Purpose::Authenticate(_)))
                .map(|(id, _)| *id)
                .collect();
            for id in auth {
                if let Some(purpose) = p.outstanding.remove(&id) {
                    purpose.fail(ErrorCode::Timeout, &msg);
                }
            }
        }
        self.record(EventBody::SetupError {
            code: SetupErrorCode::Timeout,
            message: msg,
            rpc: None,
        });
        self.stop_failed_setup();
    }

    async fn agent_message(&mut self, msg: Map<String, Value>) {
        self.setup_at = Some(Instant::now() + SETUP_IDLE_TIMEOUT);
        match rpc::classify(msg) {
            Incoming::Response { id, outcome } => {
                match self.proc.as_mut().and_then(|p| p.outstanding.remove(&id)) {
                    Some(purpose) => self.response(purpose, outcome),
                    None => self.log(&format!("dropped a response to unknown id {id}")),
                }
            }
            Incoming::Request { id, method, params } => {
                self.agent_request(id, &method, params).await
            }
            Incoming::Notification { method, params } => self.notification(&method, params),
            Incoming::Dropped(why) => self.log(&format!("dropped {why}")),
            Incoming::Junk(m) => {
                if let Some(p) = &self.proc {
                    p.agent.log.stdout(Value::Object(m).to_string().as_bytes());
                }
            }
        }
    }

    fn response(&mut self, purpose: Purpose, outcome: Result<Value, Value>) {
        if self.stage.is_some() && matches!(purpose, Purpose::Init | Purpose::Session(_)) {
            // The agent is being ended; its setup goes no further.
            return;
        }
        match purpose {
            Purpose::Init => match outcome {
                Ok(init) => self.initialized(init),
                Err(e) => self.setup_failed(e),
            },
            Purpose::Session(via) => self.session_result(via, outcome),
            Purpose::Prompt => {
                let body = match outcome {
                    Ok(r) => match r.get("stopReason").and_then(Value::as_str) {
                        Some(stop) => EventBody::TurnEnd {
                            stop_reason: stop.to_owned(),
                        },
                        None => EventBody::TurnError {
                            code: TurnErrorCode::AgentError,
                            message: "the prompt response has no stopReason".into(),
                            rpc: None,
                        },
                    },
                    Err(e) => EventBody::TurnError {
                        code: TurnErrorCode::AgentError,
                        message: rpc_message(&e),
                        rpc: Some(e),
                    },
                };
                self.record(body);
            }
            Purpose::SetMode { mode_id, reply, .. } => match outcome {
                Ok(_) if self.record(EventBody::Mode { mode_id }) => reply.done(),
                Ok(_) => reply.err(ErrorCode::Faulted, JOURNAL_FAILED),
                Err(e) => reply.err(ErrorCode::AgentError, rpc_message(&e)),
            },
            Purpose::SetConfigOption { reply, .. } => match self.config_result(outcome) {
                Ok(()) => reply.done(),
                Err((code, message)) => reply.err(code, message),
            },
            Purpose::StartupConfig { .. } => {
                let result = self.config_result(outcome);
                self.startup_config_result(result);
            }
            Purpose::Authenticate(reply) => match outcome {
                Ok(_) if self.stage.is_some() => {
                    reply.err(ErrorCode::NotAlive, "the agent is being stopped");
                }
                Ok(_) => {
                    reply.done();
                    self.open_session();
                }
                Err(e) => {
                    reply.err(ErrorCode::AgentError, rpc_message(&e));
                    self.record(EventBody::SetupError {
                        code: SetupErrorCode::AgentError,
                        message: rpc_message(&e),
                        rpc: Some(e),
                    });
                    self.stop_failed_setup();
                }
            },
            Purpose::Close => {
                if matches!(self.stage, Some((Stage::Close, _))) {
                    self.enter(Stage::Stdin);
                }
            }
        }
    }

    /// The `initialize` result: ACP v1, stored as `meta.init`, then the session step.
    fn initialized(&mut self, init: Value) {
        let version = init.get("protocolVersion").cloned().unwrap_or(Value::Null);
        if version.as_u64() != Some(rpc::PROTOCOL_VERSION) {
            self.record(EventBody::SetupError {
                code: SetupErrorCode::AgentError,
                message: format!("agent speaks ACP v{version}"),
                rpc: None,
            });
            return self.stop_failed_setup();
        }
        self.meta.init = Some(init);
        self.save_meta_soon();
        self.publish();
        self.open_session();
    }

    /// The setup step after `initialize` or a successful `authenticate`: `session/new`
    /// for a new agent, `session/resume` or `session/load` for a revive.
    fn open_session(&mut self) {
        match self.proc.as_ref().map(|p| p.via) {
            Some(SpawnVia::Revive) => self.revive_step(None),
            Some(_) => self.session_request(SessionVia::New),
            None => {}
        }
    }

    /// The next way to restore the session after `failed` did not work: resume, then
    /// load, then `setup_error{revive_failed}`.
    fn revive_step(&mut self, failed: Option<(SessionVia, Value)>) {
        let resume =
            failed.is_none() && self.advertised("/agentCapabilities/sessionCapabilities/resume");
        let load = !matches!(failed, Some((SessionVia::Load, _)))
            && self.advertised("/agentCapabilities/loadSession");
        if resume {
            self.session_request(SessionVia::Resume);
        } else if load {
            self.session_request(SessionVia::Load);
        } else {
            let (message, rpc) = match failed {
                Some((via, e)) => (
                    format!("session/{} failed: {}", via_name(via), rpc_message(&e)),
                    Some(e),
                ),
                None => (
                    "the agent offers neither session/resume nor session/load".into(),
                    None,
                ),
            };
            self.record(EventBody::SetupError {
                code: SetupErrorCode::ReviveFailed,
                message,
                rpc,
            });
            self.stop_failed_setup();
        }
    }

    fn session_request(&mut self, via: SessionVia) {
        // Keep the response that got us here, but don't start session/new,
        // resume or a fallback load while collecting the agent's final output.
        if self.draining() {
            return self.fail_startup_config(ErrorCode::NotAlive, NOT_RUNNING);
        }
        let cwd = self.meta.cwd.clone();
        let session = self.facts.agent_session_id.clone().unwrap_or_default();
        self.load_filter = via == SessionVia::Load;
        let _ = self.request(Purpose::Session(via), |id| match via {
            SessionVia::Resume => rpc::resume_session(id, &session, &cwd),
            SessionVia::Load => rpc::load_session(id, &session, &cwd),
            _ => rpc::new_session(id, &cwd),
        });
    }

    fn session_result(&mut self, via: SessionVia, outcome: Result<Value, Value>) {
        self.load_filter = false;
        let result = match outcome {
            Ok(result) => result,
            Err(e) if via == SessionVia::New || rpc_code(&e) == Some(AUTH_REQUIRED) => {
                return self.setup_failed(e);
            }
            Err(e) => return self.revive_step(Some((via, e))),
        };
        // Only `session/new` names the session; resume and load keep the known one.
        let session_id = match via {
            SessionVia::New => result
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            _ => self.facts.agent_session_id.clone(),
        };
        let Some(session_id) = session_id else {
            self.record(EventBody::SetupError {
                code: SetupErrorCode::AgentError,
                message: format!("the session/{} result has no sessionId", via_name(via)),
                rpc: None,
            });
            return self.stop_failed_setup();
        };
        let field = |key: &str| result.get(key).filter(|v| !v.is_null()).cloned();
        let recorded = self.record(EventBody::Session {
            via,
            session_id: session_id.clone(),
            modes: field("modes"),
            config_options: result
                .get("configOptions")
                .filter(|options| config::valid_options(options))
                .cloned(),
        });
        if !recorded {
            return;
        }
        self.meta.agent_session_id = Some(session_id);
        self.save_meta_soon();
        if via != SessionVia::New {
            self.record(EventBody::Notice {
                level: NoticeLevel::Info,
                text: format!("revived via session/{}", via_name(via)),
            });
        }
        if via == SessionVia::New && self.startup_config.is_some() {
            self.advance_startup_config();
        }
    }

    /// A setup step failed with the JSON-RPC error `e`. An auth error with an
    /// agent-handled method keeps the agent for `acp.authenticate`; anything else stops
    /// it (deviation 9).
    fn setup_failed(&mut self, e: Value) {
        let auth = rpc_code(&e) == Some(AUTH_REQUIRED);
        let code = if auth {
            SetupErrorCode::AuthRequired
        } else {
            SetupErrorCode::AgentError
        };
        self.record(EventBody::SetupError {
            code,
            message: rpc_message(&e),
            rpc: Some(e),
        });
        let agent_handled = self.auth_methods().any(|m| m.get("type").is_none());
        if !(auth && agent_handled) {
            self.stop_failed_setup();
        }
    }

    fn stop_failed_setup(&mut self) {
        self.record(EventBody::Notice {
            level: NoticeLevel::Warn,
            text: "agent stopped after failed setup".into(),
        });
        self.stop_agent(Cause::Setup);
    }

    async fn agent_request(&mut self, id: Value, method: &str, params: Value) {
        match method {
            "session/request_permission" => {
                let tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                let options = params
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let decision = params
                    .get("sessionId")
                    .filter(|_| self.facts.activity == Activity::Turn && !self.turn_cancelled)
                    .and_then(Value::as_str)
                    .is_some_and(|session| Some(session) == self.facts.agent_session_id.as_deref())
                    .then(|| self.policy.as_ref()?.decide(&tool_call, &options))
                    .flatten();
                if let Some(decision) = decision {
                    let outcome = serde_json::json!({
                        "outcome": "selected", "optionId": decision.option_id,
                    });
                    let policy = PolicyMatch {
                        rule: decision.rule,
                        action: decision.action,
                    };
                    let body = EventBody::PermissionAuto {
                        tool_call,
                        options,
                        outcome: outcome.clone(),
                        policy,
                    };
                    let written = if self.fault.is_none() {
                        self.journal
                            .as_mut()
                            .map(|journal| journal.append(body, now_ms()))
                    } else {
                        None
                    };
                    match written {
                        Some(Ok(ev)) => {
                            self.applied(ev);
                            self.send(&rpc::result(&id, rpc::permission_result(&outcome)));
                        }
                        failure => {
                            // Cancel before journal_fault closes the agent's stdin.
                            self.send(&rpc::result(
                                &id,
                                rpc::permission_result(&rpc::permission_cancelled()),
                            ));
                            if let Some(Err(fault)) = failure {
                                self.journal_fault(&fault);
                            }
                        }
                    }
                    return;
                }
                let option_ids = options
                    .iter()
                    .filter_map(|o| o.get("optionId")?.as_str().map(str::to_owned))
                    .collect();
                let body = EventBody::Permission { tool_call, options };
                self.hold(id, PendingKind::Permission, option_ids, body)
                    .await;
            }
            "elicitation/create" => {
                let body = EventBody::Elicitation { request: params };
                self.hold(id, PendingKind::Elicitation, Vec::new(), body)
                    .await;
            }
            _ => {
                self.log(&format!("answered the agent request {method} with -32601"));
                self.send(&rpc::method_not_found(&id));
            }
        }
    }

    /// Journals an agent request and holds it until a viewer, a cancel, the agent or
    /// the agent's death answers it. A request that cannot be journaled is cancelled.
    async fn hold(
        &mut self,
        rpc_id: Value,
        kind: PendingKind,
        option_ids: Vec<String>,
        body: EventBody,
    ) {
        if self.fault.is_none()
            && let Some(mut journal) = self.journal.take()
        {
            // Wait in this actor only. No replay, answer or later append can overtake the sync.
            let (journal, result) = tokio::task::spawn_blocking(move || {
                let result = journal.append(body, now_ms());
                (journal, result)
            })
            .await
            .expect("journal worker panicked");
            self.journal = Some(journal);
            match result {
                Ok(ev) => {
                    self.held.insert(
                        ev.seq,
                        HeldReq {
                            rpc_id,
                            kind,
                            option_ids,
                        },
                    );
                    self.applied(ev);
                }
                Err(fault) => {
                    self.send(&rpc::result(&rpc_id, to_agent(kind, cancelled(kind))));
                    self.journal_fault(&fault);
                }
            }
        } else {
            self.send(&rpc::result(&rpc_id, to_agent(kind, cancelled(kind))));
        }
    }

    fn notification(&mut self, method: &str, mut params: Value) {
        match method {
            "session/update" => {
                let Some(update) = params.get_mut("update").map(Value::take) else {
                    return self.log("dropped a session/update without update");
                };
                let variant = update.get("sessionUpdate").and_then(Value::as_str);
                if self.load_filter && variant.is_some_and(|v| HISTORY.contains(&v)) {
                    return;
                }
                if variant == Some("config_option_update")
                    && !update
                        .get("configOptions")
                        .is_some_and(config::valid_options)
                {
                    return self.log("dropped a config_option_update with invalid configOptions");
                }
                let session_id = params
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .filter(|s| Some(*s) != self.facts.agent_session_id.as_deref())
                    .map(str::to_owned);
                self.record(EventBody::Update { update, session_id });
            }
            "elicitation/complete" => match params.get("elicitationId").and_then(Value::as_str) {
                Some(id) => {
                    let elicitation_id = id.to_owned();
                    self.record(EventBody::ElicitationComplete { elicitation_id });
                }
                None => self.log("dropped an elicitation/complete without elicitationId"),
            },
            "$/cancel_request" => {
                // Deviation 2: the agent withdrew its own request.
                let Some(id) = params.get("requestId") else {
                    return;
                };
                let held = self.held.iter().find(|(_, h)| &h.rpc_id == id);
                if let Some((req, kind)) = held.map(|(r, h)| (*r, h.kind)) {
                    let _ = self.resolve(req, cancelled(kind), ResolvedBy::Agent);
                }
            }
            _ => self.log(&format!("dropped the notification {method}")),
        }
    }

    fn stdout_closed(&mut self) {
        let Some(p) = &mut self.proc else { return };
        p.eof = true;
        if p.status.is_some() {
            self.finalise();
        } else {
            p.drain_until = Some(Instant::now() + EOF_WAIT);
        }
    }

    fn child_exited(&mut self, st: io::Result<WaitNotice>) {
        let Some(p) = &mut self.proc else { return };
        let status = match st {
            Ok(WaitNotice::Exited(code, signal)) => Ok(Some((code, signal))),
            Ok(WaitNotice::ProbeChild) => p.agent.probe_exit(),
            Err(e) if !child::is_echild(&e) => {
                warn!("observing agent exit: {e}; switching to child wait");
                p.agent.watch.use_child_wait();
                return;
            }
            Err(e) => Err(e),
        };
        p.status = Some(match status {
            Ok(Some(status)) => status,
            Ok(None) => return,
            Err(e) if child::is_echild(&e) => {
                p.agent.discard_group();
                warn!("waiting for the agent: {e}");
                (None, None)
            }
            Err(e) => {
                warn!("waiting for owned agent child: {e}");
                p.agent.watch.retry_child();
                return;
            }
        });
        if p.eof {
            self.finalise();
        } else {
            p.drain_until = Some(Instant::now() + EXIT_DRAIN);
        }
    }

    /// The agent exited but stdout stayed open, or stdout closed but the agent did not
    /// exit.
    fn drained(&mut self) {
        let Some(p) = &mut self.proc else { return };
        p.drain_until = None;
        if p.status.is_some() {
            self.finalise();
        } else {
            warn!("the agent closed stdout but did not exit; killing its process group");
            p.agent.signal(Signal::KILL);
        }
    }

    /// The agent is gone: what is left of its process group is ended (H-11), the death
    /// invariant is journaled (DESIGN §3.4.4), and what waited on the agent is answered.
    fn finalise(&mut self) {
        let Some(mut p) = self.proc.take() else {
            return;
        };
        let (code, signal) = p.status.unwrap_or((None, None));
        p.agent.end_group(LEFTOVER_GRACE);
        let reason = if self.stopping.is_some() {
            ExitReason::HubRestart
        } else if self.cause.is_some() {
            ExitReason::Killed
        } else {
            ExitReason::Exited
        };
        info!(?code, ?signal, ?reason, "the agent exited");
        let user_kill = self.cause == Some(Cause::User);
        self.cause = None;
        self.stage = None;
        self.setup_at = None;
        self.load_filter = false;
        self.has_session = false;
        // The death lines resolve these; the agent is gone, so nothing is sent.
        self.held.clear();
        self.fault_exit = Some((code, signal, reason));
        let why = match reason {
            ExitReason::Exited => "the agent exited",
            ExitReason::Killed => "the agent was stopped",
            _ => "the hub stopped",
        };
        let mut lines = self.facts.death_lines(reason != ExitReason::Exited, why);
        let last = p.agent.finish_stderr();
        if (code != Some(0) || signal.is_some()) && !last.is_empty() {
            let last: String = last.chars().take(NOTICE_MAX).collect();
            lines.push(EventBody::Notice {
                level: NoticeLevel::Error,
                text: format!("agent stderr: {last}"),
            });
        }
        lines.push(EventBody::Exit {
            code,
            signal,
            reason,
        });
        self.quiet = true;
        for body in lines {
            if !self.record(body) {
                break;
            }
        }
        for purpose in p.outstanding.into_values() {
            purpose.fail(ErrorCode::NotAlive, "the agent exited");
        }
        self.fail_startup_config(ErrorCode::NotAlive, "the agent exited");
        // ROB-13: a kill the user asked for is not an error to report.
        if user_kill && self.fault.is_none() {
            self.set_seen(self.facts.head_seq);
        }
        self.quiet = false;
        self.publish();
        if !self.forgets.is_empty() {
            self.phase = Phase::Forget;
        } else if self.stopping.is_some() {
            self.phase = Phase::Stopped;
        }
    }
}

/// Sends the `ok` of an `acp.open`, the replay and `acp.replayed` to one connection,
/// paced by its queue, then tells the actor.
struct Pump {
    sid: String,
    path: PathBuf,
    offset: u64,
    since: u64,
    pinned: Vec<u64>,
    ok: AcpOpenReply,
    reply: Reply,
    outq: Arc<OutQ>,
    conn: ConnId,
    cancel: Arc<AtomicBool>,
    done: mpsc::UnboundedSender<Replayed>,
}

impl Pump {
    async fn run(self) {
        let Pump {
            sid,
            path,
            offset,
            since,
            pinned,
            mut ok,
            reply,
            outq,
            conn,
            cancel,
            done,
        } = self;
        let head = ok.head;
        let scanned = if head == 0 {
            Ok(Replay {
                events: Vec::new(),
                from: since + 1,
                truncated: false,
            })
        } else {
            tokio::task::spawn_blocking(move || {
                replay::scan(&path, offset, since, head, &pinned, ACP_REPLAY_MAX)
            })
            .await
            .unwrap_or_else(|e| Err(anyhow!("the replay panicked: {e}")))
        };
        let sent = match scanned {
            Err(e) => {
                warn!(%sid, "reading the journal for a replay: {e:#}");
                reply.err(ErrorCode::Internal, "reading the journal failed");
                false
            }
            Ok(replay) => {
                ok.from = replay.from;
                reply.ok(&ok);
                let mut sent = true;
                for ev in replay.events {
                    // Paced: each event waits until it fits under the queue's cap. A
                    // replaced attachment stops its replay before the next event.
                    let msg = HubMessage::AcpEv {
                        sid: sid.clone(),
                        ev: Box::new(ev),
                    };
                    if !outq.push_paced(line(&msg), &cancel).await {
                        sent = false;
                        break;
                    }
                }
                let msg = HubMessage::AcpReplayed {
                    sid,
                    head,
                    truncated: replay.truncated,
                };
                // The held-back live events follow into a drained queue, so they never
                // meet the paced replay's tail at the cap.
                sent && outq.push_paced(line(&msg), &cancel).await && outq.drained(&cancel).await
            }
        };
        let _ = done.send(Replayed {
            conn,
            cancel,
            ok: sent,
        });
    }
}

/// The cancellation marker of a request kind, as journaled.
fn cancelled(kind: PendingKind) -> Value {
    match kind {
        PendingKind::Permission => rpc::permission_cancelled(),
        _ => rpc::elicitation_cancelled(),
    }
}

/// The result the agent gets for a journaled answer.
fn to_agent(kind: PendingKind, answer: Value) -> Value {
    match kind {
        PendingKind::Permission => rpc::permission_result(&answer),
        _ => answer,
    }
}

fn via_name(via: SessionVia) -> &'static str {
    match via {
        SessionVia::Resume => "resume",
        SessionVia::Load => "load",
        _ => "new",
    }
}

fn rpc_code(e: &Value) -> Option<i64> {
    e.get("code").and_then(Value::as_i64)
}

fn rpc_message(e: &Value) -> String {
    match e.get("message").and_then(Value::as_str) {
        Some(m) => m.to_owned(),
        None => e.to_string(),
    }
}

/// The `acp.prompt` rules for `blocks` against the agent's `promptCapabilities`.
fn check_prompt(blocks: &[Value], caps: Option<&Value>) -> Result<(), String> {
    if blocks.is_empty() {
        return Err("the prompt is empty".into());
    }
    let size = serde_json::to_vec(blocks).map_or(usize::MAX, |b| b.len());
    if size > PROMPT_MAX {
        return Err(format!("the prompt exceeds {PROMPT_MAX} bytes"));
    }
    for block in blocks {
        let kind = block
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let cap = match kind {
            "text" | "resource_link" => continue,
            "image" => "image",
            "audio" => "audio",
            "resource" => "embeddedContext",
            _ => return Err(format!("unknown content block type {kind:?}")),
        };
        if caps.and_then(|c| c.get(cap)) != Some(&Value::Bool(true)) {
            return Err(format!("the agent does not accept {kind} blocks"));
        }
    }
    Ok(())
}

/// The shape of an `acp.permission` outcome.
fn check_outcome(outcome: &Value, option_ids: &[String]) -> Result<(), (ErrorCode, String)> {
    match outcome.get("outcome").and_then(Value::as_str) {
        Some("cancelled") => Ok(()),
        Some("selected") => match outcome.get("optionId").and_then(Value::as_str) {
            Some(id) if option_ids.iter().any(|o| o == id) => Ok(()),
            Some(id) => Err((ErrorCode::BadOption, format!("option {id} was not offered"))),
            None => Err((
                ErrorCode::BadRequest,
                "a selected outcome needs an optionId".into(),
            )),
        },
        _ => Err((
            ErrorCode::BadRequest,
            "outcome must be selected or cancelled".into(),
        )),
    }
}

/// The shape of an `acp.elicitation` response; the agent checks it against its schema.
fn check_response(response: &Value) -> Result<(), (ErrorCode, String)> {
    let bad = |msg: &str| Err((ErrorCode::BadRequest, msg.to_owned()));
    match response.get("action").and_then(Value::as_str) {
        Some("accept" | "decline" | "cancel") => {}
        _ => return bad("action must be accept, decline or cancel"),
    }
    let value = |v: &Value| match v {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => true,
        Value::Array(items) => items.iter().all(Value::is_string),
        _ => false,
    };
    match response.get("content") {
        None => Ok(()),
        Some(Value::Object(m)) if m.values().all(value) => Ok(()),
        Some(_) => bad("content must be an object of strings, numbers, booleans and string arrays"),
    }
}

async fn recv(rx: Option<&mut mpsc::Receiver<Out>>) -> Option<Out> {
    match rx {
        Some(rx) => rx.recv().await,
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
    use serde_json::json;

    use super::*;

    // A registered, dead ACP session with a real journal. Hold its receiver until
    // the test has queued everything: no timing or scheduler assumption about when
    // the actor stops handling commands and starts draining them.
    async fn dormant(dir: &Path) -> (Acp, mpsc::Receiver<Cmd>) {
        let mut ctx = Ctx::for_test(dir);
        // Kill/forget is valid for dead sessions; no external agent is needed.
        ctx.cfg.agents.insert(
            "offline".into(),
            serde_json::from_value(json!({"label": "offline", "argv": [dir.join("absent")]}))
                .unwrap(),
        );
        let ctx = Arc::new(ctx);
        let Route::Created { created_at, rx } = ctx.registry.route("a", true).await.unwrap() else {
            panic!("expected a new sid");
        };
        let mut acp = Acp::new(ctx, "a".into(), created_at, Arc::default());
        acp.meta = Meta {
            sid: acp.sid.clone(),
            created_at,
            agent: "offline".into(),
            cwd: dir.to_str().unwrap().into(),
            ..Meta::default()
        };
        acp.journal =
            Some(Journal::open(&acp.path("jsonl"), acp.shared.sync.clone(), drop).unwrap());
        assert!(acp.record(EventBody::Task {
            task: Some("original".into()),
        }));
        acp.write_meta().await.unwrap();
        (acp, rx)
    }

    mod barrier {
        use super::*;

        fn attach(actor: &Acp) -> Arc<OutQ> {
            let queue = Arc::new(OutQ::default());
            lock(&actor.shared.viewers).push(Attached {
                viewer: Viewer {
                    id: 1,
                    outq: queue.clone(),
                },
                backlog: None,
            });
            queue
        }

        async fn ask(actor: &mut Acp) {
            actor
                .agent_request(json!(1), "elicitation/create", json!({"message":"Colour?"}))
                .await;
        }

        #[tokio::test]
        async fn unread_stderr_is_journaled_and_sent_before_exit() {
            let dir = tempfile::tempdir().unwrap();
            let (mut actor, _rx) = dormant(dir.path()).await;
            configure_test_agent(&mut actor, "printf 'last words\\n' >&2; exit 1");
            let q = attach(&actor);
            actor.spawn(SpawnVia::New).unwrap();

            // Do not yield this current-thread runtime between spawn and exit:
            // the child can write and exit, but the stderr task cannot run.
            let pid = actor.proc.as_ref().unwrap().agent.pid();
            let until = std::time::Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child::peek_exit(pid).unwrap() {
                    break status;
                }
                assert!(std::time::Instant::now() < until, "agent did not exit");
                std::thread::sleep(Duration::from_millis(1));
            };
            actor.child_exited(Ok(WaitNotice::Exited(
                status.exit_status(),
                status.terminating_signal(),
            )));
            actor.stdout_closed();

            let disk: Vec<Value> = fs::read_to_string(actor.path("jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let tail = &disk[disk.len() - 2..];
            assert_eq!(tail[0]["e"], "notice", "{tail:?}");
            assert_eq!(tail[0]["level"], "error");
            assert_eq!(tail[0]["text"], "agent stderr: last words");
            assert_eq!(tail[1]["e"], "exit");
            assert_eq!(tail[1]["code"], 1);
            q.finish();
            let mut live = Vec::new();
            while let Some(line) = q.pop().await {
                if let Some(ev) = serde_json::from_slice::<Value>(&line).unwrap().get("ev") {
                    live.push(ev.clone());
                }
            }
            assert!(live.ends_with(tail), "{live:?}");
        }

        #[tokio::test]
        async fn consumed_background_eio_blocks_question_and_probe() {
            let dir = tempfile::tempdir().unwrap();
            let (mut actor, _rx) = dormant(dir.path()).await;
            let path = actor.path("jsonl");
            let prefix = fs::read(&path).unwrap();
            let q = attach(&actor);
            let journal = actor.journal.as_mut().unwrap();
            journal.fail_background_sync = true;
            let error = journal.sync().await.unwrap().unwrap_err();
            assert_eq!(
                error.raw_os_error(),
                Some(rustix::io::Errno::IO.raw_os_error())
            );
            journal.fail_background_sync = false;
            ask(&mut actor).await;
            assert_eq!(
                actor.fault.as_ref().map(|f| f.code),
                Some(FaultCode::JournalWrite)
            );
            assert!(actor.announced.is_empty() && actor.held.is_empty());
            assert!(actor.facts.pending.is_empty());
            actor.probe();
            assert!(
                actor.fault.is_some(),
                "an ordinary append cleared the writeback error"
            );
            assert_eq!(fs::read(&path).unwrap(), prefix);
            q.finish();
            while let Some(line) = q.pop().await {
                let msg: Value = serde_json::from_slice(&line).unwrap();
                assert!(msg.get("ev").is_none());
                assert!(msg.pointer("/summary/acp/pending/0/req").is_none());
            }
        }

        #[tokio::test]
        async fn probe_retries_failed_shrink_without_publishing_a_phantom() {
            let dir = tempfile::tempdir().unwrap();
            let (mut actor, _rx) = dormant(dir.path()).await;
            let path = actor.path("jsonl");
            let prefix = fs::read(&path).unwrap();
            let journal = actor.journal.as_mut().unwrap();
            journal.fail_sync = true;
            journal.fail_truncate = true;
            ask(&mut actor).await;
            assert!(actor.fault.is_some() && actor.held.is_empty());
            assert!(fs::metadata(&path).unwrap().len() > prefix.len() as u64);
            let journal = actor.journal.as_mut().unwrap();
            journal.fail_sync = false;
            journal.fail_truncate = false;
            actor.probe();
            assert!(
                actor.fault.is_some(),
                "a successful shrink certified failed data"
            );
            assert_eq!(fs::read(&path).unwrap(), prefix);
            let ctx = actor.ctx.clone();
            let epoch = actor.created_at;
            let sync = actor.shared.sync.clone();
            drop(actor);
            // A supervisor reload shares the fault; only a new process starts fresh.
            assert!(read(&ctx, "a", sync).await.is_err());
            let shared = Arc::<Shared>::default();
            let loaded = read(&ctx, "a", shared.sync.clone()).await.unwrap().unwrap();
            assert!(
                loaded.announced.is_empty(),
                "replayed a never-offered question"
            );
            let mut recovered = Acp::new(ctx, "a".into(), epoch, shared);
            recovered.begin(Start::Loaded(Box::new(loaded)));
            ask(&mut recovered).await;
            assert_eq!(recovered.facts.pending.len(), 1);
            assert!(recovered.fault.is_none());
        }

        #[tokio::test]
        async fn question_publication_waits_for_sync() {
            let dir = tempfile::tempdir().unwrap();
            let (mut actor, _rx) = dormant(dir.path()).await;
            let q = attach(&actor);
            let path = actor.path("jsonl");
            let req = actor.facts.head_seq + 1;
            let (entered_tx, entered) = oneshot::channel();
            let (release, release_rx) = oneshot::channel();
            actor.journal.as_mut().unwrap().pause_question = Some((entered_tx, release_rx));
            let mut asked = tokio::spawn(async move {
                ask(&mut actor).await;
                actor
            });
            tokio::select! {
                result = entered => result.expect("question skipped its sync"),
                _ = &mut asked => panic!("published without waiting for the sync"),
            }
            // The worker has written the entire question, including its newline.
            let disk = fs::read_to_string(path).unwrap();
            assert!(disk.ends_with('\n'));
            let last: JournalEvent = serde_json::from_str(disk.lines().last().unwrap()).unwrap();
            assert_eq!(last.seq, req);
            assert!(matches!(last.body, EventBody::Elicitation { .. }));
            // A sentinel must be the very first item in the viewer's queue,
            // without using a timeout or racing a poll against the worker.
            q.push_reply(Arc::from(&b"sentinel"[..]));
            assert_eq!(q.pop().await.unwrap().as_ref(), b"sentinel");
            release.send(()).unwrap();
            let actor = asked.await.unwrap();
            assert!(actor.held.contains_key(&req));
            assert_eq!(next_reply(&q).await["ev"]["seq"], req);
            assert_eq!(
                next_reply(&q).await["summary"]["acp"]["pending"][0]["req"],
                req
            );
        }
    }

    fn guarded_forget(epoch: u64) -> (Cmd, Arc<OutQ>) {
        let outq = Arc::new(OutQ::default());
        let cmd = Cmd::Act {
            epoch: Some(epoch),
            act: Act::Kill { forget: true },
            reply: Reply::for_test(1, outq.clone()),
        };
        (cmd, outq)
    }

    async fn read_reply(outq: &OutQ) -> Value {
        let line = outq.pop().await.expect("reply queue closed");
        serde_json::from_slice(&line).unwrap()
    }

    async fn watchdog<F: Future>(f: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(120), f)
            .await
            .expect("ACP test timed out")
    }

    async fn next_reply(outq: &OutQ) -> Value {
        watchdog(read_reply(outq)).await
    }

    async fn wait_success(agent: &mut Agent) -> WaitNotice {
        let status = child::wait(Some(&mut agent.watch)).await.unwrap();
        assert!(matches!(status, WaitNotice::Exited(Some(0), None)));
        status
    }

    fn configure_test_agent(acp: &mut Acp, script: &str) {
        let shell = std::env::var("BASH").unwrap_or_else(|_| "/bin/sh".into());
        let cfg = &mut Arc::get_mut(&mut acp.ctx).unwrap().cfg;
        cfg.shells.push(crate::config::ShellConfig {
            name: "bash".into(),
            paths: vec![shell.clone()],
            args: vec![],
        });
        cfg.agents.get_mut("offline").unwrap().argv = vec![shell, "-c".into(), script.into()];
    }

    async fn recover_agent_exit_observation(reap: bool) {
        let dir = tempfile::tempdir().unwrap();
        let (mut actor, _rx) = dormant(dir.path()).await;
        configure_test_agent(&mut actor, "while read -r line; do :; done; exit 37");
        actor.spawn(SpawnVia::New).unwrap();
        let agent = &mut actor.proc.as_mut().unwrap().agent;
        let pid = agent.pid();
        agent.fail_exit_peek = reap;
        let mut member = reap.then(|| {
            // Keep the old group addressable after reaping. Either TERM or
            // KILL would prevent this member from exiting normally at EOF.
            tokio::process::Command::new("sh")
                .args(["-c", "read -r line; exit 0"])
                .process_group(pid as i32)
                .stdin(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        });

        let head = actor.facts.head_seq;
        actor.child_exited(Err(rustix::io::Errno::IO.into()));
        assert!(actor.proc.as_ref().unwrap().status.is_none());
        let p = actor.proc.as_mut().unwrap();
        let probe = watchdog(child::wait(Some(&mut p.agent.watch))).await;
        assert!(matches!(probe, Ok(WaitNotice::ProbeChild)));
        actor.child_exited(probe);
        let p = actor.proc.as_mut().unwrap();
        assert!(p.status.is_none());
        assert!(p.drain_until.is_none());
        assert_eq!(p.agent.pid(), pid);
        assert!(child::peek_exit(pid).unwrap().is_none());
        assert_eq!(actor.facts.head_seq, head);

        p.agent.stdin = None;
        watchdog(async {
            while let Some(p) = actor.proc.as_mut().filter(|p| p.status.is_none()) {
                let notice = child::wait(Some(&mut p.agent.watch)).await;
                actor.child_exited(notice);
            }
        })
        .await;
        assert_eq!(actor.proc.as_ref().unwrap().status, Some((Some(37), None)));
        if reap {
            assert!(child::peek_exit(pid).is_err_and(|e| child::is_echild(&e)));
        } else {
            assert_eq!(
                child::peek_exit(pid).unwrap().unwrap().exit_status(),
                Some(37)
            );
        }

        actor.stdout_closed();
        actor.ctx.escalations.finish();
        if let Some(member) = &mut member {
            drop(member.stdin.take());
            assert!(
                watchdog(member.wait()).await.unwrap().success(),
                "signalled after the reaping fallback"
            );
        }
        let disk = fs::read_to_string(actor.path("jsonl")).unwrap();
        let exit: JournalEvent = serde_json::from_str(disk.lines().last().unwrap()).unwrap();
        assert!(matches!(
            exit.body,
            EventBody::Exit {
                code: Some(37),
                signal: None,
                reason: ExitReason::Exited,
            }
        ));
    }

    #[tokio::test]
    async fn observation_error_recovers_without_reaping_the_leader() {
        recover_agent_exit_observation(false).await;
    }

    #[tokio::test]
    async fn reaping_observation_fallback_never_signals_the_released_group() {
        recover_agent_exit_observation(true).await;
    }

    mod group_cleanup {
        use super::*;
        use rustix::process::{Pid, WaitOptions, waitpid};
        use std::process::Stdio;
        use tokio::io::AsyncReadExt;
        use tokio::process::{Child, ChildStdin, Command};

        // Exit 42 on TERM if the leader is still pinned, 43 if the number was
        // released. Closing the gate instead exits 0. An unrelated group can
        // thus prove it received neither TERM nor KILL, without a timing sample.
        async fn witness(group: i32) -> (Child, ChildStdin) {
            let mut child = Command::new("sh")
                .args([
                    "-c",
                    r#"trap 'test -d "/proc/$1" && exit 42; exit 43' TERM; printf R; read -r line; exit 0"#,
                    "witness",
                    &group.to_string(),
                ])
                .process_group(group)
                .kill_on_drop(true)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            let ready = watchdog(child.stdout.take().unwrap().read_u8())
                .await
                .unwrap();
            assert_eq!(ready, b'R');
            let gate = child.stdin.take().unwrap();
            (child, gate)
        }

        #[tokio::test]
        async fn panic_during_exit_drain_signals_only_the_pinned_group() {
            let dir = tempfile::tempdir().unwrap();
            let (mut actor, rx) = dormant(dir.path()).await;
            configure_test_agent(&mut actor, READ_INPUT);
            actor.spawn(SpawnVia::New).unwrap();
            let agent = &mut actor.proc.as_mut().unwrap().agent;
            let pid = agent.pid();
            let (mut member, _gate) = witness(pid as i32).await;
            let (mut unrelated, release) = witness(0).await;
            agent.stdin = None;
            let st = wait_success(agent).await;
            actor.child_exited(Ok(st));

            // Queue the panic before the actor polls again. Hold the drain open
            // so it cannot finalise instead, even on a slow test machine.
            actor.proc.as_mut().unwrap().eof = true;
            actor.proc.as_mut().unwrap().drain_until = None;
            let ctx = actor.ctx.clone();
            ctx.registry
                .deliver(
                    "a",
                    Cmd::Act {
                        epoch: None,
                        act: Act::Panic,
                        reply: Reply::for_test(1, Arc::default()),
                    },
                )
                .await;
            let supervisor = tokio::spawn(supervise(actor, rx, None));
            assert_eq!(watchdog(member.wait()).await.unwrap().code(), Some(42));
            watchdog(async {
                while !child::peek_exit(pid).is_err_and(|e| child::is_echild(&e)) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            drop(release);
            assert!(watchdog(unrelated.wait()).await.unwrap().success());
            supervisor.abort();
        }

        #[tokio::test]
        async fn echild_never_signals_a_still_addressable_group() {
            let dir = tempfile::tempdir().unwrap();
            let (mut actor, _rx) = dormant(dir.path()).await;
            configure_test_agent(&mut actor, READ_INPUT);
            actor.spawn(SpawnVia::New).unwrap();
            let agent = &mut actor.proc.as_mut().unwrap().agent;
            let pid = Pid::from_raw(agent.pid() as i32).unwrap();
            // Keep a witness at the old number: unlike relying on rapid pid
            // reuse after a group empties, any stale killpg is observable.
            let (mut member, release) = witness(pid.as_raw_nonzero().get()).await;
            agent.stdin = None;
            let e = tokio::task::spawn_blocking(move || {
                waitpid(Some(pid), WaitOptions::empty()).unwrap();
                waitpid(Some(pid), WaitOptions::NOHANG).unwrap_err()
            })
            .await
            .unwrap();
            assert_eq!(e, rustix::io::Errno::CHILD);
            actor.child_exited(Err(e.into()));
            actor.stdout_closed();
            actor.ctx.escalations.finish();
            drop(release);
            assert!(
                watchdog(member.wait()).await.unwrap().success(),
                "signalled after ECHILD"
            );
        }
    }

    const READ_INPUT: &str = "while read -r line; do :; done";

    mod revive_journal {
        use super::*;

        async fn dormant_revivable(dir: &Path) -> (Acp, mpsc::Receiver<Cmd>) {
            let (mut acp, rx) = dormant(dir).await;
            acp.facts.agent_session_id = Some("s".into());
            acp.meta.init = Some(json!({"agentCapabilities":{"loadSession":true}}));
            (acp, rx)
        }

        async fn revive(acp: &mut Acp) -> Value {
            let out = Arc::new(OutQ::default());
            acp.act(Act::Revive, Reply::for_test(1, out.clone()));
            next_reply(&out).await
        }

        #[tokio::test]
        async fn acknowledged_background_eio_refuses_revive_before_starting_child() {
            let dir = tempfile::tempdir().unwrap();
            let (mut acp, _rx) = dormant_revivable(dir.path()).await;
            configure_test_agent(&mut acp, READ_INPUT);
            let prefix = fs::read(acp.path("jsonl")).unwrap();
            let journal = acp.journal.as_mut().unwrap();
            journal.fail_background_sync = true;
            let error = journal.sync().await.unwrap().unwrap_err();
            assert_eq!(
                error.raw_os_error(),
                Some(rustix::io::Errno::IO.raw_os_error())
            );
            journal.fail_background_sync = false;
            assert!(acp.fault.is_none(), "actor has not yet observed the EIO");

            let reply = revive(&mut acp).await;
            // agent::start opens this log synchronously after spawning the process.
            assert!(
                !acp.path("stderr.log").exists(),
                "started an unjournalable agent"
            );
            assert!(acp.proc.is_none());
            assert_eq!(reply["code"], "faulted", "{reply}");
            assert_eq!(acp.fault.as_ref().unwrap().code, FaultCode::JournalWrite);
            assert_eq!(fs::read(acp.path("jsonl")).unwrap(), prefix);
        }

        #[tokio::test]
        async fn failed_spawn_append_refuses_revive_and_reaps_without_initialize() {
            watchdog(check_spawn_append_and_retry()).await;
        }

        async fn check_spawn_append_and_retry() {
            let dir = tempfile::tempdir().unwrap();
            let (mut acp, _rx) = dormant_revivable(dir.path()).await;
            // Echo the first RPC, if any, and exit when stdin closes.
            configure_test_agent(
                &mut acp,
                r#"if read -r request; then printf '%s\n' "$request"; fi"#,
            );
            let prefix = fs::read(acp.path("jsonl")).unwrap();
            acp.journal.as_mut().unwrap().fail_at = Some(acp.facts.head_seq + 1);
            let reply = revive(&mut acp).await;

            let proc = acp
                .proc
                .as_mut()
                .expect("started child is tracked for teardown");
            let status = wait_success(&mut proc.agent).await;
            assert!(
                matches!(proc.agent.stdout.recv().await, Some(Out::Eof)),
                "agent received an RPC"
            );
            acp.child_exited(Ok(status));
            acp.stdout_closed();
            assert!(acp.proc.is_none());
            assert_eq!(reply["code"], "faulted", "{reply}");
            assert_eq!(acp.fault.as_ref().unwrap().code, FaultCode::JournalWrite);
            assert_eq!(fs::read(acp.path("jsonl")).unwrap(), prefix);

            // The probe heals this one-shot write fault. A healthy revive sends initialize.
            assert_eq!(revive(&mut acp).await["t"], "ok");
            let agent = &mut acp.proc.as_mut().unwrap().agent;
            let Some(Out::Msg(request)) = agent.stdout.recv().await else {
                panic!("expected initialize");
            };
            assert_eq!(request["method"], "initialize");
            wait_success(agent).await;
        }

        #[tokio::test]
        async fn spawn_failure_reports_spawn_failed_only_if_setup_error_was_written() {
            for fail_append in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let (mut acp, _rx) = dormant_revivable(dir.path()).await;
                let head = acp.facts.head_seq;
                if fail_append {
                    acp.journal.as_mut().unwrap().fail_at = Some(head + 1);
                }
                let reply = revive(&mut acp).await; // dormant's agent is unavailable
                assert!(acp.proc.is_none());
                if fail_append {
                    assert_eq!(reply["code"], "faulted", "{reply}");
                    assert_eq!(acp.fault.as_ref().unwrap().code, FaultCode::JournalWrite);
                    assert_eq!(acp.facts.head_seq, head);
                } else {
                    assert_eq!(reply["code"], "spawn_failed", "{reply}");
                    assert!(acp.fault.is_none());
                    let log = fs::read_to_string(acp.path("jsonl")).unwrap();
                    let last: JournalEvent =
                        serde_json::from_str(log.lines().last().unwrap()).unwrap();
                    assert_eq!(last.seq, head + 1);
                    assert!(matches!(
                        last.body,
                        EventBody::SetupError {
                            code: SetupErrorCode::SpawnFailed,
                            ..
                        }
                    ));
                }
            }
        }
    }

    #[tokio::test]
    async fn rejected_prompt_enqueue_ends_the_journaled_turn() {
        let dir = tempfile::tempdir().unwrap();
        let (mut acp, _rx) = dormant(dir.path()).await;
        configure_test_agent(&mut acp, READ_INPUT);
        acp.spawn(SpawnVia::New).unwrap();
        assert!(acp.record(EventBody::Session {
            via: SessionVia::New,
            session_id: "s".into(),
            modes: None,
            config_options: None,
        }));
        acp.proc.as_mut().unwrap().agent.stdin.take();
        let out = Arc::new(OutQ::default());
        acp.prompt(
            vec![json!({"type":"text","text":"hi"})],
            Reply::for_test(1, out.clone()),
        );
        assert_eq!(next_reply(&out).await["code"], "internal");
        assert_eq!(acp.facts.activity, Activity::None);
        let log = fs::read_to_string(acp.path("jsonl")).unwrap();
        let mut tail = log
            .lines()
            .rev()
            .map(|s| serde_json::from_str::<Value>(s).unwrap());
        let terminal = tail.next().unwrap();
        assert_eq!(terminal["e"], "turn_error");
        assert_eq!(terminal["code"], "agent_error");
        assert_eq!(tail.next().unwrap()["e"], "prompt");
    }

    #[tokio::test]
    async fn rejected_cancel_and_answer_enqueues_report_failure() {
        let dir = tempfile::tempdir().unwrap();
        let (mut acp, _rx) = dormant(dir.path()).await;
        configure_test_agent(&mut acp, READ_INPUT);
        acp.spawn(SpawnVia::New).unwrap();
        assert!(acp.record(EventBody::Session {
            via: SessionVia::New,
            session_id: "s".into(),
            modes: None,
            config_options: None,
        }));
        let out = Arc::new(OutQ::default());
        acp.prompt(
            vec![json!({"type":"text","text":"go"})],
            Reply::for_test(1, out.clone()),
        );
        assert_eq!(next_reply(&out).await["t"], "ok");
        acp.proc.as_mut().unwrap().agent.stdin.take();
        acp.cancel(Reply::for_test(2, out.clone()));
        let turn_cancel = next_reply(&out).await;
        assert!(acp.record(EventBody::TurnEnd {
            stop_reason: "cancelled".into()
        }));
        acp.agent_request(json!(1), "elicitation/create", json!({}))
            .await;
        let req = acp.facts.head_seq;
        acp.answer(
            req,
            acp.created_at,
            PendingKind::Elicitation,
            json!({"action":"decline"}),
            Reply::for_test(3, out.clone()),
        );
        let answer = next_reply(&out).await;
        acp.answer(
            req,
            acp.created_at,
            PendingKind::Elicitation,
            json!({"action":"decline"}),
            Reply::for_test(4, out.clone()),
        );
        assert_eq!(next_reply(&out).await["code"], "already_resolved");
        acp.agent_request(json!(2), "session/request_permission", json!({}))
            .await;
        acp.cancel(Reply::for_test(5, out.clone()));
        let idle_cancel = next_reply(&out).await;
        assert!(acp.facts.pending.is_empty());
        assert_eq!(turn_cancel["code"], "internal");
        assert_eq!(answer["code"], "internal");
        let message = answer["message"].as_str().unwrap();
        assert!(message.contains("not queued") && message.contains("already recorded"));
        assert_eq!(idle_cancel["code"], "internal");
    }

    async fn lost_question_tail(kind: PendingKind) {
        let dir = tempfile::tempdir().unwrap();
        let (mut old, _rx) = dormant(dir.path()).await;
        configure_test_agent(&mut old, READ_INPUT);
        let path = old.path("jsonl");
        let epoch = old.created_at;
        let session = |via| EventBody::Session {
            via,
            session_id: "s".into(),
            modes: None,
            config_options: None,
        };
        let prompt = || EventBody::Prompt {
            prompt: vec![json!({"type":"text","text":"go"})],
        };
        assert!(old.record(EventBody::Spawn {
            pid: 1,
            via: SpawnVia::New
        }));
        assert!(old.record(session(SessionVia::New)));
        old.journal.as_ref().unwrap().sync().await.unwrap().unwrap();
        let stable_end = fs::metadata(&path).unwrap().len();
        assert!(old.record(prompt()));
        // At restart, exit + spawn + session + prompt will occupy these four seqs.
        for _ in 0..3 {
            assert!(old.record(EventBody::Update {
                update: json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}),
                session_id: None,
            }));
        }
        let (method, question, answer): (_, fn(&str) -> Value, _) = match kind {
            PendingKind::Permission => (
                "session/request_permission",
                |title| json!({"toolCall":{"title":title},"options":[{"optionId":"allow"}]}),
                json!({"outcome":"selected","optionId":"allow"}),
            ),
            PendingKind::Elicitation => (
                "elicitation/create",
                |message| json!({"message":message}),
                json!({"action":"decline"}),
            ),
            PendingKind::Unknown => unreachable!(),
        };
        let queue = Arc::new(OutQ::default());
        lock(&old.shared.viewers).push(Attached {
            viewer: Viewer {
                id: 1,
                outq: queue.clone(),
            },
            backlog: None,
        });
        let before_question = fs::metadata(&path).unwrap().len();
        old.journal.as_mut().unwrap().fail_sync = true;
        old.agent_request(json!(7), method, question("old question"))
            .await;
        queue.finish();
        let mut published_req = None;
        while let Some(line) = queue.pop().await {
            let msg: Value = serde_json::from_slice(&line).unwrap();
            if let Some(req) = msg["ev"]["seq"]
                .as_u64()
                .or_else(|| msg.pointer("/summary/acp/pending/0/req")?.as_u64())
            {
                published_req = Some(req);
            }
        }
        let after_question = fs::metadata(&path).unwrap().len();
        let fault = old.fault.take();
        let ctx = old.ctx.clone();
        drop(old);

        // Lose everything after the last successful sync, not just a torn JSON line.
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(stable_end)
            .unwrap();
        let shared = Arc::<Shared>::default();
        let loaded = read(&ctx, "a", shared.sync.clone()).await.unwrap().unwrap();
        assert_eq!(loaded.meta.created_at, epoch);
        let mut new = Acp::new(ctx, "a".into(), epoch, shared);
        new.begin(Start::Loaded(Box::new(loaded)));
        new.spawn(SpawnVia::Revive).unwrap();
        assert!(new.record(session(SessionVia::Resume)));
        assert!(new.record(prompt()));
        new.agent_request(json!(7), method, question("different question"))
            .await;
        let req = new.facts.pending[0].req;
        if let Some(stale) = published_req {
            assert_eq!(stale, req, "the lost tail must exercise a real collision");
            let queue_for_answer = Arc::new(OutQ::default());
            new.answer(
                stale,
                epoch,
                kind,
                answer.clone(),
                Reply::for_test(1, queue_for_answer.clone()),
            );
            assert_ne!(
                next_reply(&queue_for_answer).await["t"],
                "ok",
                "the old answer consumed the replacement question"
            );
        }
        assert_eq!(published_req, None, "the unsynced question was published");
        assert_eq!(
            before_question, after_question,
            "failed sync left a complete line"
        );
        assert!(matches!(
            fault,
            Some(Fault {
                code: FaultCode::JournalWrite,
                ..
            })
        ));
        let reply = Arc::new(OutQ::default());
        new.answer(req, epoch, kind, answer, Reply::for_test(2, reply.clone()));
        assert_eq!(next_reply(&reply).await["t"], "ok");
    }

    #[tokio::test]
    async fn lost_permission_tail() {
        lost_question_tail(PendingKind::Permission).await;
    }

    #[tokio::test]
    async fn lost_elicitation_tail() {
        lost_question_tail(PendingKind::Elicitation).await;
    }

    async fn actions_during_drain(exit_first: bool) {
        let dir = tempfile::tempdir().unwrap();
        let (mut acp, _rx) = dormant(dir.path()).await;
        // Drive the two actor inputs separately, without racing its select loop.
        let script = if exit_first {
            "exit 0"
        } else {
            "exec 1>&-; while read -r line; do :; done"
        };
        configure_test_agent(&mut acp, script);
        acp.spawn(SpawnVia::New).unwrap();
        assert!(acp.record(EventBody::Session {
            via: SessionVia::New,
            session_id: "s".into(),
            modes: Some(json!({"availableModes": [{"id": "ask"}]})),
            config_options: Some(json!([{"id": "flag", "type": "boolean"}])),
        }));
        acp.agent_request(json!(10), "session/request_permission", json!({}))
            .await;
        let permission = acp.facts.head_seq;
        acp.agent_request(json!(11), "elicitation/create", json!({}))
            .await;
        let elicitation = acp.facts.head_seq;

        let agent = &mut acp.proc.as_mut().unwrap().agent;
        if exit_first {
            let status = wait_success(agent).await;
            acp.child_exited(Ok(status));
        } else {
            assert!(matches!(agent.stdout.recv().await, Some(Out::Eof)));
            acp.stdout_closed();
        }
        let epoch = acp.created_at;
        let journal = acp.path("jsonl");
        let before = fs::read(&journal).unwrap();
        let seen = acp.meta.seen_seq;
        for act in [
            Act::Prompt(vec![json!({"type": "text", "text": "too late"})]),
            Act::SetMode("ask".into()),
            Act::SetConfigOption {
                epoch,
                config_id: "flag".into(),
                value: json!(true),
            },
            Act::Permission {
                epoch,
                req: permission,
                outcome: json!({"outcome": "cancelled"}),
            },
            Act::Elicitation {
                epoch,
                req: elicitation,
                response: json!({"action": "decline"}),
            },
            Act::Cancel,
        ] {
            let queue = Arc::new(OutQ::default());
            acp.act(act, Reply::for_test(1, queue.clone()));
            assert_eq!(next_reply(&queue).await["code"], "not_alive");
        }
        assert_eq!(fs::read(journal).unwrap(), before);
        assert_eq!(acp.meta.seen_seq, seen);
        assert_eq!(acp.held.len(), 2);
    }

    #[tokio::test]
    async fn actions_during_drain_after_exit() {
        actions_during_drain(true).await;
    }

    #[tokio::test]
    async fn actions_during_drain_after_eof() {
        actions_during_drain(false).await;
    }

    #[tokio::test]
    async fn hub_action_epoch_forget_drains_queued_open_then_guarded_kill() {
        let dir = tempfile::tempdir().unwrap();
        let (old, rx) = dormant(dir.path()).await;
        let ctx = old.ctx.clone();
        let epoch = old.created_at;
        let (forget, forgotten) = guarded_forget(epoch);
        ctx.registry.deliver("a", forget).await;
        let opening = Arc::new(OutQ::default());
        let create = Open {
            viewer: Viewer {
                id: 1,
                outq: opening.clone(),
            },
            since: 0,
            epoch: None,
            spawn: Some(
                serde_json::from_value(json!({
                    "agent": "offline", "cwd": dir.path(), "task": "replacement"
                }))
                .unwrap(),
            ),
            reply: Reply::for_test(2, opening.clone()),
        };
        open(ctx.clone(), "a".into(), create).await;
        let (late, rejected) = guarded_forget(epoch);
        ctx.registry.deliver("a", late).await;
        assert_eq!(rx.len(), 3, "all three commands must be in the old mailbox");

        old.run(rx, None).await;
        assert_eq!(next_reply(&forgotten).await["t"], "ok");
        assert_eq!(next_reply(&rejected).await["code"], "stale");
        let opened = next_reply(&opening).await;
        assert_eq!(opened["new"], true, "{opened}");
        let current = opened["summary"]["createdAt"].as_u64().unwrap();
        assert_ne!(current, epoch);
        assert_eq!(opened["summary"]["acp"]["task"], "replacement");
        assert!(ctx.acp_dir.join("a.jsonl").is_file());

        // Same action, now naming the right incarnation, actually deletes it.
        let (forget, forgotten) = guarded_forget(current);
        ctx.registry.deliver("a", forget).await;
        assert_eq!(next_reply(&forgotten).await["t"], "ok");
        assert!(ctx.registry.kind("a").is_none());
        assert!(!ctx.acp_dir.join("a.jsonl").exists());
    }

    #[tokio::test]
    async fn hub_action_epoch_shutdown_drains_guarded_kill_without_forgetting() {
        let dir = tempfile::tempdir().unwrap();
        let (old, mut rx) = dormant(dir.path()).await;
        let ctx = old.ctx.clone();
        let journal = old.path("jsonl");
        let before = fs::read(&journal).unwrap();
        let (done, stopped) = oneshot::channel();
        ctx.registry.deliver("a", Cmd::Shutdown { done }).await;
        let (forget, rejected) = guarded_forget(old.created_at);
        ctx.registry.deliver("a", forget).await;
        assert_eq!(rx.len(), 2, "shutdown must have the guarded kill behind it");
        rx.close(); // The stopped actor exits once it has refused its whole mailbox.

        old.run(rx, None).await;
        stopped.await.unwrap();
        let reply = next_reply(&rejected).await;
        assert_eq!(reply["code"], "internal");
        assert_eq!(reply["message"], "hub stopping"); // not Reply::drop on a lost command
        assert_eq!(ctx.registry.kind("a"), Some(Kind::Acp));
        assert!(ctx.acp_dir.join("a.json").is_file());
        assert_eq!(fs::read(journal).unwrap(), before);
    }

    #[tokio::test(start_paused = true)]
    async fn stream_heads_wait_but_materialized_changes_and_viewer_drops_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Arc::new(Ctx::for_test(dir.path()));
        let mut acp = Acp::new(ctx, "a".into(), 1, Arc::default());
        let viewer = Viewer {
            id: 1,
            outq: Arc::default(),
        };
        let queue = viewer.outq.clone();
        lock(&acp.shared.viewers).push(Attached {
            viewer,
            backlog: None,
        });
        let event = |seq, update| JournalEvent {
            seq,
            ts: seq,
            body: EventBody::Update {
                update,
                session_id: None,
            },
        };
        let chunk = || json!({"sessionUpdate": "agent_message_chunk", "content": {"text": "a"}});
        let title = || json!({"sessionUpdate": "session_info_update", "title": "t"});
        let head = |acp: &Acp| {
            let (summary, _) = acp.published.as_ref().unwrap();
            summary.acp.as_ref().unwrap().head_seq
        };

        acp.publish();
        let deadline = Instant::now() + INFO_EVERY;
        acp.applied(event(1, chunk()));
        tokio::time::advance(INFO_EVERY / 2).await;
        acp.applied(event(2, chunk()));
        assert_eq!((head(&acp), acp.info_at), (0, Some(deadline)));
        tokio::time::advance(INFO_EVERY / 2).await;
        acp.flush_info();
        assert_eq!((head(&acp), acp.info_at), (2, None));

        acp.applied(event(3, title()));
        assert_eq!((head(&acp), acp.info_at), (3, None));
        acp.applied(event(4, title()));
        assert_eq!(head(&acp), 3, "an identical title only advances the head");
        queue.close();
        acp.applied(event(5, chunk()));
        assert_eq!(acp.published.as_ref().unwrap().0.viewers, 0);
        assert_eq!((head(&acp), acp.info_at), (5, None));
    }

    #[test]
    fn prompt_rules() {
        let text = json!({"type": "text", "text": "hi"});
        let link = json!({"type": "resource_link", "uri": "file:///a", "name": "a"});
        let image = json!({"type": "image", "data": "aGk=", "mimeType": "image/png"});
        let resource = json!({"type": "resource", "resource": {"uri": "file:///a", "text": "x"}});
        assert!(check_prompt(&[text.clone(), link], None).is_ok());
        assert!(check_prompt(&[], None).is_err());
        assert!(check_prompt(std::slice::from_ref(&image), None).is_err());
        let caps = json!({"image": true, "audio": false, "embeddedContext": true});
        assert!(check_prompt(&[image, resource.clone()], Some(&caps)).is_ok());
        let audio = json!({"type": "audio", "data": "aGk=", "mimeType": "audio/wav"});
        assert!(check_prompt(&[audio], Some(&caps)).is_err());
        assert!(check_prompt(&[resource], Some(&json!({}))).is_err());
        assert!(check_prompt(&[json!({"type": "video"})], Some(&caps)).is_err());
        assert!(check_prompt(&[json!({"text": "no type"})], Some(&caps)).is_err());
        let big = json!({"type": "text", "text": "x".repeat(PROMPT_MAX)});
        assert!(check_prompt(&[big], None).is_err());
    }

    #[test]
    fn permission_outcomes() {
        let offered = ["allow_once".to_owned(), "reject_once".to_owned()];
        let code = |v: Value| check_outcome(&v, &offered).err().map(|(c, _)| c);
        assert_eq!(code(json!({"outcome": "cancelled"})), None);
        assert_eq!(
            code(json!({"outcome": "selected", "optionId": "allow_once"})),
            None
        );
        assert_eq!(
            code(json!({"outcome": "selected", "optionId": "allow_always"})),
            Some(ErrorCode::BadOption)
        );
        assert_eq!(
            code(json!({"outcome": "selected"})),
            Some(ErrorCode::BadRequest)
        );
        assert_eq!(
            code(json!({"outcome": "maybe"})),
            Some(ErrorCode::BadRequest)
        );
        assert_eq!(code(json!("cancelled")), Some(ErrorCode::BadRequest));
    }

    #[test]
    fn elicitation_responses() {
        for ok in [
            json!({"action": "accept", "content": {"name": "x", "n": 3, "ok": true, "tags": ["a"]}}),
            json!({"action": "accept"}),
            json!({"action": "decline"}),
            json!({"action": "cancel"}),
        ] {
            assert!(check_response(&ok).is_ok(), "{ok}");
        }
        for bad in [
            json!({"action": "maybe"}),
            json!({}),
            json!({"action": "accept", "content": ["x"]}),
            json!({"action": "accept", "content": {"nested": {"x": 1}}}),
            json!({"action": "accept", "content": {"mixed": ["a", 1]}}),
            json!({"action": "accept", "content": null}),
        ] {
            assert!(check_response(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn cancel_markers_reach_the_agent_in_its_shape() {
        assert_eq!(
            to_agent(PendingKind::Permission, cancelled(PendingKind::Permission)),
            json!({"outcome": {"outcome": "cancelled"}})
        );
        assert_eq!(
            to_agent(
                PendingKind::Elicitation,
                cancelled(PendingKind::Elicitation)
            ),
            json!({"action": "cancel"})
        );
        let selected = json!({"outcome": "selected", "optionId": "o"});
        assert_eq!(
            to_agent(PendingKind::Permission, selected.clone()),
            json!({"outcome": selected})
        );
    }

    // Re-run the startup scan with the files intact but no previous registration.
    async fn restart(ctx: &Arc<Ctx>, epoch: u64) {
        ctx.registry.forget("a", epoch, &[]);
        crate::load_sessions(ctx).await.unwrap();
    }

    async fn attach_session(ctx: &Arc<Ctx>) -> (Value, Arc<OutQ>) {
        let q = Arc::new(OutQ::default());
        let o = Open {
            viewer: Viewer {
                id: 1,
                outq: q.clone(),
            },
            since: 0,
            epoch: None,
            spawn: None,
            reply: Reply::for_test(1, q.clone()),
        };
        open(ctx.clone(), "a".into(), o).await;
        (next_reply(&q).await, q)
    }

    async fn reload_writerless(ctx: &Arc<Ctx>) {
        let (opened, viewer) = attach_session(ctx).await;
        assert_eq!(opened["summary"]["fault"]["code"], "load_failed");
        let cmd = Cmd::Act {
            epoch: None,
            act: Act::Panic,
            reply: Reply::for_test(2, Arc::default()),
        };
        ctx.registry.deliver("a", cmd).await;
        // The supervisor notifies attached viewers after publishing the new actor.
        watchdog(async { while read_reply(&viewer).await["message"] != "session reloaded" {} })
            .await;
    }

    #[tokio::test]
    async fn writerless_reload_keeps_startup_sync_fault() {
        let dir = tempfile::tempdir().unwrap();
        let (actor, _rx) = dormant(dir.path()).await;
        let (ctx, epoch, journal) = (actor.ctx.clone(), actor.created_at, actor.path("jsonl"));
        drop(actor);

        // /dev/null reads as an empty journal, but its fdatasync fails on Linux.
        let original = dir.path().join("original");
        fs::rename(&journal, &original).unwrap();
        std::os::unix::fs::symlink("/dev/null", &journal).unwrap();
        restart(&ctx, epoch).await;
        fs::rename(original, journal).unwrap();
        reload_writerless(&ctx).await;
        let (opened, _) = attach_session(&ctx).await;
        assert_eq!(opened["summary"]["fault"]["code"], "load_failed");
        assert_eq!(opened["head"], 0);
    }

    #[tokio::test]
    async fn writerless_reload_seeds_newly_readable_metadata_before_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Arc::new(Ctx::for_test(dir.path()));
        let meta = ctx.acp_dir.join("a.json");
        fs::create_dir(&meta).unwrap(); // Listed, but reading it fails even as root.
        fs::write(ctx.acp_dir.join("a.jsonl"), b"!\n").unwrap();
        crate::load_sessions(&ctx).await.unwrap();

        let high = u64::MAX - 1;
        fs::remove_dir(&meta).unwrap();
        let record = Meta {
            sid: "a".into(),
            created_at: high,
            ..Meta::default()
        };
        fs::write(&meta, serde_json::to_vec(&record).unwrap()).unwrap();
        let block_seed = dir.path().join("last-created.tmp");
        fs::create_dir(&block_seed).unwrap();
        reload_writerless(&ctx).await;
        assert!(meta.exists(), "quarantined metadata despite a failed seed");
        fs::remove_dir(block_seed).unwrap();

        reload_writerless(&ctx).await;
        assert!(!meta.exists(), "invalid journal was not quarantined");
        let mark = fs::read_to_string(dir.path().join("last-created")).unwrap();
        assert!(mark.parse::<u64>().unwrap() >= high);
    }

    #[tokio::test]
    async fn load_io_fault_preserves_files_through_actions_stop_and_retry() {
        for ext in ["jsonl", "json"] {
            let dir = tempfile::tempdir().unwrap();
            let (actor, _rx) = dormant(dir.path()).await;
            let (ctx, epoch) = (actor.ctx.clone(), actor.created_at);
            let (meta, journal) = (actor.path("json"), actor.path("jsonl"));
            let (metadata, prefix) = (fs::read(&meta).unwrap(), fs::read(&journal).unwrap());
            let path = actor.path(ext);
            drop(actor);

            // ELOOP on just this file, even as root. Repair the backing link, not
            // the session name, so a quarantine cannot be undone by the fixture.
            let original = dir.path().join("original");
            let backing = dir.path().join("backing");
            fs::rename(&path, &original).unwrap();
            std::os::unix::fs::symlink(&backing, &backing).unwrap();
            std::os::unix::fs::symlink(&backing, &path).unwrap();
            restart(&ctx, epoch).await;
            let (opened, _) = attach_session(&ctx).await;
            assert_eq!(opened["summary"]["fault"]["code"], "load_failed");
            assert_eq!(opened["summary"]["alive"], false);
            assert_eq!(opened["head"], 0);
            assert!(path.is_symlink(), "I/O failure quarantined {ext}");
            fs::rename(&original, &backing).unwrap();

            let q = Arc::new(OutQ::default());
            for act in [Act::SetTask(Some("must not commit".into())), Act::Revive] {
                let cmd = Cmd::Act {
                    epoch: None,
                    act,
                    reply: Reply::for_test(2, q.clone()),
                };
                ctx.registry.deliver("a", cmd).await;
                assert_eq!(next_reply(&q).await["code"], "faulted");
            }
            let (done, stopped) = oneshot::channel();
            ctx.registry.deliver("a", Cmd::Shutdown { done }).await;
            stopped.await.unwrap();
            assert_eq!(fs::read(&meta).unwrap(), metadata);
            assert_eq!(fs::read(&journal).unwrap(), prefix);

            restart(&ctx, opened["summary"]["createdAt"].as_u64().unwrap()).await;
            let (opened, _) = attach_session(&ctx).await;
            assert_eq!(opened["summary"]["fault"], Value::Null);
            assert_eq!(opened["summary"]["createdAt"], epoch);
            assert_eq!(opened["summary"]["acp"]["task"], "original");
            assert_eq!(opened["head"], 1);
        }
    }

    #[tokio::test]
    async fn forget_unreadable_session_releases_sid_only_after_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let (actor, _rx) = dormant(dir.path()).await;
        let (ctx, journal, meta) = (actor.ctx.clone(), actor.path("jsonl"), actor.path("json"));
        let epoch = actor.created_at;
        drop(actor);
        fs::remove_file(&journal).unwrap();
        fs::create_dir(&journal).unwrap(); // Both open-for-write and unlink fail, even as root.
        restart(&ctx, epoch).await;
        let forget = || {
            let q = Arc::new(OutQ::default());
            let cmd = Cmd::Act {
                epoch: None,
                act: Act::Kill { forget: true },
                reply: Reply::for_test(1, q.clone()),
            };
            (cmd, q)
        };
        let (cmd, rejected) = forget();
        ctx.registry.deliver("a", cmd).await;
        let reply = next_reply(&rejected).await;
        assert_eq!(reply["code"], "internal", "{reply}");
        assert!(reply["message"].as_str().unwrap().contains("deleting"));
        assert_eq!(ctx.registry.kind("a"), Some(Kind::Acp));
        assert!(
            meta.is_file(),
            "failed forget removed the session's lookup name"
        );

        fs::remove_dir(&journal).unwrap();
        std::os::unix::fs::symlink(&journal, &journal).unwrap(); // Still unreadable, but removable.
        let (cmd, forgotten) = forget();
        ctx.registry.deliver("a", cmd).await;
        assert_eq!(next_reply(&forgotten).await["t"], "ok");
        assert!(ctx.registry.kind("a").is_none());
        assert!(!meta.exists() && !journal.is_symlink());
    }

    #[tokio::test]
    async fn writerless_worktree_removal_does_not_strand_kill() {
        let dir = tempfile::tempdir().unwrap();
        let (mut actor, _rx) = dormant(dir.path()).await;
        // A failed forget drops the writer but retains the managed checkout record.
        actor.journal = None;
        actor.meta.managed_worktree = Some(ManagedWorktree {
            main_root: actor.meta.cwd.clone(),
            path: dir.path().join("absent-checkout").display().to_string(),
            branch: "topic".into(),
        });
        Arc::get_mut(&mut actor.ctx).unwrap().cfg.git = Some(dir.path().join("unused-git"));
        let remove = Arc::new(OutQ::default());
        let kill = Arc::new(OutQ::default());
        for (act, q) in [
            (Act::RemoveWorktree, &remove),
            (Act::Kill { forget: false }, &kill),
        ] {
            actor
                .command(Cmd::Act {
                    epoch: None,
                    act,
                    reply: Reply::for_test(1, q.clone()),
                })
                .await;
        }
        // Deliver any git completion *after* the kill, without racing the actor's select.
        if let Some(result) = actor.git.join_next().await {
            actor.worktree_done(result).await;
        }
        kill.finish();
        assert_eq!(read_reply(&kill).await["t"], "ok");
        assert_eq!(next_reply(&remove).await["code"], "faulted");
        assert!(actor.meta.managed_worktree.is_some());
    }

    #[test]
    fn the_session_record_is_camel_case() {
        let meta = Meta {
            sid: "n_1".into(),
            agent: "stub".into(),
            cwd: "/home/alice".into(),
            host: None,
            created_at: 7,
            agent_session_id: Some("s-1".into()),
            init: Some(json!({"protocolVersion": 1})),
            seen_seq: 3,
            managed_worktree: None,
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            v,
            json!({"sid": "n_1", "agent": "stub", "cwd": "/home/alice", "createdAt": 7,
                   "agentSessionId": "s-1", "init": {"protocolVersion": 1}, "seenSeq": 3})
        );
        assert_eq!(serde_json::from_value::<Meta>(v).unwrap(), meta);

        let remote = Meta {
            host: Some("laptop".into()),
            ..meta
        };
        let v = serde_json::to_value(&remote).unwrap();
        assert_eq!(v["host"], "laptop");
        assert_eq!(serde_json::from_value::<Meta>(v).unwrap(), remote);
    }

    #[test]
    fn the_session_record_keeps_the_managed_worktree() {
        let meta = Meta {
            cwd: "/home/alice/project-wt/feature-a".into(),
            managed_worktree: Some(ManagedWorktree {
                path: "/home/alice/project-wt/feature-a".into(),
                branch: "feature/a".into(),
                main_root: "/home/alice/project".into(),
            }),
            ..Meta::default()
        };
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(
            v["managedWorktree"],
            json!({"path": meta.cwd, "branch": "feature/a", "mainRoot": "/home/alice/project"})
        );
        assert_eq!(serde_json::from_value::<Meta>(v).unwrap(), meta);
    }

    mod setup_drain {
        use super::*;

        async fn case(run: impl AsyncFnOnce(&mut Acp)) {
            watchdog(async {
                let dir = tempfile::tempdir().unwrap();
                let (mut acp, _rx) = dormant(dir.path()).await;
                run(&mut acp).await;
            })
            .await;
        }

        fn init() -> Value {
            json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
                "authMethods":[{"id":"login","name":"Log in"}],
                "agentCapabilities":{"loadSession":true,"sessionCapabilities":{"resume":{}}}}})
        }

        fn auth_required() -> Value {
            json!({"jsonrpc":"2.0","id":2,"error":{"code":AUTH_REQUIRED,"message":"log in"}})
        }

        // Answer each outstanding request through the real pipes. Drive the actor inputs
        // separately so its last response is buffered when it first observes the exit.
        fn spawn(acp: &mut Acp, via: SpawnVia, replies: &[Value], eof_first: bool) {
            let mut script = String::from(
                r#"for reply in "$@"; do read -r request || exit 1; printf '%s\n' "$reply"; done"#,
            );
            if eof_first {
                script.push_str("; exec 1>&-; ");
                script.push_str(READ_INPUT);
            }
            configure_test_agent(acp, &script);
            let cfg = &mut Arc::get_mut(&mut acp.ctx).unwrap().cfg;
            let argv = &mut cfg.agents.get_mut("offline").unwrap().argv;
            argv.push("setup-test-agent".into()); // shell's $0
            argv.extend(replies.iter().map(Value::to_string));
            acp.spawn(via).unwrap();
        }

        async fn output(acp: &mut Acp) -> Out {
            let stdout = &mut acp.proc.as_mut().unwrap().agent.stdout;
            stdout.recv().await.expect("stdout reader disappeared")
        }

        async fn response(acp: &mut Acp) {
            let Out::Msg(msg) = output(acp).await else {
                panic!("expected a response before EOF");
            };
            acp.agent_message(msg).await;
        }

        async fn begin_drain(acp: &mut Acp, eof_first: bool) -> mpsc::UnboundedReceiver<Vec<u8>> {
            let agent = &mut acp.proc.as_mut().unwrap().agent;
            let status = if eof_first {
                assert!(matches!(agent.stdout.recv().await, Some(Out::Eof)));
                None
            } else {
                Some(wait_success(agent).await)
            };
            // A dead pipe could reject a continuation without advancing next_id.
            // Keep stdin receptive from the instant the actor observes exit/EOF.
            let writes = agent.stdin.as_mut().unwrap().capture();
            match status {
                Some(status) => acp.child_exited(Ok(status)),
                None => acp.stdout_closed(),
            }
            writes
        }

        async fn eof(acp: &mut Acp) {
            assert!(matches!(output(acp).await, Out::Eof));
            acp.stdout_closed();
        }

        fn no_next_request(acp: &Acp, mut writes: mpsc::UnboundedReceiver<Vec<u8>>) {
            match writes.try_recv() {
                Ok(line) => panic!("RPC during drain: {}", String::from_utf8_lossy(&line)),
                Err(mpsc::error::TryRecvError::Empty) => {}
                Err(e) => panic!("test stdin closed: {e}"),
            }
            assert!(acp.proc.as_ref().unwrap().outstanding.is_empty());
        }

        #[tokio::test]
        async fn failed_setup_refuses_authenticate_after_exit_or_eof() {
            for eof_first in [false, true] {
                case(async |acp| {
                    spawn(acp, SpawnVia::New, &[init(), auth_required()], eof_first);
                    response(acp).await;
                    response(acp).await;
                    let last = acp.facts.last.as_ref().unwrap();
                    assert_eq!(last.error.as_ref().unwrap().code, "auth_required");
                    assert!(!acp.has_session && acp.stage.is_none());
                    let writes = begin_drain(acp, eof_first).await;

                    let path = acp.path("jsonl");
                    let before = fs::read(&path).unwrap();
                    let seen = acp.meta.seen_seq;
                    let q = Arc::new(OutQ::default());
                    acp.act(
                        Act::Authenticate("login".into()),
                        Reply::for_test(1, q.clone()),
                    );
                    no_next_request(acp, writes);
                    assert_eq!(read_reply(&q).await["code"], "not_alive");
                    assert_eq!(acp.meta.seen_seq, seen);
                    assert_eq!(fs::read(path).unwrap(), before);
                })
                .await;
            }
        }

        #[tokio::test]
        async fn buffered_authenticate_answers_without_opening_a_session() {
            case(async |acp| {
                let ok = json!({"jsonrpc":"2.0","id":3,"result":{}});
                spawn(acp, SpawnVia::New, &[init(), auth_required(), ok], false);
                response(acp).await;
                response(acp).await;
                let q = Arc::new(OutQ::default());
                acp.act(
                    Act::Authenticate("login".into()),
                    Reply::for_test(1, q.clone()),
                );
                let writes = begin_drain(acp, false).await;
                response(acp).await;
                no_next_request(acp, writes);
                assert_eq!(read_reply(&q).await["t"], "ok");
            })
            .await;
        }

        #[tokio::test]
        async fn buffered_resume_failure_does_not_fall_back_to_load() {
            case(async |acp| {
                acp.facts.agent_session_id = Some("old".into());
                let failed =
                    json!({"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no resume"}});
                spawn(acp, SpawnVia::Revive, &[init(), failed], false);
                response(acp).await;
                let writes = begin_drain(acp, false).await;
                response(acp).await;
                no_next_request(acp, writes);
                assert!(!acp.load_filter);
            })
            .await;
        }

        fn initial_batch(acp: &mut Acp) -> Arc<OutQ> {
            let q = Arc::new(OutQ::default());
            acp.startup_config = Some(StartupConfig {
                open: Open {
                    viewer: Viewer {
                        id: 1,
                        outq: q.clone(),
                    },
                    since: 0,
                    epoch: None,
                    spawn: None,
                    reply: Reply::for_test(1, q.clone()),
                },
                remaining: serde_json::from_value(json!([
                    {"id":"first","value":true},{"id":"second","value":true}
                ]))
                .unwrap(),
                current: None,
                errors: Vec::new(),
            });
            q
        }

        async fn creating_reply(acp: &Acp, q: &OutQ) -> Value {
            assert!(acp.startup_config.is_none(), "creating open still held");
            let opened = read_reply(q).await;
            assert_eq!(opened["new"], true, "{opened}");
            opened
        }

        async fn initial_options(responses: usize) {
            case(async |acp| {
                let q = initial_batch(acp);
                let options = |applied| {
                    json!([
                        {"id":"first","name":"First","type":"boolean","currentValue":applied},
                        {"id":"second","name":"Second","type":"boolean","currentValue":false}
                    ])
                };
                let replies = [
                    init(),
                    json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"s","configOptions":options(false)}}),
                    json!({"jsonrpc":"2.0","id":3,"result":{"configOptions":options(true)}}),
                ];
                spawn(acp, SpawnVia::New, &replies[..responses], false);
                for _ in 1..responses {
                    response(acp).await;
                }
                let writes = begin_drain(acp, false).await;
                if responses == 0 {
                    // Exit alone cannot settle initialize: only EOF tells the actor
                    // that no buffered response will arrive to release the open.
                    assert!(acp.startup_config.is_some());
                    eof(acp).await;
                } else {
                    response(acp).await;
                    no_next_request(acp, writes);
                    assert_eq!(acp.meta.init.as_ref(), Some(&replies[0]["result"]));
                }
                let opened = creating_reply(acp, &q).await;
                let applied = responses == 3;
                if responses >= 2 {
                    assert_eq!(acp.meta.agent_session_id.as_deref(), Some("s"));
                    assert_eq!(opened["session"]["configOptions"], options(applied));
                }
                let unapplied = if applied {
                    &["second"][..]
                } else {
                    &["first", "second"][..]
                };
                assert_unapplied(&opened, unapplied);
                if responses != 0 {
                    eof(acp).await;
                }
            })
            .await;
        }

        fn assert_unapplied(opened: &Value, unapplied: &[&str]) {
            let errors = opened["configErrors"].as_array().unwrap();
            assert_eq!(errors.len(), unapplied.len());
            for (error, id) in errors.iter().zip(unapplied) {
                assert_eq!(error["id"], *id);
                assert_eq!(error["value"], true);
                assert_eq!(error["code"], "not_alive");
            }
        }

        #[tokio::test]
        async fn buffered_setup_error_is_recorded_but_unattempted_options_are_not_alive() {
            case(async |acp| {
                let q = initial_batch(acp);
                spawn(acp, SpawnVia::New, &[init(), auth_required()], false);
                response(acp).await;
                let writes = begin_drain(acp, false).await;
                response(acp).await;
                let last = acp.facts.last.as_ref().unwrap();
                assert_eq!(last.error.as_ref().unwrap().code, "auth_required");
                no_next_request(acp, writes);
                assert_unapplied(&creating_reply(acp, &q).await, &["first", "second"]);
            })
            .await;
        }

        #[tokio::test]
        async fn exit_during_initialize_fails_unapplied_options() {
            initial_options(0).await;
        }

        #[tokio::test]
        async fn buffered_initialize_is_saved_without_opening_a_session() {
            initial_options(1).await;
        }

        #[tokio::test]
        async fn buffered_session_is_recorded_without_starting_initial_options() {
            initial_options(2).await;
        }

        #[tokio::test]
        async fn buffered_option_is_applied_without_starting_the_next() {
            initial_options(3).await;
        }
    }
}
