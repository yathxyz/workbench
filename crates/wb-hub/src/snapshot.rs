//! Snapshot encoding runs in the connection writer, not under the registry lock.

use std::io::{self, Write};
use std::sync::Arc;

use serde::Serialize;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use wb_proto::hub::{ErrorCode, HubMessage, Summary};
use wb_proto::limits::{ACP_CONFIG_OPTIONS_BYTES, MAX_LINE, POLICY_MAX, TASK_MAX};
use wb_proto::line::encode;

const LINE_BYTES: usize = MAX_LINE + 1; // includes the newline
const OK: &[u8] = b"],\"t\":\"ok\"}\n";
const PAGE: &[u8] = b"],\"t\":\"sessions.page\"}\n";
// A singleton page with the longest rid takes more space than an `ok` or `session`.
const SINGLE_SUMMARY_BYTES: usize =
    LINE_BYTES - b"{\"rid\":18446744073709551615,\"sessions\":[".len() - PAGE.len();

pub const ARGV_MAX: usize = 256;
pub const ARGV_BYTES_MAX: usize = 256 << 10;
pub const PENDING_TITLE_CHARS: usize = 200;
const SUMMARY_PENDING_MAX: usize = 4096;
const SUMMARY_TEXT_BYTES: usize = 32 << 10;

// Budget both kinds together, although only one is present. serde_json writes a
// string byte (or Unicode scalar for a pending title) as at most 6 escaped bytes.
// 128 per pending request and 4 KiB elsewhere cover keys, punctuation, envelopes,
// enums, numbers, and argv separators (3 bytes per item).
const _: () = assert!(
    6 * (16 * SUMMARY_TEXT_BYTES + ARGV_BYTES_MAX + TASK_MAX)
        + SUMMARY_PENDING_MAX * (6 * PENDING_TITLE_CHARS + 128)
        + ACP_CONFIG_OPTIONS_BYTES
        + POLICY_MAX
        + 4096
        < MAX_LINE
);

/// Preserve a summary as-is if it fits every singleton watch/list envelope.
pub fn fit_summary(summary: &mut Summary) {
    struct Budget(usize);

    impl Write for Budget {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self
                .0
                .checked_sub(bytes.len())
                .ok_or(io::ErrorKind::FileTooLarge)?;
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    if serde_json::to_writer(Budget(SINGLE_SUMMARY_BYTES), summary).is_ok() {
        return;
    }

    fn clip(text: &mut String) {
        if too_long(text) {
            *text = text[..text.floor_char_boundary(SUMMARY_TEXT_BYTES)].to_owned();
        }
    }

    fn clear_long(text: &mut String) {
        if too_long(text) {
            *text = String::new();
        }
    }

    fn too_long(text: &str) -> bool {
        text.len() > SUMMARY_TEXT_BYTES
    }

    // Clip display text, but never publish a partial path or identifier.
    clear_long(&mut summary.host);
    clear_long(&mut summary.cwd);
    if let Some(fault) = &mut summary.fault {
        clip(&mut fault.message);
    }
    if let Some(pty) = &mut summary.pty {
        let mut left = ARGV_BYTES_MAX;
        let keep = pty
            .argv
            .iter()
            .take(ARGV_MAX)
            .map_while(|arg| {
                left = left.checked_sub(arg.len())?;
                Some(())
            })
            .count();
        pty.argv.truncate(keep);
        if let Some(fg) = &mut pty.fg {
            clip(&mut fg.comm);
        }
    }
    if let Some(acp) = &mut summary.acp {
        clear_long(&mut acp.agent);
        if acp.agent_session_id.as_deref().is_some_and(too_long) {
            acp.agent_session_id = None;
        }
        if acp.mode_id.as_deref().is_some_and(too_long) {
            acp.mode_id = None;
        }
        if acp.managed_worktree.as_ref().is_some_and(|wt| {
            [wt.path.as_str(), wt.branch.as_str(), wt.main_root.as_str()]
                .into_iter()
                .any(too_long)
        }) {
            acp.managed_worktree = None;
        }
        if acp.task.as_ref().is_some_and(|task| task.len() > TASK_MAX) {
            acp.task = None;
        }
        acp.pending.truncate(SUMMARY_PENDING_MAX);
        if let Some(title) = &mut acp.title {
            clip(title);
        }
        if let Some(last) = &mut acp.last {
            clip(&mut last.outcome);
            if let Some(error) = &mut last.error {
                clip(&mut error.message);
            }
        }
    }
}

pub enum SnapshotMode {
    Stream { watch: bool },
    LegacyList,
    LegacyWatch,
}

pub struct Snapshot {
    pub rid: u64,
    pub mode: SnapshotMode,
    pub sessions: Vec<Arc<Summary>>,
}

impl Snapshot {
    /// Writes the snapshot. `false` means the watch must close after the last write.
    pub async fn write(self, wr: &mut (impl AsyncWrite + Unpin)) -> io::Result<bool> {
        let Self {
            rid,
            mode,
            sessions,
        } = self;
        let mut sessions = sessions.into_iter();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            write!(buf, "{{\"rid\":{rid},\"sessions\":[").unwrap();
            let start = buf.len();
            while let Some(summary) = sessions.as_slice().first() {
                let before = buf.len();
                if before != start {
                    buf.push(b',');
                }
                let suffix_budget =
                    if matches!(mode, SnapshotMode::Stream { .. }) && sessions.len() > 1 {
                        PAGE.len()
                    } else {
                        OK.len()
                    };
                if !append(&mut buf, &**summary, LINE_BYTES - suffix_budget) {
                    buf.truncate(before);
                    break;
                }
                sessions.next();
            }
            if sessions.as_slice().is_empty() {
                buf.extend_from_slice(OK);
                wr.write_all(&buf).await?;
                return Ok(true);
            }
            match mode {
                SnapshotMode::Stream { .. } if buf.len() != start => {
                    buf.extend_from_slice(PAGE);
                    wr.write_all(&buf).await?;
                }
                SnapshotMode::Stream { watch } => {
                    let summary = sessions.next().unwrap();
                    let err = failure(
                        Some(rid),
                        Some(summary.sid.clone()),
                        ErrorCode::Internal,
                        "session summary exceeds MAX_LINE",
                    );
                    wr.write_all(&err).await?;
                    return Ok(!watch);
                }
                SnapshotMode::LegacyList => {
                    let err = failure(
                        Some(rid),
                        None,
                        ErrorCode::BadRequest,
                        "list exceeds MAX_LINE; request list with stream:true",
                    );
                    wr.write_all(&err).await?;
                    return Ok(true);
                }
                SnapshotMode::LegacyWatch => {
                    // Old web fronts accept the reply first and then upsert `session` events.
                    buf.extend_from_slice(OK);
                    wr.write_all(&buf).await?;
                    for summary in sessions {
                        if !update(&mut buf, &summary) {
                            tracing::warn!(sid = %summary.sid, "watch catch-up summary exceeds MAX_LINE");
                            return Ok(false);
                        }
                        wr.write_all(&buf).await?;
                    }
                    return Ok(true);
                }
            }
        }
    }
}

