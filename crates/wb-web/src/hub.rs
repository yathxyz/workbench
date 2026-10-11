//! The hub client (design §3.2): one connection per card socket, plus the control
//! connection that tracks hub status and the session map.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{broadcast, watch};
use tokio::time::{sleep, timeout};
use tokio_util::codec::{FramedRead, LinesCodec};
use wb_proto::hub::{Agent, HubMessage, HubRequest, PROTO, SessionsReply, Summary};
use wb_proto::limits::{HELLO_TIMEOUT, MAX_LINE};
use wb_proto::line;

use crate::FeedMsg;

const CLIENT: &str = concat!("wb-web/", env!("CARGO_PKG_VERSION"));
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);
/// A control connection must stay up this long before the backoff starts over.
const STABLE: Duration = Duration::from_secs(5);
/// How long the hub has to answer a request.
pub const REPLY_TIMEOUT: Duration = Duration::from_secs(10);

/// What the web knows about the hub, from the control connection.
#[derive(Clone, Debug, PartialEq)]
pub enum HubStatus {
    Down,
    Up {
        version: String,
        build: Option<String>,
        proto: u32,
        started_at: u64,
        agents: Vec<Agent>,
    },
    /// The hub speaks protocol `proto`, not ours.
    Incompatible {
        proto: u32,
    },
}

impl HubStatus {
    pub fn name(&self) -> &'static str {
        match self {
            HubStatus::Down => "down",
            HubStatus::Up { .. } => "up",
            HubStatus::Incompatible { .. } => "incompatible",
        }
    }
}

pub enum ConnectError {
    Unavailable(String),
    Incompatible(u32),
}

/// One hub connection after the handshake.
pub struct HubConn {
    rx: FramedRead<OwnedReadHalf, LinesCodec>,
    tx: OwnedWriteHalf,
}

impl HubConn {
    /// Connects and does the handshake (§3.2.3). Returns the status the hub's hello
    /// describes.
    pub async fn connect(path: &Path) -> Result<(Self, HubStatus), ConnectError> {
        let unavailable = |why: String| ConnectError::Unavailable(why);
        let stream = timeout(CONNECT_TIMEOUT, UnixStream::connect(path))
            .await
            .map_err(|_| unavailable("connect timed out".into()))?
            .map_err(|e| unavailable(e.to_string()))?;
        let (rx, tx) = stream.into_split();
        let mut conn = HubConn {
            rx: FramedRead::new(rx, LinesCodec::new_with_max_length(MAX_LINE)),
            tx,
        };
        let hello = timeout(HELLO_TIMEOUT, conn.recv())
            .await
            .map_err(|_| unavailable("no hello".into()))?;
        let Some(HubMessage::Hello {
            proto,
            version,
            build,
            started_at,
            agents,
            ..
        }) = hello
        else {
            return Err(unavailable("the first line was not a hello".into()));
        };
        if proto != PROTO {
            return Err(ConnectError::Incompatible(proto));
        }
        let hello = HubRequest::Hello {
            proto: PROTO,
            client: CLIENT.into(),
        };
        conn.send(&hello)
            .await
            .map_err(|e| unavailable(e.to_string()))?;
        let status = HubStatus::Up {
            version,
            build,
            proto,
            started_at,
            agents,
        };
        Ok((conn, status))
    }

    pub async fn send(&mut self, req: &HubRequest) -> std::io::Result<()> {
        self.tx.write_all(&line::encode(req)).await
    }

    /// The next message, or `None` once the connection has ended. Lines that do not
    /// decode are skipped. Cancel safe.
    pub async fn recv(&mut self) -> Option<HubMessage> {
        loop {
            match self.rx.next().await? {
                Ok(line) => match serde_json::from_str(&line) {
                    Ok(msg) => return Some(msg),
                    Err(e) => tracing::warn!(error = %e, "undecodable hub line skipped"),
                },
                Err(e) => {
                    tracing::warn!(error = %e, "hub connection failed");
                    return None;
                }
            }
        }
    }
}

/// The control connection's results, shared with the handlers.
pub struct HubHandle {
    pub status: watch::Receiver<HubStatus>,
    /// Every session the hub knows, by sid; empty while the hub is not up.
    pub sessions: Arc<Mutex<BTreeMap<String, Summary>>>,
}

