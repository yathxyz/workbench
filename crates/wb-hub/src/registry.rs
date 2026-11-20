//! Every session by sid, with its latest Summary, and the `watch` subscribers.
//!
//! One `std::sync::Mutex` guards it, and nothing awaits while holding it. Pushing to a
//! connection's `OutQ` never blocks, so events to watchers go out under the lock, which
//! makes `watch` gap-free: the snapshot reply and the registration happen in one
//! critical section.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard, mpsc};
use wb_proto::hub::{ErrorCode, HubMessage, Kind, Summary};

use crate::conn::{ConnId, Reply, Viewer, line};
use crate::outq::OutQ;
use crate::snapshot::{self, Snapshot, SnapshotMode};
use crate::{acp, lock, now_ms, pty, store};

/// Commands a session actor buffers before senders wait.
const CMD_QUEUE: usize = 8;

const EPOCH_FILE: &str = "last-created";

struct Epochs {
    dir: PathBuf,
    last: u64,
}

impl Epochs {
    /// An existing record keeps its epoch; every allocation exceeds the durable mark.
    /// Move the lock into the write so cancellation cannot race another reservation.
    async fn reserve(
        mut epochs: OwnedMutexGuard<Self>,
        restored: Option<u64>,
        now: u64,
    ) -> io::Result<(u64, OwnedMutexGuard<Self>)> {
        let epoch = match restored {
            Some(epoch) if epoch <= epochs.last => return Ok((epoch, epochs)),
            Some(epoch) => epoch,
            None => now.max(
                epochs
                    .last
                    .checked_add(1)
                    .ok_or_else(|| io::Error::other("session epochs exhausted"))?,
            ),
        };
        tokio::task::spawn_blocking(move || {
            store::write_atomic(&epochs.dir, EPOCH_FILE, epoch.to_string().as_bytes())?;
            epochs.last = epoch;
            Ok((epoch, epochs))
        })
        .await?
    }
}

pub struct Registry {
    inner: Mutex<Inner>,
    // Only creators serialize with disk I/O; existing sessions and watches do not.
    epochs: Arc<AsyncMutex<Epochs>>,
}

#[derive(Default)]
struct Inner {
    sessions: BTreeMap<String, Entry>,
    watchers: Vec<Viewer>,
    /// Set by [`Registry::stop`]: no session is created any more.
    stopping: bool,
}

impl Inner {
    fn existing<C: SessionCmd>(&self, sid: &str, create: bool) -> Option<Route<C>> {
        if let Some(e) = self.sessions.get(sid) {
            Some(C::unwrap(&e.tx).map_or(Route::NotFound, Route::Send))
        } else if !create {
            Some(Route::NotFound)
        } else if self.stopping {
            Some(Route::Stopping)
        } else {
            None
        }
    }

    fn insert<C: SessionCmd>(&mut self, sid: &str, created_at: u64) -> mpsc::Receiver<C> {
        let (tx, rx) = mpsc::channel(CMD_QUEUE);
        self.sessions.insert(
            sid.to_owned(),
            Entry {
                created_at,
                tx: C::wrap(tx),
                summary: None,
            },
        );
        rx
    }

    fn summaries(&self) -> impl Clone + Iterator<Item = &Arc<Summary>> {
        self.sessions.values().filter_map(|e| e.summary.as_ref())
    }

    /// Look up an incarnation even before its first Summary is published.
    fn action_sender(&self, sid: &str, epoch: Option<u64>) -> Result<&Tx, (ErrorCode, String)> {
        let entry = self
            .sessions
            .get(sid)
            .ok_or_else(|| (ErrorCode::NotFound, format!("no session {sid}")))?;
        if epoch.is_some_and(|epoch| epoch != entry.created_at) {
            return Err((ErrorCode::Stale, "the session was created again".into()));
        }
        Ok(&entry.tx)
    }

    fn snapshot(&self, rid: u64, mode: SnapshotMode) -> Snapshot {
        let mut sessions = Vec::with_capacity(self.sessions.len());
        sessions.extend(self.summaries().cloned());
        Snapshot {
            rid,
            mode,
            sessions,
        }
    }
}

struct Entry {
    created_at: u64,
    tx: Tx,
    /// `None` until the actor's first publish: the session is still being created and
    /// is invisible to `list` and `watch`.
    summary: Option<Arc<Summary>>,
}

impl Entry {
    fn pid(&self) -> Option<u32> {
        self.summary.as_ref()?.pty.as_ref()?.pid
    }
}

/// The command sender of a session's actor; pty and acp share one sid namespace.
#[derive(Clone)]
pub enum Tx {
    Pty(mpsc::Sender<pty::Cmd>),
    Acp(mpsc::Sender<acp::Cmd>),
}

