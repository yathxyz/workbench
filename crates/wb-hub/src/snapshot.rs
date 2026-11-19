//! Snapshot encoding runs in the connection writer, not under the registry lock.

use std::io::{self, Write};
use std::sync::Arc;

use serde::Serialize;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use wb_proto::hub::{ErrorCode, HubMessage, Summary};
use wb_proto::limits::MAX_LINE;
use wb_proto::line::encode;

const LINE_BYTES: usize = MAX_LINE + 1; // includes the newline
const OK: &[u8] = b"],\"t\":\"ok\"}\n";
const PAGE: &[u8] = b"],\"t\":\"sessions.page\"}\n";

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