/// A watch event for one summary, shared by the live feed and legacy catch-up.
pub fn update(buf: &mut Vec<u8>, session: &Summary) -> bool {
    #[derive(Serialize)]
    #[serde(tag = "t", rename = "session")]
    struct Update<'a> {
        session: &'a Summary,
    }

    buf.clear();
    if !append(buf, &Update { session }, MAX_LINE) {
        return false;
    }
    buf.push(b'\n');
    true
}

fn failure(rid: Option<u64>, sid: Option<String>, code: ErrorCode, message: &str) -> Vec<u8> {
    encode(&HubMessage::Err {
        rid,
        sid,
        code,
        message: message.into(),
    })
}

/// Append compact JSON up to `limit`; on overflow the caller discards the partial value.
fn append(buf: &mut Vec<u8>, value: &impl Serialize, limit: usize) -> bool {
    struct Capped<'a>(&'a mut Vec<u8>, usize);

    impl Write for Capped<'_> {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > self.1.saturating_sub(self.0.len()) {
                return Err(io::ErrorKind::WriteZero.into());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    serde_json::to_writer(Capped(buf, limit), value).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use wb_proto::hub::Kind;
    use wb_proto::line::read_line_capped;

    fn summary(sid: &str) -> Summary {
        Summary {
            sid: sid.into(),
            kind: Kind::Pty,
            host: "testhost".into(),
            created_at: 1,
            updated_at: 1,
            alive: false,
            viewers: 0,
            cwd: String::new(),
            fault: None,
            pty: None,
            acp: None,
        }
    }

    #[tokio::test]
    async fn last_summary_can_use_the_full_ok_budget() {
        let mut last = summary("last");
        let empty_size = encode(&HubMessage::ok(
            1,
            &serde_json::json!({"sessions": [&last]}),
        ))
        .len();
        last.cwd = "x".repeat(LINE_BYTES - empty_size);
        let last = Arc::new(last);
        for paged in [false, true] {
            let mut sessions = Vec::new();
            if paged {
                sessions.push(Arc::new(summary("first")));
            }
            sessions.push(last.clone());
            let mut wire = Vec::new();
            Snapshot {
                rid: 1,
                mode: SnapshotMode::Stream { watch: true },
                sessions,
            }
            .write(&mut wire)
            .await
            .unwrap();
            let mut wire = wire.as_slice();
            if paged {
                let page = read_line_capped(&mut wire).unwrap().unwrap();
                assert!(matches!(
                    serde_json::from_slice::<HubMessage>(&page).unwrap(),
                    HubMessage::SessionsPage { rid: 1, sessions }
                        if sessions.len() == 1 && sessions[0].sid == "first"
                ));
            }
            let reply = read_line_capped(&mut wire).unwrap().unwrap();
            let reply: serde_json::Value = serde_json::from_slice(&reply).unwrap();
            assert_eq!(reply["t"], "ok");
            assert_eq!(reply["rid"], 1);
            assert_eq!(reply["sessions"][0]["sid"], "last");
            assert_eq!(
                reply["sessions"][0]["cwd"].as_str().unwrap().len(),
                last.cwd.len()
            );
            assert!(wire.is_empty());
        }
    }
}
