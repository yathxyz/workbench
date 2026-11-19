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
    Stream,
    LegacyList,
    LegacyWatch,
}

pub struct Snapshot {
    pub rid: u64,
    pub mode: SnapshotMode,
    pub sessions: Vec<Arc<Summary>>,
}

impl Snapshot {
    pub async fn write(self, wr: &mut (impl AsyncWrite + Unpin)) -> io::Result<()> {
        let Self {
            rid,
            mode,
            sessions,
        } = self;
        let mut sessions = sessions.into_iter().peekable();
        let mut buf = Vec::new();
        let suffix_budget = match mode {
            SnapshotMode::Stream => PAGE.len(),
            _ => OK.len(),
        };
        loop {
            buf.clear();
            write!(buf, "{{\"rid\":{rid},\"sessions\":[").unwrap();
            let start = buf.len();
            while let Some(summary) = sessions.peek() {
                let before = buf.len();
                if before != start {
                    buf.push(b',');
                }
                if !append(&mut buf, &**summary, LINE_BYTES - suffix_budget) {
                    buf.truncate(before);
                    break;
                }
                sessions.next();
            }
            if sessions.peek().is_none() {
                buf.extend_from_slice(OK);
                return wr.write_all(&buf).await;
            }
            match mode {
                SnapshotMode::Stream if buf.len() != start => {
                    buf.extend_from_slice(PAGE);
                    wr.write_all(&buf).await?;
                }
                SnapshotMode::Stream => {
                    let summary = sessions.next().unwrap();
                    let err = failure(
                        Some(rid),
                        Some(summary.sid.clone()),
                        ErrorCode::Internal,
                        "session summary exceeds MAX_LINE",
                    );
                    return wr.write_all(&err).await;
                }
                SnapshotMode::LegacyList => {
                    let err = failure(
                        Some(rid),
                        None,
                        ErrorCode::BadRequest,
                        "list exceeds MAX_LINE; request list with stream:true",
                    );
                    return wr.write_all(&err).await;
                }
                SnapshotMode::LegacyWatch => {
                    // Old web fronts accept the reply first and then upsert `session` events.
                    buf.extend_from_slice(OK);
                    wr.write_all(&buf).await?;
                    for summary in sessions {
                        update(&mut buf, &summary);
                        wr.write_all(&buf).await?;
                    }
                    return Ok(());
                }
            }
        }
    }
}

/// A watch event for one summary, shared by the live feed and legacy catch-up.
pub fn update(buf: &mut Vec<u8>, session: &Summary) {
    #[derive(Serialize)]
    #[serde(tag = "t", rename = "session")]
    struct Update<'a> {
        session: &'a Summary,
    }

    buf.clear();
    if append(buf, &Update { session }, MAX_LINE) {
        buf.push(b'\n');
    } else {
        buf.clear();
        buf.extend(failure(
            None,
            Some(session.sid.clone()),
            ErrorCode::Internal,
            "session summary exceeds MAX_LINE",
        ));
    }
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