/// Starts the control connection task (§3.2.10). Every status change is also sent on
/// `feed`.
pub fn spawn_control(path: PathBuf, feed: broadcast::Sender<FeedMsg>) -> HubHandle {
    let (status_tx, status) = watch::channel(HubStatus::Down);
    let sessions = Arc::new(Mutex::new(BTreeMap::new()));
    let control = Control {
        status: status_tx,
        sessions: sessions.clone(),
        feed,
    };
    tokio::spawn(control.run(path));
    HubHandle { status, sessions }
}

struct Control {
    status: watch::Sender<HubStatus>,
    sessions: Arc<Mutex<BTreeMap<String, Summary>>>,
    feed: broadcast::Sender<FeedMsg>,
}

impl Control {
    async fn run(self, path: PathBuf) {
        let mut backoff = BACKOFF_MIN;
        loop {
            let wait = match HubConn::connect(&path).await {
                Ok((conn, up)) => {
                    let since = Instant::now();
                    self.watch(conn, up).await;
                    self.sessions().clear();
                    self.set(HubStatus::Down);
                    if since.elapsed() >= STABLE {
                        backoff = BACKOFF_MIN;
                    }
                    jitter(next_backoff(&mut backoff))
                }
                Err(ConnectError::Incompatible(proto)) => {
                    self.set(HubStatus::Incompatible { proto });
                    BACKOFF_MAX
                }
                Err(ConnectError::Unavailable(why)) => {
                    tracing::debug!(why, "hub not reachable");
                    self.set(HubStatus::Down);
                    jitter(next_backoff(&mut backoff))
                }
            };
            sleep(wait).await;
        }
    }

    /// Sends `watch`, publishes `up` once the hub answered, then keeps the session map
    /// current until the connection ends.
    async fn watch(&self, mut conn: HubConn, up: HubStatus) {
        if conn.send(&HubRequest::Watch { rid: 1 }).await.is_err() {
            return;
        }
        // Nothing else is subscribed on this connection, so the reply comes first.
        let reply = match timeout(REPLY_TIMEOUT, conn.recv()).await {
            Ok(Some(HubMessage::Ok { rid: 1, result })) => {
                serde_json::from_value::<SessionsReply>(Value::Object(result))
            }
            _ => {
                tracing::warn!("the hub did not answer watch");
                return;
            }
        };
        let Ok(SessionsReply { sessions }) = reply else {
            tracing::warn!("undecodable watch reply");
            return;
        };
        *self.sessions() = sessions.into_iter().map(|s| (s.sid.clone(), s)).collect();
        self.set(up);
        while let Some(msg) = conn.recv().await {
            match msg {
                HubMessage::Session { session } => {
                    self.sessions().insert(session.sid.clone(), *session);
                }
                HubMessage::Gone { sid, epoch } => {
                    let mut sessions = self.sessions();
                    if sessions.get(&sid).is_some_and(|s| s.created_at == epoch) {
                        sessions.remove(&sid);
                    }
                }
                _ => {}
            }
        }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, Summary>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, new: HubStatus) {
        let changed = self.status.send_if_modified(|cur| {
            let changed = *cur != new;
            if changed {
                *cur = new.clone();
            }
            changed
        });
        if changed {
            tracing::info!(status = new.name(), "hub status");
            let _ = self.feed.send(FeedMsg::Hub(new));
        }
    }
}

/// Returns the current backoff and doubles the next one, up to the maximum.
fn next_backoff(backoff: &mut Duration) -> Duration {
    let current = *backoff;
    *backoff = (current * 2).min(BACKOFF_MAX);
    current
}

/// ±25 %, so restarted webs do not reconnect in lockstep.
fn jitter(d: Duration) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.subsec_nanos());
    d.mul_f64(0.75 + f64::from(nanos % 1000) / 2000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_to_the_cap() {
        let mut b = BACKOFF_MIN;
        let seq: Vec<_> = (0..7).map(|_| next_backoff(&mut b).as_millis()).collect();
        assert_eq!(seq, [250, 500, 1000, 2000, 4000, 5000, 5000]);
    }

    #[test]
    fn jitter_stays_within_a_quarter() {
        for _ in 0..100 {
            let j = jitter(Duration::from_secs(4));
            assert!(
                j >= Duration::from_secs(3) && j < Duration::from_secs(5),
                "{j:?}"
            );
        }
    }
}