impl Tx {
    fn kind(&self) -> Kind {
        match self {
            Tx::Pty(_) => Kind::Pty,
            Tx::Acp(_) => Kind::Acp,
        }
    }
}

/// The command type of one session kind.
pub trait SessionCmd: Sized {
    const KIND: Kind;
    fn wrap(tx: mpsc::Sender<Self>) -> Tx;
    /// The sender in `tx` if it is of this kind.
    fn unwrap(tx: &Tx) -> Option<mpsc::Sender<Self>>;
    /// The caller's routing guard, retained on the command in case it is redelivered.
    fn expected_epoch(&self) -> Option<u64>;
    /// Answers a command that the session can no longer carry out.
    fn refuse(self, code: ErrorCode, message: impl Into<String>);
}

impl SessionCmd for pty::Cmd {
    const KIND: Kind = Kind::Pty;
    fn wrap(tx: mpsc::Sender<Self>) -> Tx {
        Tx::Pty(tx)
    }
    fn unwrap(tx: &Tx) -> Option<mpsc::Sender<Self>> {
        match tx {
            Tx::Pty(tx) => Some(tx.clone()),
            Tx::Acp(_) => None,
        }
    }
    fn expected_epoch(&self) -> Option<u64> {
        match self {
            pty::Cmd::Kill { epoch, .. } => *epoch,
            _ => None,
        }
    }
    fn refuse(self, code: ErrorCode, message: impl Into<String>) {
        pty::Cmd::refuse(self, code, message);
    }
}

impl SessionCmd for acp::Cmd {
    const KIND: Kind = Kind::Acp;
    fn wrap(tx: mpsc::Sender<Self>) -> Tx {
        Tx::Acp(tx)
    }
    fn unwrap(tx: &Tx) -> Option<mpsc::Sender<Self>> {
        match tx {
            Tx::Acp(tx) => Some(tx.clone()),
            Tx::Pty(_) => None,
        }
    }
    fn expected_epoch(&self) -> Option<u64> {
        match self {
            acp::Cmd::Act { epoch, .. } => *epoch,
            _ => None,
        }
    }
    fn refuse(self, code: ErrorCode, message: impl Into<String>) {
        acp::Cmd::refuse(self, code, message);
    }
}

/// Where a `*.open` goes. A sid held by the other kind is `NotFound`; requests are
/// checked against [`Registry::kind`] first, so that only happens in a race.
pub enum Route<C> {
    /// To this existing session.
    Send(mpsc::Sender<C>),
    /// A new session was registered; the caller starts its actor on `rx`.
    Created {
        created_at: u64,
        rx: mpsc::Receiver<C>,
    },
    NotFound,
    /// The hub is stopping and creates no session.
    Stopping,
}

