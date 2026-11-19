//! Every session by sid, with its latest Summary, and the `watch` subscribers.
//!
//! One `std::sync::Mutex` guards it, and nothing awaits while holding it. Pushing to a
//! connection's `OutQ` never blocks, so events to watchers go out under the lock, which
//! makes `watch` gap-free: the snapshot reply and the registration happen in one
//! critical section.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::{Serialize, Serializer};
use tokio::sync::mpsc;
use wb_proto::hub::{ErrorCode, HubMessage, Kind, Summary};

use crate::conn::{ConnId, Viewer, line};
use crate::{acp, lock, now_ms, pty};

/// Commands a session actor buffers before senders wait.
const CMD_QUEUE: usize = 8;

#[derive(Default)]
pub struct Registry {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    sessions: BTreeMap<String, Entry>,
    watchers: Vec<Viewer>,
    /// The last `createdAt` handed out; each new one is larger.
    last_created: u64,
    /// Set by [`Registry::stop`]: no session is created any more.
    stopping: bool,
}

impl Inner {
    fn summaries(&self) -> impl Clone + Iterator<Item = &Arc<Summary>> {
        self.sessions.values().filter_map(|e| e.summary.as_ref())
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

/// Encode the complete, sid-sorted snapshot directly rather than materializing it
/// as a tree of JSON values in `HubMessage::ok`.
fn sessions_line<'a>(
    rid: u64,
    sessions: impl Clone + Iterator<Item = &'a Arc<Summary>>,
) -> Arc<[u8]> {
    #[derive(Serialize)]
    #[serde(tag = "t", rename = "ok")]
    struct Snapshot<T> {
        rid: u64,
        sessions: T,
    }

    struct Summaries<I>(I);
    impl<'a, I: Clone + Iterator<Item = &'a Arc<Summary>>> Serialize for Summaries<I> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.collect_seq(self.0.clone().map(Arc::as_ref))
        }
    }

    line(&Snapshot {
        rid,
        sessions: Summaries(sessions),
    })
}

impl Registry {
    pub fn published_count(&self) -> usize {
        lock(&self.inner).summaries().count()
    }

    pub fn list(&self, rid: u64) -> Arc<[u8]> {
        let inner = lock(&self.inner);
        let mut snapshot = Vec::with_capacity(inner.sessions.len());
        snapshot.extend(inner.summaries().cloned());
        drop(inner);
        sessions_line(rid, snapshot.iter())
    }

    /// Replies to `watch` with every Summary and subscribes `viewer` to later changes.
    pub fn watch(&self, viewer: Viewer, rid: u64) {
        let mut inner = lock(&self.inner);
        viewer
            .outq
            .push_reply(sessions_line(rid, inner.summaries()));
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

    /// Compare `epoch` and take the matching actor's sender in one critical section,
    /// even for a registered session whose first Summary hasn't been published yet.
    fn action_sender<C: SessionCmd>(
        &self,
        sid: &str,
        epoch: Option<u64>,
    ) -> Result<mpsc::Sender<C>, (ErrorCode, String)> {
        let inner = lock(&self.inner);
        let entry = inner
            .sessions
            .get(sid)
            .ok_or_else(|| (ErrorCode::NotFound, format!("no session {sid}")))?;
        if epoch.is_some_and(|epoch| epoch != entry.created_at) {
            return Err((ErrorCode::Stale, "the session was created again".into()));
        }
        C::unwrap(&entry.tx).ok_or_else(|| {
            let kind = if entry.tx.kind() == Kind::Pty {
                "pty"
            } else {
                "acp"
            };
            (
                ErrorCode::KindMismatch,
                format!("{sid} is a {kind} session"),
            )
        })
    }

    pub async fn deliver<C: SessionCmd>(&self, sid: &str, cmd: C) {
        match self.action_sender::<C>(sid, cmd.expected_epoch()) {
            Ok(tx) => {
                if let Err(unsent) = tx.send(cmd).await {
                    unsent
                        .0
                        .refuse(ErrorCode::NotFound, format!("no session {sid}"));
                }
            }
            Err((code, msg)) => cmd.refuse(code, msg),
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
    pub fn route<C: SessionCmd>(&self, sid: &str, create: bool) -> Route<C> {
        let mut inner = lock(&self.inner);
        if let Some(e) = inner.sessions.get(sid) {
            return C::unwrap(&e.tx).map_or(Route::NotFound, Route::Send);
        }
        if !create {
            return Route::NotFound;
        }
        if inner.stopping {
            return Route::Stopping;
        }
        let created_at = now_ms().max(inner.last_created + 1);
        inner.last_created = created_at;
        let (tx, rx) = mpsc::channel(CMD_QUEUE);
        let entry = Entry {
            created_at,
            tx: C::wrap(tx),
            summary: None,
        };
        inner.sessions.insert(sid.to_owned(), entry);
        Route::Created { created_at, rx }
    }

    /// Registers a session found in the state directory at startup, with its `createdAt`,
    /// or with a new one when its record could not be read. The caller starts its actor
    /// on the returned channel.
    pub fn load<C: SessionCmd>(
        &self,
        sid: &str,
        created_at: Option<u64>,
    ) -> (u64, mpsc::Receiver<C>) {
        let mut inner = lock(&self.inner);
        let created_at = created_at.unwrap_or_else(|| now_ms().max(inner.last_created + 1));
        inner.last_created = inner.last_created.max(created_at);
        let (tx, rx) = mpsc::channel(CMD_QUEUE);
        let entry = Entry {
            created_at,
            tx: C::wrap(tx),
            summary: None,
        };
        inner.sessions.insert(sid.to_owned(), entry);
        (created_at, rx)
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
            #[derive(Serialize)]
            #[serde(tag = "t", rename = "session")]
            struct Update<'a> {
                session: &'a Summary,
            }
            let msg = line(&Update { session });
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

    /// The child pids of every live PTY session.
    pub fn live_pids(&self) -> Vec<u32> {
        lock(&self.inner)
            .sessions
            .values()
            .filter_map(Entry::pid)
            .collect()
    }

    /// Stops creating sessions and returns every session's sender.
    pub fn stop(&self) -> Vec<Tx> {
        let mut inner = lock(&self.inner);
        inner.stopping = true;
        inner.sessions.values().map(|e| e.tx.clone()).collect()
    }
}
