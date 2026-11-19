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
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitStatus;
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

use self::agent::{Agent, Out};
use self::facts::Facts;
use self::journal::{Journal, WriteFault};
use self::replay::Replay;
use self::rpc::Incoming;
use self::worktree::CreateFailure::{self, Clean, PossibleLeftover};
use crate::conn::{ConnId, Reply, Viewer, line};
use crate::outq::OutQ;
use crate::registry::Route;
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
}

impl Cmd {
    /// Answers a command that the session can no longer carry out.
    pub fn refuse(self, code: ErrorCode, message: &str) {
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
            match ctx.registry.route(&sid, open.spawn.is_some()) {
                Route::Send(tx) => {
                    if let Ok(permit) = tx.reserve().await {
                        return permit.send(Cmd::Open(open));
                    }
                }
                Route::Created { created_at, rx } => {
                    return start(
                        ctx.clone(),
                        sid,
                        created_at,
                        rx,
                        Start::Create(Box::new(open)),
                    );
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

/// Retains the request string when it is already canonical.
fn checked_task(task: Option<String>) -> Result<Option<String>, &'static str> {
    let Some(raw) = &task else { return Ok(None) };
    match wb_proto::hub::normalize_task(raw)? {
        Some(trimmed) if trimmed.len() == raw.len() => Ok(task),
        trimmed => Ok(trimmed.map(str::to_owned)),
    }
}

/// Registers and starts the session `sid` found in the state directory at startup. A
/// session that fails to load is quarantined and shows the fault.
pub async fn load(ctx: &Arc<Ctx>, sid: String) {
    let (created_at, from) = match read(ctx, &sid).await {
        Ok(Some(loaded)) => (
            Some(loaded.meta.created_at),
            Start::Loaded(Box::new(loaded)),
        ),
        Ok(None) => return,
        Err(fault) => (None, Start::Faulted(fault)),
    };
    let (created_at, rx) = ctx.registry.load(&sid, created_at);
    start(ctx.clone(), sid, created_at, rx, from);
}

/// What a session's actor starts from.
enum Start {
    /// A new sid, and the open with spawn fields that created it.
    Create(Box<Open>),
    /// A session read from the state directory: a dead one.
    Loaded(Box<Loaded>),
    /// A session whose files failed to load and were quarantined; the reason.
    Faulted(String),
}

struct Loaded {
    meta: Meta,
    journal: Journal,
    facts: Facts,
    policy: Option<CompiledPolicy>,
    announced: BTreeMap<u64, PendingKind>,
    /// Startup normalisation could not complete the journal.
    fault: Option<String>,
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

/// Reads the session `sid` off the calling task and completes a journal that a hub
/// stop or crash left with a live agent (startup normalisation). `Ok(None)`: there is
/// no session. A session that fails to load, by an error or a panic, is quarantined,
/// and the error is the fault message.
async fn read(ctx: &Ctx, sid: &str) -> Result<Option<Loaded>, String> {
    let (dir, s) = (ctx.acp_dir.clone(), sid.to_owned());
    let failure = match tokio::task::spawn_blocking(move || read_files(&dir, &s)).await {
        Ok(Ok(None)) => return Ok(None),
        Ok(Ok(Some((loaded, appended)))) => {
            if appended && let Ok(Err(e)) = loaded.journal.sync().await {
                warn!(%sid, "syncing the journal: {e}");
            }
            return Ok(Some(loaded));
        }
        Ok(Err(e)) => format!("{e:#}"),
        Err(e) => format!("loading panicked: {e}"),
    };
    warn!(%sid, "quarantining the session: {failure}");
    let (dir, s) = (ctx.acp_dir.clone(), sid.to_owned());
    if let Ok(Err(e)) = tokio::task::spawn_blocking(move || quarantine(&dir, &s)).await {
        warn!(%sid, "quarantining the session: {e}");
    }
    Err(failure)
}

/// The record, the journal and its fold, normalised; whether normalisation appended.
fn read_files(dir: &Path, sid: &str) -> anyhow::Result<Option<(Loaded, bool)>> {
    let name = format!("{sid}.json");
    let text = match fs::read(dir.join(&name)) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context(name),
    };
    let meta: Meta = serde_json::from_slice(&text).context(name.clone())?;
    if meta.sid != sid {
        bail!("{name} holds sid {:?}", meta.sid);
    }
    let (mut journal, events) = Journal::open(&dir.join(format!("{sid}.jsonl")))?;
    let mut facts = Facts::default();
    let mut announced = BTreeMap::new();
    let mut policy_notice = false;
    for ev in &events {
        facts.apply(ev);
        announce(&mut announced, ev);
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
    }
    let policy = facts
        .policy
        .as_ref()
        .map(|policy| CompiledPolicy::new(policy, &meta.cwd, meta.agent == "omp"))
        .transpose()
        .map_err(anyhow::Error::msg)?;
    let (mut appended, mut fault) = match journal.normalise(&mut facts, now_ms()) {
        Ok(written) => (!written.is_empty(), None),
        Err(f) => {
            error!(%sid, "completing the journal: {}", f.error);
            (false, Some(fault_message(&f)))
        }
    };
    if policy_notice && fault.is_none() {
        let notice = EventBody::Notice {
            level: NoticeLevel::Warn,
            text: INVALID_POLICY_NOTICE.into(),
        };
        match journal.append(&notice, now_ms()) {
            Ok(ev) => {
                facts.apply(&ev);
                appended = true;
            }
            Err(f) => {
                error!(%sid, "recording the cleared policy notice: {}", f.error);
                fault = Some(fault_message(&f));
            }
        }
    }
    let loaded = Loaded {
        meta,
        journal,
        facts,
        policy,
        announced,
        fault,
    };
    Ok(Some((loaded, appended)))
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
    for ext in FILES {
        match fs::remove_file(dir.join(format!("{sid}.{ext}"))) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    }
    File::open(dir)?.sync_all()
}

/// Starts the supervised actor of a registered session. A loaded or faulted session is
/// published before this returns.
fn start(ctx: Arc<Ctx>, sid: String, created_at: u64, rx: mpsc::Receiver<Cmd>, from: Start) {
    let mut acp = Acp::new(ctx, sid, created_at, Arc::default());
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
        if let Some(pgid) = lock(&shared.pgid).take() {
            agent::end_group(pgid, PANIC_GRACE);
        }
        let dropped = take_viewers(&shared);
        let Some(next) = next else {
            return tell_reloaded(&sid, dropped);
        };
        let from = match read(&ctx, &sid).await {
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
            Err(fault) => Start::Faulted(fault),
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

/// Delivers a command that reached a forgotten actor to whatever now holds `sid`: an
/// open is routed as a new request, anything else goes to the current session, if any.
async fn redeliver(ctx: &Arc<Ctx>, sid: &str, cmd: Cmd) {
    const FORGOTTEN: &str = "the session was forgotten";
    match cmd {
        Cmd::Open(o) => open(ctx.clone(), sid.to_owned(), o).await,
        cmd => match ctx.registry.sender::<Cmd>(sid) {
            Some(tx) => {
                if let Err(unsent) = tx.send(cmd).await {
                    unsent.0.refuse(ErrorCode::NotFound, FORGOTTEN);
                }
            }
            None => cmd.refuse(ErrorCode::NotFound, FORGOTTEN),
        },
    }
}

/// What the supervisor needs after a panic: the attached connections and the agent's
/// process group.
#[derive(Default)]
struct Shared {
    viewers: Mutex<Vec<Attached>>,
    pgid: Mutex<Option<u32>>,
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
    /// Code and signal once `wait` returned.
    status: Option<(Option<i32>, Option<i32>)>,
    /// Stdout reached its end.
    eof: bool,
    /// After the exit, until when stdout may still deliver; after the end of stdout,
    /// until when the agent may still exit before SIGKILL.
    drain_until: Option<Instant>,
}

impl Proc {
    /// Queues `msg` for the agent; false if it is not reading stdin.
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
    Exited(io::Result<ExitStatus>),
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
                    fault,
                } = *loaded;
                self.meta = meta;
                self.journal = Some(journal);
                self.facts = facts;
                self.policy = policy;
                self.announced = announced;
                if let Some(message) = fault {
                    self.fault = Some(Fault {
                        code: FaultCode::JournalWrite,
                        message,
                    });
                    self.fault_exit = Some((None, None, ExitReason::HubRestart));
                    self.probe_at = Some(Instant::now() + PROBE_EVERY);
                }
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
        while self.phase == Phase::Running {
            // A due record goes to disk before the next event: revive depends on `init`,
            // and a hub killed after the `session` line must still find it (10 §7.4).
            if self.meta_at.is_some_and(|at| at <= Instant::now()) {
                self.save_meta().await;
            }
            let setup_at = self.setup_at.filter(|_| self.setup_waiting());
            let rpc_at = self.rpc_deadline();
            let stage_at = self.stage.and_then(|(_, at)| at);
            let (info_at, meta_at, probe_at) = (self.info_at, self.meta_at, self.probe_at);
            let (out, child, drain_until) = match &mut self.proc {
                Some(p) => (
                    (!p.eof).then_some(&mut p.agent.stdout),
                    p.status.is_none().then_some(&mut p.agent.child),
                    p.drain_until,
                ),
                None => (None, None, None),
            };
            let event = tokio::select! {
                cmd = rx.recv() => Event::Cmd(cmd),
                Some(result) = self.git.join_next(), if self.worktree_op.is_some() => Event::Worktree(result),
                Some(r) = self.replayed_rx.recv() => Event::Replayed(r),
                out = recv(out) => Event::Out(out),
                st = wait(child) => Event::Exited(st),
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
                Event::Out(Some(Out::Msg(msg))) => self.agent_message(msg),
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
                if let Err(e) = self.delete_files().await {
                    warn!("deleting the session's files: {e}");
                }
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
                if let Some(journal) = &self.journal
                    && let Ok(Err(e)) = journal.sync().await
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
                } if self.journal.is_none() => {
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
                Cmd::Act { act, reply }
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
            Cmd::Act { act, reply } => self.act(act, reply),
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
                let git = ctx.cfg.git.as_deref().expect("validated worktree request");
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
        let json = serde_json::to_vec(&self.meta);
        let made = tokio::task::spawn_blocking(move || {
            // Files an earlier incarnation failed to delete must not leak into this one.
            delete(&dir, &sid)?;
            let opened = write_atomic(&dir, &format!("{sid}.json"), &json?).and_then(|()| {
                Journal::open(&dir.join(format!("{sid}.jsonl")))
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
            Ok((journal, _)) => self.journal = Some(journal),
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

    /// Starts the agent and sends `initialize`. A failure is journaled as
    /// `setup_error{spawn_failed}` with no `spawn` (DESIGN §3.4.4) and returned.
    fn spawn(&mut self, via: SpawnVia) -> Result<(), String> {
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
                self.record(EventBody::SetupError {
                    code: SetupErrorCode::SpawnFailed,
                    message: message.clone(),
                    rpc: None,
                });
                return Err(message);
            }
        };
        let pid = agent.pid;
        info!(pid, agent = %self.meta.agent, ?via, "spawned");
        *lock(&self.shared.pgid) = Some(pid);
        self.proc = Some(Proc {
            agent,
            via,
            next_id: 1,
            outstanding: HashMap::new(),
            status: None,
            eof: false,
            drain_until: None,
        });
        self.setup_at = Some(Instant::now() + SETUP_IDLE_TIMEOUT);
        if self.record(EventBody::Spawn { pid, via }) {
            let _ = self.request(Purpose::Init, rpc::initialize);
        }
        Ok(())
    }

    /// Sends a request to the agent. The purpose comes back if the agent is not reading
    /// stdin.
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

    /// Queues `msg` for the agent; false if there is none or it is not reading stdin.
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
        match journal.append(&body, now_ms()) {
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
            EventBody::SetupError { code, message, .. } => Some((
                match code {
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
        self.facts.apply(&ev);
        let msg = line(&HubMessage::AcpEv {
            sid: self.sid.clone(),
            ev: Box::new(ev),
        });
        self.fan_out(&msg);
        self.publish();
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
            match journal.append(&body, now_ms()) {
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

    /// The Summary and session info as they are now, with the last `updatedAt`.
    fn snapshot(&self) -> (Summary, AcpSessionInfo) {
        let viewers = lock(&self.shared.viewers).len();
        let facts = &self.facts;
        let summary = Summary {
            sid: self.sid.clone(),
            kind: Kind::Acp,
            host: self
                .meta
                .host
                .as_ref()
                .unwrap_or(&self.ctx.cfg.host)
                .clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
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
        let (summary, session) = self.snapshot();
        if let Some((last, last_session)) = &self.published {
            if *last == summary && *last_session == session {
                return;
            }
            let mut same = summary.clone();
            if let (Some(now), Some(then)) = (&mut same.acp, &last.acp) {
                now.head_seq = then.head_seq;
            }
            let next = self.published_at.map(|at| at + INFO_EVERY);
            if same == *last
                && session == *last_session
                && let Some(next) = next.filter(|&at| at > Instant::now())
            {
                self.info_at = Some(self.info_at.unwrap_or(next));
                return;
            }
        }
        self.flush_info();
    }

    fn flush_info(&mut self) {
        self.info_at = None;
        self.updated_at = now_ms().max(self.updated_at);
        let (summary, session) = self.snapshot();
        self.ctx.registry.publish(&summary);
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
        let (summary, session) = self.snapshot();
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
            return reply.err(ErrorCode::Busy, "startup configuration is being applied");
        }
        match act {
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

    /// Refuses an action on a session without a working agent and ACP session; the
    /// error, if any.
    fn check_live(&self) -> Result<(), (ErrorCode, &'static str)> {
        if self.fault.is_some() {
            Err((ErrorCode::Faulted, "the session has a fault"))
        } else if self.proc.is_none() || self.stage.is_some() {
            Err((ErrorCode::NotAlive, "the agent is not running"))
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
            Err(_) => reply.err(ErrorCode::Internal, "agent not reading stdin"),
        }
    }

    fn cancel(&mut self, reply: Reply) {
        if self.facts.activity == Activity::Turn {
            self.turn_cancelled = true;
        }
        if self.facts.activity == Activity::Turn
            && let Some(session) = &self.facts.agent_session_id
        {
            self.send(&rpc::cancel(session));
        }
        let held: Vec<(u64, PendingKind)> = self.held.iter().map(|(r, h)| (*r, h.kind)).collect();
        for (req, kind) in held {
            if !self.resolve(req, cancelled(kind), ResolvedBy::Cancel) {
                break;
            }
        }
        self.set_seen(self.facts.head_seq);
        reply.done();
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
        let checked = match kind {
            PendingKind::Permission => check_outcome(&answer, &held.option_ids),
            _ => check_response(&answer),
        };
        if let Err((code, msg)) = checked {
            return reply.err(code, msg);
        }
        if !self.resolve(req, answer, ResolvedBy::User) {
            return reply.err(ErrorCode::Faulted, JOURNAL_FAILED);
        }
        self.set_seen(self.facts.head_seq);
        reply.done();
    }

    /// Answers the held request `req` with `answer`, journal first so a fault never
    /// leaves the agent with two answers. False if nothing could be journaled.
    fn resolve(&mut self, req: u64, answer: Value, by: ResolvedBy) -> bool {
        let Some(held) = self.held.get(&req) else {
            return false;
        };
        let (kind, rpc_id) = (held.kind, held.rpc_id.clone());
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
            return false;
        }
        self.held.remove(&req);
        self.send(&rpc::result(&rpc_id, to_agent(kind, answer)));
        if self.held.is_empty() {
            // Deviation 8: the setup clock restarts once nobody is waited for.
            self.setup_at = Some(Instant::now() + SETUP_IDLE_TIMEOUT);
        }
        true
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
        // An unpublished or quarantined session has no record of its own to write.
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
            Err(msg) => reply.err(ErrorCode::SpawnFailed, msg),
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
            let git = ctx.cfg.git.as_deref().expect("configured worktree removal");
            WorktreeResult::Removed(worktree::remove(git, &record, &sid).await)
        });
    }

    fn remove_worktree(&mut self, reply: Reply) {
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

    /// Signals the agent's process group, unless the agent was reaped and its pid may
    /// be reused.
    fn signal(&self, sig: Signal) {
        if let Some(p) = self.proc.as_ref().filter(|p| p.status.is_none()) {
            agent::signal_group(p.agent.pid, sig);
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

    fn agent_message(&mut self, msg: Map<String, Value>) {
        self.setup_at = Some(Instant::now() + SETUP_IDLE_TIMEOUT);
        match rpc::classify(msg) {
            Incoming::Response { id, outcome } => {
                match self.proc.as_mut().and_then(|p| p.outstanding.remove(&id)) {
                    Some(purpose) => self.response(purpose, outcome),
                    None => self.log(&format!("dropped a response to unknown id {id}")),
                }
            }
            Incoming::Request { id, method, params } => self.agent_request(id, &method, params),
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

    fn agent_request(&mut self, id: Value, method: &str, params: Value) {
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
                            .map(|journal| journal.append(&body, now_ms()))
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
                self.hold(id, PendingKind::Permission, option_ids, body);
            }
            "elicitation/create" => {
                let body = EventBody::Elicitation { request: params };
                self.hold(id, PendingKind::Elicitation, Vec::new(), body);
            }
            _ => {
                self.log(&format!("answered the agent request {method} with -32601"));
                self.send(&rpc::method_not_found(&id));
            }
        }
    }

    /// Journals an agent request and holds it until a viewer, a cancel, the agent or
    /// the agent's death answers it. A request that cannot be journaled is cancelled.
    fn hold(&mut self, rpc_id: Value, kind: PendingKind, option_ids: Vec<String>, body: EventBody) {
        if self.record(body) {
            let held = HeldReq {
                rpc_id,
                kind,
                option_ids,
            };
            self.held.insert(self.facts.head_seq, held);
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
                    self.resolve(req, cancelled(kind), ResolvedBy::Agent);
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

    fn child_exited(&mut self, st: io::Result<ExitStatus>) {
        let Some(p) = &mut self.proc else { return };
        p.status = Some(match st {
            Ok(st) => (st.code(), st.signal()),
            Err(e) => {
                warn!("waiting for the agent: {e}");
                (None, None)
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
            agent::signal_group(p.agent.pid, Signal::KILL);
        }
    }

    /// The agent is gone: what is left of its process group is ended (H-11), the death
    /// invariant is journaled (DESIGN §3.4.4), and what waited on the agent is answered.
    fn finalise(&mut self) {
        let Some(p) = self.proc.take() else { return };
        let (code, signal) = p.status.unwrap_or((None, None));
        if agent::group_alive(p.agent.pid) {
            agent::end_group(p.agent.pid, LEFTOVER_GRACE);
        }
        *lock(&self.shared.pgid) = None;
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
        let last = p.agent.log.last_line();
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
                replay::scan(&path, since, head, &pinned, ACP_REPLAY_MAX)
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

async fn wait(child: Option<&mut tokio::process::Child>) -> io::Result<ExitStatus> {
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
    use serde_json::json;

    use super::*;

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
}