impl Registry {
    pub fn open(dir: &Path) -> io::Result<Self> {
        let last = match std::fs::read_to_string(dir.join(EPOCH_FILE)) {
            Ok(text) => text
                .parse()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e),
        };
        Ok(Self {
            inner: Mutex::default(),
            epochs: Arc::new(AsyncMutex::new(Epochs {
                dir: dir.to_owned(),
                last,
            })),
        })
    }

    pub fn published_count(&self) -> usize {
        lock(&self.inner).summaries().count()
    }

    pub fn list(&self, outq: &OutQ, rid: u64, stream: bool) {
        let mode = if stream {
            SnapshotMode::Stream { watch: false }
        } else {
            SnapshotMode::LegacyList
        };
        let inner = lock(&self.inner);
        outq.push_snapshot(inner.snapshot(rid, mode));
    }

    /// Replies to `watch` with every Summary and subscribes `viewer` to later changes.
    pub fn watch(&self, viewer: Viewer, rid: u64, stream: bool) {
        let mode = if stream {
            SnapshotMode::Stream { watch: true }
        } else {
            SnapshotMode::LegacyWatch
        };
        let mut inner = lock(&self.inner);
        viewer.outq.push_snapshot(inner.snapshot(rid, mode));
        inner.watchers.retain(|w| w.id != viewer.id);
        inner.watchers.push(viewer);
    }

    pub fn unwatch(&self, conn: ConnId) {
        lock(&self.inner).watchers.retain(|w| w.id != conn);
    }

    /// The kind of the session registered for `sid`.
    pub fn kind(&self, sid: &str) -> Option<Kind> {
        lock(&self.inner).sessions.get(sid).map(|e| e.tx.kind())
    }

    /// The sender of the session for `sid`, if it is of kind `C`.
    pub fn sender<C: SessionCmd>(&self, sid: &str) -> Option<mpsc::Sender<C>> {
        lock(&self.inner)
            .sessions
            .get(sid)
            .and_then(|e| C::unwrap(&e.tx))
    }

    /// Compare the epoch and pin the actor's sender under the same lock.
    fn action_sender<C: SessionCmd>(
        &self,
        sid: &str,
        epoch: Option<u64>,
    ) -> Result<mpsc::Sender<C>, (ErrorCode, String)> {
        let inner = lock(&self.inner);
        let tx = inner.action_sender(sid, epoch)?;
        C::unwrap(tx).ok_or_else(|| {
            let kind = if tx.kind() == Kind::Pty { "pty" } else { "acp" };
            (
                ErrorCode::KindMismatch,
                format!("{sid} is a {kind} session"),
            )
        })
    }

    pub async fn deliver<C: SessionCmd>(&self, sid: &str, cmd: C) {
        match self.action_sender::<C>(sid, cmd.expected_epoch()) {
            Ok(tx) => send_to(sid, tx, cmd).await,
            Err((code, msg)) => cmd.refuse(code, msg),
        }
    }

    /// A guarded DELETE names an incarnation, not a kind inferred by its caller.
    pub async fn kill(&self, sid: &str, epoch: u64, forget: bool, reply: Reply) {
        let tx = lock(&self.inner).action_sender(sid, Some(epoch)).cloned();
        let epoch = Some(epoch);
        match tx {
            Ok(Tx::Pty(tx)) => {
                send_to(
                    sid,
                    tx,
                    pty::Cmd::Kill {
                        epoch,
                        forget,
                        reply,
                    },
                )
                .await
            }
            Ok(Tx::Acp(tx)) => {
                send_to(
                    sid,
                    tx,
                    acp::Cmd::Act {
                        epoch,
                        act: acp::Act::Kill { forget },
                        reply,
                    },
                )
                .await
            }
            Err((code, msg)) => reply.err(code, msg),
        }
    }

    /// A queued open may just have recreated `sid`. Never redeliver guarded actions
    /// based on `sid` alone. Legacy unguarded commands still follow it if possible.
    pub async fn redeliver<C: SessionCmd>(&self, sid: &str, cmd: C) {
        if cmd.expected_epoch().is_some() {
            return self.deliver(sid, cmd).await;
        }
        const FORGOTTEN: &str = "the session was forgotten";
        match self.sender(sid) {
            Some(tx) => {
                if let Err(unsent) = tx.send(cmd).await {
                    unsent.0.refuse(ErrorCode::NotFound, FORGOTTEN);
                }
            }
            None => cmd.refuse(ErrorCode::NotFound, FORGOTTEN),
        }
    }

    /// Finds the session for `sid`, registering a new one of kind `C` when there is none
    /// and `create` is set.
    pub async fn route<C: SessionCmd>(&self, sid: &str, create: bool) -> io::Result<Route<C>> {
        self.route_with_clock(sid, create, now_ms).await
    }

    async fn route_with_clock<C: SessionCmd>(
        &self,
        sid: &str,
        create: bool,
        clock: impl FnOnce() -> u64,
    ) -> io::Result<Route<C>> {
        if let Some(route) = lock(&self.inner).existing(sid, create) {
            return Ok(route);
        }
        let epochs = self.epochs.clone().lock_owned().await;
        if let Some(route) = lock(&self.inner).existing(sid, create) {
            return Ok(route);
        }
        let (created_at, _reservation) = Epochs::reserve(epochs, None, clock()).await?;
        let mut inner = lock(&self.inner);
        if inner.stopping {
            return Ok(Route::Stopping);
        }
        let rx = inner.insert(sid, created_at);
        Ok(Route::Created { created_at, rx })
    }

    /// Registers a session found in the state directory at startup, with its `createdAt`,
    /// or with a new one when its record could not be read. The caller starts its actor
    /// on the returned channel.
    pub async fn load<C: SessionCmd>(
        &self,
        sid: &str,
        created_at: Option<u64>,
    ) -> io::Result<(u64, mpsc::Receiver<C>)> {
        let epochs = self.epochs.clone().lock_owned().await;
        let (created_at, _reservation) = Epochs::reserve(epochs, created_at, now_ms()).await?;
        let rx = lock(&self.inner).insert(sid, created_at);
        Ok((created_at, rx))
    }

    /// A new command channel for a session whose actor panicked and is being reloaded;
    /// the Summary stays. `None` if the session is no longer registered.
    pub fn reopen<C: SessionCmd>(&self, sid: &str, created_at: u64) -> Option<mpsc::Receiver<C>> {
        let mut inner = lock(&self.inner);
        let entry = inner
            .sessions
            .get_mut(sid)
            .filter(|e| e.created_at == created_at && e.tx.kind() == C::KIND)?;
        let (tx, rx) = mpsc::channel(CMD_QUEUE);
        entry.tx = C::wrap(tx);
        Some(rx)
    }

    /// Stores a session's new Summary and sends it to the watchers.
    pub fn publish(&self, summary: Arc<Summary>) {
        let Inner {
            sessions, watchers, ..
        } = &mut *lock(&self.inner);
        let Some(entry) = sessions.get_mut(&summary.sid) else {
            return;
        };
        if entry.created_at != summary.created_at {
            return;
        }
        let session = entry.summary.insert(summary);
        if !watchers.is_empty() {
            let mut buf = Vec::new();
            if !snapshot::update(&mut buf, session) {
                tracing::warn!(sid = %session.sid, "watch update exceeds MAX_LINE");
                for viewer in watchers.drain(..) {
                    viewer.outq.close();
                }
                return;
            }
            let msg: Arc<[u8]> = buf.into();
            watchers.retain(|w| w.outq.push_event(msg.clone()).is_ok());
        }
    }

    /// Removes a session that is being forgotten and sends `gone` to the watchers and
    /// to `viewers`, once per connection.
    pub fn forget(&self, sid: &str, created_at: u64, viewers: &[Viewer]) {
        let mut inner = lock(&self.inner);
        if inner
            .sessions
            .get(sid)
            .is_none_or(|e| e.created_at != created_at)
        {
            return;
        }
        inner.sessions.remove(sid);
        let msg = line(&HubMessage::Gone {
            sid: sid.to_owned(),
            epoch: created_at,
        });
        inner
            .watchers
            .retain(|w| w.outq.push_event(msg.clone()).is_ok());
        for v in viewers {
            if !inner.watchers.iter().any(|w| w.id == v.id) {
                let _ = v.outq.push_event(msg.clone());
            }
        }
    }

    /// Removes a session whose first spawn failed. Nobody saw it, so nobody is told.
    /// False if the session was published, which leaves it registered.
    pub fn abandon(&self, sid: &str, created_at: u64) -> bool {
        let mut inner = lock(&self.inner);
        let fresh = inner
            .sessions
            .get(sid)
            .is_some_and(|e| e.created_at == created_at && e.summary.is_none());
        if fresh {
            inner.sessions.remove(sid);
        }
        fresh
    }

    /// The child pid of a live PTY session.
    pub fn live_pid(&self, sid: &str) -> Option<u32> {
        lock(&self.inner).sessions.get(sid).and_then(Entry::pid)
    }

    /// Stops creating sessions and returns every session's sender.
    pub fn stop(&self) -> Vec<Tx> {
        let mut inner = lock(&self.inner);
        inner.stopping = true;
        inner.sessions.values().map(|e| e.tx.clone()).collect()
    }
}

