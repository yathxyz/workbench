//! The hub protocol on `hub.sock`.
//!
//! The hub sends [`HubMessage`] lines and reads [`HubRequest`] lines; it speaks first,
//! with [`HubMessage::Hello`]. A request that carries a `rid` gets exactly one reply,
//! [`HubMessage::Ok`] or [`HubMessage::Err`], with the same `rid`. The fields of an `ok`
//! reply depend on the request, so the client matches the reply by `rid` and decodes its
//! `result` into the reply type of the request it sent: [`SessionsReply`],
//! [`PtyOpenReply`], [`CaptureReply`], or nothing for `{}`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Protocol version carried by both hellos.
pub const PROTO: u32 = 1;

/// A line from a client to the hub.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum HubRequest {
    /// The client's answer to the hub's hello, and its first line.
    #[serde(rename = "hello")]
    Hello { proto: u32, client: String },
    /// Every known session. Reply: [`SessionsReply`].
    #[serde(rename = "list")]
    List { rid: u64 },
    /// Like `list`, then a `session` event on every Summary change and `gone` on forget.
    #[serde(rename = "watch")]
    Watch { rid: u64 },
    /// Attach to a PTY session. Only a request with `spawn` starts a process.
    /// Reply: [`PtyOpenReply`].
    #[serde(rename = "pty.open")]
    PtyOpen {
        rid: u64,
        sid: String,
        cols: u32,
        rows: u32,
        #[serde(skip_serializing_if = "Option::is_none")]
        spawn: Option<SpawnPty>,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume: Option<Resume>,
    },
    /// Stop events for `sid` on this connection. Reply: `{}`.
    #[serde(rename = "pty.detach")]
    PtyDetach { rid: u64, sid: String },
    /// Input for the PTY, at most `PTY_INPUT_FRAME` bytes. No reply.
    #[serde(rename = "pty.input")]
    PtyInput { sid: String, d: String },
    /// New terminal size; the hub clamps it to cols 2..=1000, rows 1..=500. No reply.
    #[serde(rename = "pty.resize")]
    PtyResize { sid: String, cols: u32, rows: u32 },
    /// End the PTY session; with `forget`, also delete it. Reply: `{}`.
    #[serde(rename = "pty.kill")]
    PtyKill { rid: u64, sid: String, forget: bool },
    /// Plain text of the last `lines` lines (default 200, at most `CAPTURE_MAX`).
    /// Reply: [`CaptureReply`].
    #[serde(rename = "pty.capture")]
    PtyCapture {
        rid: u64,
        sid: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        lines: Option<u32>,
    },
    /// Any request type this version does not know.
    #[serde(other)]
    Unknown,
}

/// A line from the hub to a client: a hello, a reply or an event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum HubMessage {
    /// The hub's first line on every connection.
    #[serde(rename = "hello")]
    Hello {
        proto: u32,
        server: String,
        version: String,
        /// Build id of the hub; absent in local cargo builds.
        #[serde(skip_serializing_if = "Option::is_none")]
        build: Option<String>,
        host: String,
        pid: u32,
        started_at: u64,
        agents: Vec<Agent>,
        /// Names of the configured shells that had an executable path when this
        /// connection opened, in the hub's config order. Empty from an older hub.
        #[serde(default)]
        shells: Vec<String>,
        /// The shell a [`SpawnPty`] without `shell` gets. Empty from an older hub.
        #[serde(default)]
        default_shell: String,
    },
    /// Success reply to the request with this `rid`; `result` holds the reply fields.
    #[serde(rename = "ok")]
    Ok {
        rid: u64,
        #[serde(flatten)]
        result: Map<String, Value>,
    },
    /// Failure reply (with `rid`) or asynchronous error (with `sid`, or neither).
    #[serde(rename = "err")]
    Err {
        #[serde(skip_serializing_if = "Option::is_none")]
        rid: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        sid: Option<String>,
        code: ErrorCode,
        message: String,
    },
    /// PTY output decoded as text; `out` is the stream's byte offset after `d`.
    #[serde(rename = "pty.out")]
    PtyOut { sid: String, d: String, out: u64 },
    /// The PTY's foreground process changed.
    #[serde(rename = "pty.fg")]
    PtyFg {
        sid: String,
        comm: String,
        cwd: String,
    },
    /// The PTY's child exited.
    #[serde(rename = "pty.exit")]
    PtyExit {
        sid: String,
        code: Option<i32>,
        signal: Option<i32>,
        reason: ExitReason,
    },
    /// A session's Summary changed (sent to watchers).
    #[serde(rename = "session")]
    Session { session: Box<Summary> },
    /// The incarnation `epoch` of `sid` was forgotten.
    #[serde(rename = "gone")]
    Gone { sid: String, epoch: u64 },
    /// Any message type this version does not know.
    #[serde(other)]
    Unknown,
}

impl HubMessage {
    /// An `ok` reply whose fields are those of `result`.
    ///
    /// # Panics
    ///
    /// If `result` does not serialize to a JSON object. Every reply type in this module
    /// does.
    pub fn ok(rid: u64, result: &impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(Value::Object(result)) => Self::Ok { rid, result },
            _ => panic!("an ok reply must serialize to a JSON object"),
        }
    }
}

