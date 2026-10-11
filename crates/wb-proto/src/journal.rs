//! The ACP journal (`acp/<sid>.jsonl`): one [`JournalEvent`] per line.
//!
//! A line is `{"seq":N,"ts":…,"e":KIND,…payload}`. `seq` starts at 1 and increases by
//! exactly 1 per line. Readers skip an unknown `e`, which decodes as
//! [`EventBody::Unknown`] with `seq` and `ts` intact; it still counts for the head seq.
//! An `Unknown` body carries no payload, so it must never be written or relayed.
//!
//! ACP payloads are verbatim [`Value`]s. `Vec<Value>` is used only where the hub counts
//! or iterates the items: the prompt's content blocks and the permission options.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::hub::ExitReason;

/// One journal line, also the `ev` of an `acp.ev` event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JournalEvent {
    pub seq: u64,
    pub ts: u64,
    #[serde(flatten)]
    pub body: EventBody,
}

/// What happened, tagged by `e`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "e", rename_all_fields = "camelCase")]
pub enum EventBody {
    /// The agent process started.
    #[serde(rename = "spawn")]
    Spawn { pid: u32, via: SpawnVia },
    /// Setup succeeded; the fields of the `session/*` result, verbatim.
    #[serde(rename = "session")]
    Session {
        via: SessionVia,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        modes: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        config_options: Option<Value>,
    },
    /// Setup failed or was cut. An exec failure writes this with no `spawn` and no
    /// `exit`.
    #[serde(rename = "setup_error")]
    SetupError {
        code: SetupErrorCode,
        message: String,
        /// The agent's JSON-RPC error object, verbatim.
        #[serde(skip_serializing_if = "Option::is_none")]
        rpc: Option<Value>,
    },
    /// An `acp.authenticate` was accepted; activity re-enters setup.
    #[serde(rename = "authenticate")]
    Authenticate { method_id: String },
    /// A prompt was sent: its ACP content blocks.
    #[serde(rename = "prompt")]
    Prompt { prompt: Vec<Value> },
    /// A `session/update` notification's `update`, unknown variants included.
    #[serde(rename = "update")]
    Update {
        update: Value,
        /// Present only when it differs from the session's `agentSessionId`.
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    /// The `session/prompt` response arrived; its `stopReason`, verbatim.
    #[serde(rename = "turn_end")]
    TurnEnd { stop_reason: String },
    /// The prompt failed, or the agent died or was killed mid-turn.
    #[serde(rename = "turn_error")]
    TurnError {
        code: TurnErrorCode,
        message: String,
        /// The agent's JSON-RPC error object, verbatim.
        #[serde(skip_serializing_if = "Option::is_none")]
        rpc: Option<Value>,
    },
    /// `session/request_permission` arrived. Its `req` is this event's `seq`.
    #[serde(rename = "permission")]
    Permission {
        tool_call: Value,
        options: Vec<Value>,
    },
    /// The answer to the permission request `req` was sent.
    #[serde(rename = "permission_resolved")]
    PermissionResolved {
        req: u64,
        outcome: Value,
        by: ResolvedBy,
    },
    /// `elicitation/create` arrived, its params verbatim. Its `req` is this event's
    /// `seq`.
    #[serde(rename = "elicitation")]
    Elicitation { request: Value },
    /// The answer to the elicitation `req` was sent.
    #[serde(rename = "elicitation_resolved")]
    ElicitationResolved {
        req: u64,
        response: Value,
        by: ResolvedBy,
    },
    /// `elicitation/complete` arrived (url mode). It resolves nothing.
    #[serde(rename = "elicitation_complete")]
    ElicitationComplete { elicitation_id: String },
    /// `session/set_mode` succeeded.
    #[serde(rename = "mode")]
    Mode { mode_id: String },
    /// A note from the hub, such as the revive method or the agent's last stderr line.
    #[serde(rename = "notice")]
    Notice { level: NoticeLevel, text: String },
    /// The agent process ended. ACP never uses `spawn_failed` here.
    #[serde(rename = "exit")]
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
        reason: ExitReason,
    },
    /// An `e` this version does not know.
    #[serde(other)]
    Unknown,
}

/// Why the agent process was started.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpawnVia {
    New,
    Revive,
    #[serde(other)]
    Unknown,
}

/// Which `session/*` method set the session up.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionVia {
    New,
    Resume,
    Load,
    #[serde(other)]
    Unknown,
}

/// Why setup failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupErrorCode {
    /// The agent answered JSON-RPC error -32000.
    AuthRequired,
    /// Any other JSON-RPC error, or an initialize result that is not ACP v1.
    AgentError,
    /// `SETUP_IDLE_TIMEOUT` passed without an agent message.
    Timeout,
    /// Neither `session/resume` nor `session/load` worked.
    ReviveFailed,
    /// Spawn or exec failed.
    SpawnFailed,
    /// The agent died during setup.
    AgentExited,
    /// A kill or a hub stop cut the setup.
    Interrupted,
    #[serde(other)]
    Unknown,
}

/// Why a turn failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnErrorCode {
    /// The agent answered `session/prompt` with a JSON-RPC error.
    AgentError,
    /// The agent died mid-turn.
    AgentExited,
    /// A kill or a hub stop cut the turn.
    Interrupted,
    #[serde(other)]
    Unknown,
}

/// Who answered a permission or elicitation request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedBy {
    /// A viewer's `acp.permission` or `acp.elicitation`.
    User,
    /// An `acp.cancel`.
    Cancel,
    /// The hub, because the agent died.
    Hub,
    /// The agent's own `$/cancel_request`.
    Agent,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
    #[serde(other)]
    Unknown,
}