async fn send_to<C: SessionCmd>(sid: &str, tx: mpsc::Sender<C>, cmd: C) {
    if let Err(unsent) = tx.send(cmd).await {
        unsent
            .0
            .refuse(ErrorCode::NotFound, format!("no session {sid}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn create(hub: &Registry, now: u64) -> u64 {
        match hub.route_with_clock::<pty::Cmd>("job", true, || now).await {
            Ok(Route::Created { created_at, .. }) => created_at,
            _ => panic!("expected creation"),
        }
    }

    #[tokio::test]
    async fn forgotten_epoch_cannot_guard_replacement_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let restart = || Registry::open(dir.path()).unwrap();
        let hub = restart();
        let old = create(&hub, 100).await;
        hub.forget("job", old, &[]);
        drop(hub);

        let hub = restart();
        let created_at = create(&hub, 100).await;
        assert!(
            matches!(
                hub.action_sender::<pty::Cmd>("job", Some(old)),
                Err((ErrorCode::Stale, _))
            ),
            "epoch {old} guarded replacement {created_at}"
        );

        // Crash after route hands out the epoch, before the actor writes any record.
        drop(hub);
        assert!(create(&restart(), 90).await > created_at);
    }

    #[tokio::test]
    async fn forget_immediately_after_upgrade_preserves_restored_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Registry::open(dir.path()).unwrap();
        let (epoch, _) = hub.load::<acp::Cmd>("job", Some(200)).await.unwrap();
        assert_eq!(epoch, 200);
        hub.forget("job", epoch, &[]);
        drop(hub);
        assert!(create(&Registry::open(dir.path()).unwrap(), 40).await > epoch);
    }

    #[tokio::test]
    async fn failed_epoch_write_does_not_register_session() {
        let dir = tempfile::tempdir().unwrap();
        let hub = Registry::open(dir.path()).unwrap();
        std::fs::create_dir(dir.path().join(EPOCH_FILE)).unwrap();
        assert!(hub.route::<acp::Cmd>("job", true).await.is_err());
        assert!(hub.kind("job").is_none());
    }
}