/// The closed set of error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Malformed request or a limit exceeded.
    BadRequest,
    /// Unknown sid, or an open without spawn fields for an unknown sid.
    NotFound,
    /// The sid exists with the other kind.
    KindMismatch,
    /// Needs a live process.
    NotAlive,
    /// An ACP turn is outstanding.
    Busy,
    /// The permission or elicitation was already answered.
    AlreadyResolved,
    /// `optionId`, `modeId` or `methodId` not offered.
    BadOption,
    /// Revive is impossible.
    NotRevivable,
    /// Spawn or exec failed.
    SpawnFailed,
    /// The agent returned a JSON-RPC error.
    AgentError,
    /// The agent did not answer in time.
    Timeout,
    /// Agent name not in the hub's table.
    UnknownAgent,
    /// PTY input queue full.
    InputOverflow,
    /// `epoch` does not match the session's current incarnation.
    Stale,
    /// The session has a fault and refuses this action.
    Faulted,
    /// Protocol version mismatch.
    Proto,
    /// Unknown request type.
    UnknownType,
    /// Hub-side failure.
    Internal,
    /// A code this version does not know.
    #[serde(other)]
    Unknown,
}

/// An agent in the hub's table, as listed in the hello.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    pub label: String,
}

/// How to start a PTY child.
///
/// The program is always one of the hub's configured shells, never a path the client
/// names. The hub executes the shell's first configured path that exists and is
/// executable, checked again at every spawn, and gives the child `argv` with `argv[0]`
/// replaced by that path. `argv[0]` is neither executed nor looked up; clients send the
/// shell's name there. `argv[1..]` go to the shell unchanged, for example
/// `["-c", cmd]`. When `argv` has a single item, the hub appends the shell's configured
/// `args` instead, which start it as an interactive shell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPty {
    /// 1..=256 items, at most 256 KiB in total.
    pub argv: Vec<String>,
    /// The name of a shell in the hub's hello `shells`, never a path. Absent means the
    /// shell the session last ran when this is a respawn, and the hub's `defaultShell`
    /// otherwise. An unknown or unavailable name gets `bad_request`
    /// "shell <name> not available".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    /// Absolute path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// A sid whose live cwd takes precedence over `cwd`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd_from: Option<String>,
    /// Extra environment, at most 32 entries; cannot override keys the hub sets.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}

/// Where a viewer's terminal stopped: honoured if `stream` matches and the ring still
/// holds `out`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resume {
    pub stream: u64,
    pub out: u64,
}

/// The hub's facts about one session. The hub never sends `state`; the web adds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// `^[A-Za-z0-9_-]{1,64}$`, the board node id.
    pub sid: String,
    pub kind: Kind,
    pub host: String,
    /// Also the incarnation id: every field named `epoch` carries this value.
    pub created_at: u64,
    /// Last Summary change (not last output byte).
    pub updated_at: u64,
    pub alive: bool,
    pub viewers: u32,
    pub cwd: String,
    pub fault: Option<Fault>,
    /// Present iff `kind` is `pty`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty: Option<PtyFacts>,
    /// Present iff `kind` is `acp`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp: Option<AcpFacts>,
}

/// Session kind; pty and acp share one sid namespace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Pty,
    Acp,
    #[serde(other)]
    Unknown,
}

/// Why a session refuses actions until the fault clears.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fault {
    pub code: FaultCode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FaultCode {
    LoadFailed,
    JournalWrite,
    #[serde(other)]
    Unknown,
}

/// PTY-specific facts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyFacts {
    pub argv: Vec<String>,
    /// Absent when not alive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Absent when not alive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<Fg>,
    /// Absent while alive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<Exit>,
}

/// The PTY's foreground process group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fg {
    pub comm: String,
    pub pgid: u32,
    /// The group is the child's own (`pgid == pid`), so nothing else is in front.
    pub leader: bool,
}

/// How a process ended. `code` and `signal` are null when unknown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub reason: ExitReason,
    pub at: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    Exited,
    Killed,
    HubRestart,
    SpawnFailed,
    #[serde(other)]
    Unknown,
}

/// ACP-specific facts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpFacts {
    pub agent: String,
    /// Null until `session/new`, `session/resume` or `session/load` succeeded.
    pub agent_session_id: Option<String>,
    pub revivable: bool,
    pub activity: Activity,
    /// Unresolved agent requests.
    pub pending: Vec<Pending>,
    pub last: Option<Last>,
    pub head_seq: u64,
    pub seen_seq: u64,
    pub title: Option<String>,
    pub mode_id: Option<String>,
}

/// What is outstanding to the agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    None,
    Setup,
    Turn,
    #[serde(other)]
    Unknown,
}

/// An agent request waiting for a viewer's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    /// Journal seq of the announcing event.
    pub req: u64,
    pub kind: PendingKind,
    /// `toolCall.title`, or the elicitation message cut to 200 characters.
    pub title: String,
    pub ts: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    Permission,
    Elicitation,
    #[serde(other)]
    Unknown,
}

/// How the last turn or setup ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Last {
    pub seq: u64,
    pub ts: u64,
    /// An ACP `stopReason` verbatim, or `"error"`.
    pub outcome: String,
    /// Set when `outcome` is `"error"`.
    pub error: Option<LastError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastError {
    pub code: String,
    pub message: String,
}

/// `ok` reply fields of `list` and `watch`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionsReply {
    pub sessions: Vec<Summary>,
}

/// `ok` reply fields of `pty.open`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyOpenReply {
    /// A process was spawned for this request.
    pub new: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub cwd: String,
    /// Present when attached to a dead session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit: Option<Exit>,
    pub epoch: u64,
    pub stream: u64,
    pub out: u64,
    /// `replay` is the ring after the requested `out`, not a snapshot.
    pub resumed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay: Option<String>,
}

/// `ok` reply fields of `pty.capture`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptureReply {
    pub text: String,
}
