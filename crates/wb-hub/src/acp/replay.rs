//! Replay of a journal for `acp.open{since}` (DESIGN §3.4.4, H-8): coalesced,
//! truncated to a byte cap, with the announcing events of pending requests added back,
//! as one stream in ascending seq order.

use std::path::Path;

use anyhow::Result;
use wb_proto::journal::JournalEvent;

/// The events to send after the `ok` of `acp.open`, then `acp.replayed`.
#[derive(Debug, PartialEq)]
pub struct Replay {
    /// Pinned and kept events in strictly ascending seq order.
    pub events: Vec<JournalEvent>,
    /// The first seq covered by the first kept event, or `since + 1` if nothing was
    /// trimmed.
    pub from: u64,
    /// Events were trimmed to fit `cap`.
    pub truncated: bool,
}

/// Reads the journal at `path` up to seq `head` and builds the replay of the events
/// after `since`. `pending` holds the seqs of the currently pending requests' announcing
/// events; `cap` is the byte budget (`ACP_REPLAY_MAX`). Blocking: run it in
/// `spawn_blocking`.
pub fn scan(path: &Path, since: u64, head: u64, pending: &[u64], cap: usize) -> Result<Replay> {
    todo!(
        "M3-H1: replay {} from {since} to {head}, {} pinned, cap {cap}",
        path.display(),
        pending.len()
    )
}
