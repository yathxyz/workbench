//! Every session by sid, with its latest Summary, and the `watch` subscribers.
//!
//! One `std::sync::Mutex` guards it, and nothing awaits while holding it. Pushing to a
//! connection's `OutQ` never blocks, so events to watchers go out under the lock, which
//! makes `watch` gap-free: the snapshot reply and the registration happen in one
//! critical section.

use std::collections::BTreeMap;
use std::sync::Mutex;

use tokio::sync::mpsc;
use wb_proto::hub::{HubMessage, SessionsReply, Summary};

use crate::conn::{ConnId, Viewer, line};
use crate::pty::Cmd;
use crate::{lock, now_ms};

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

struct Entry {
    created_at: u64,
    tx: mpsc::Sender<Cmd>,
    /// `None` until the actor's first publish: the session is still being created and
    /// is invisible to `list` and `watch`.
    summary: Option<Summary>,
}

/// Where a `pty.open` goes.
pub enum Route {
    /// To this existing session.
    Send(mpsc::Sender<Cmd>),
    /// A new session was registered; the caller starts its actor on `rx`.
    Created {
        created_at: u64,
        rx: mpsc::Receiver<Cmd>,
    },
    NotFound,
    /// The hub is stopping and creates no session.
    Stopping,
}

impl Registry {
    pub fn list(&self) -> Vec<Summary> {
        lock(&self.inner)
            .sessions
            .values()
            .filter_map(|e| e.summary.clone())
            .collect()
    }

    /// Replies to `watch` with every Summary and subscribes `viewer` to later changes.
    pub fn watch(&self, viewer: Viewer, rid: u64) {
        let mut inner = lock(&self.inner);
        let sessions = inner
            .sessions
            .values()
            .filter_map(|e| e.summary.clone())
            .collect();
        viewer
            .outq
            .push_reply(line(&HubMessage::ok(rid, &SessionsReply { sessions })));
        inner.watchers.retain(|w| w.id != viewer.id);
        inner.watchers.push(viewer);
    }

    pub fn unwatch(&self, conn: ConnId) {
        lock(&self.inner).watchers.retain(|w| w.id != conn);
    }

    pub fn sender(&self, sid: &str) -> Option<mpsc::Sender<Cmd>> {
        lock(&self.inner).sessions.get(sid).map(|e| e.tx.clone())
    }

    /// Finds the session for `sid`, registering a new one when there is none and
    /// `create` is set.
    pub fn route(&self, sid: &str, create: bool) -> Route {
        let mut inner = lock(&self.inner);
        if let Some(e) = inner.sessions.get(sid) {
            return Route::Send(e.tx.clone());
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
            tx,
            summary: None,
        };
        inner.sessions.insert(sid.to_owned(), entry);
        Route::Created { created_at, rx }
    }

    /// Stores a session's new Summary and sends it to the watchers.
    pub fn publish(&self, summary: &Summary) {
        let mut inner = lock(&self.inner);
        let Some(entry) = inner.sessions.get_mut(&summary.sid) else {
            return;
        };
        if entry.created_at != summary.created_at {
            return;
        }
        entry.summary = Some(summary.clone());
        let msg = line(&HubMessage::Session {
            session: Box::new(summary.clone()),
        });
        inner
            .watchers
            .retain(|w| w.outq.push_event(msg.clone()).is_ok());
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

    /// The child pid of a live session.
    pub fn live_pid(&self, sid: &str) -> Option<u32> {
        lock(&self.inner)
            .sessions
            .get(sid)?
            .summary
            .as_ref()?
            .pty
            .as_ref()?
            .pid
    }

    /// Stops creating sessions and returns every session's sender.
    pub fn stop(&self) -> Vec<mpsc::Sender<Cmd>> {
        let mut inner = lock(&self.inner);
        inner.stopping = true;
        inner.sessions.values().map(|e| e.tx.clone()).collect()
    }
}
