//! The fold over an ACP journal. `Facts::apply` is the only fold, used both live and
//! at startup, so the folded journal and the live facts agree by construction.

use serde_json::Value;
use wb_proto::hub::{Activity, Last, Pending};
use wb_proto::journal::JournalEvent;

/// What the journal says about a session (DESIGN §3.4.5 "Facts", 10 §7.8 "Fold").
#[derive(Clone, Debug, PartialEq)]
pub struct Facts {
    /// Seq of the last event applied, unknown kinds included.
    pub head_seq: u64,
    pub activity: Activity,
    pub agent_session_id: Option<String>,
    /// Unresolved agent requests in ascending `req` order.
    pub pending: Vec<Pending>,
    pub last: Option<Last>,
    pub title: Option<String>,
    pub mode_id: Option<String>,
    pub modes: Option<Value>,
    pub available_commands: Option<Value>,
    pub plan: Option<Value>,
    pub usage: Option<Value>,
    /// A `spawn` has no later `exit`.
    pub running: bool,
    /// A `setup_error{revive_failed}` came after the last `session` (H-12).
    pub revive_failed: bool,
}

impl Default for Facts {
    fn default() -> Self {
        todo!("M3-H1: empty facts")
    }
}

impl Facts {
    /// Folds one event into the facts. Pure: no I/O, no clock.
    pub fn apply(&mut self, ev: &JournalEvent) {
        todo!("M3-H1: apply seq {} after {}", ev.seq, self.head_seq)
    }
}
