//! The per-session ACP journal `acp/<sid>.jsonl`: one `JournalEvent` per line,
//! appended fail-closed (DESIGN §3.4.4, H-9). Memory never runs ahead of disk, so a
//! seq is never issued twice.

use std::fs::File;
use std::io;
use std::path::Path;

use anyhow::Result;
use tokio::task::JoinHandle;
use wb_proto::journal::{EventBody, JournalEvent};

/// The append handle of one session's journal.
pub struct Journal {
    file: File,
    /// Byte length of the journal up to its last complete line.
    end: u64,
    /// Seq of the last line written; 0 for an empty journal.
    head: u64,
}

/// An append that did not complete. The journal was truncated back to its last
/// complete line, so nothing of the event is on disk and its seq was not used.
#[derive(Debug)]
pub struct WriteFault {
    pub error: io::Error,
}

impl Journal {
    /// Opens the journal at `path`, creating it with mode 0600 if missing, and returns
    /// its events in file order. A torn final line is truncated away and logged; any
    /// other unparsable line is logged and skipped.
    pub fn open(path: &Path) -> Result<(Journal, Vec<JournalEvent>)> {
        todo!("M3-H1: open {}", path.display())
    }

    /// Writes `body` as the next event with one `write(2)`. Only a complete write
    /// advances the head; on any failure the file is truncated back and the fault
    /// returned.
    pub fn append(&mut self, body: &EventBody, ts: u64) -> Result<JournalEvent, WriteFault> {
        todo!("M3-H1: append {body:?} at {ts} after seq {}", self.head)
    }

    /// `fdatasync`s the journal on a cloned fd in `spawn_blocking`, so the caller
    /// never blocks on the disk.
    pub fn sync(&self) -> JoinHandle<io::Result<()>> {
        todo!("M3-H1: sync {:?} up to byte {}", self.file, self.end)
    }

    /// The head seq: the seq of the last event written, 0 for an empty journal.
    pub fn len(&self) -> u64 {
        todo!("M3-H1: head seq {}", self.head)
    }
}
