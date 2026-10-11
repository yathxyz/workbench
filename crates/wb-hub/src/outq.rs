//! `OutQ`: the byte-capped outbound queue of one connection.
//!
//! Events are pushed without waiting. One that would take the queue past
//! [`CONN_QUEUE`] closes the connection instead, except that an empty queue admits an
//! event of any size. Replies are always admitted; the connection's reader stops
//! reading requests while the queue is at the cap, so replies are bounded too.
//!
//! A finished queue admits nothing more but still delivers what it holds.

use std::collections::VecDeque;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;
use wb_proto::limits::CONN_QUEUE;

use crate::lock;

/// The connection is closed; nothing more will be written to it.
#[derive(Debug, PartialEq, Eq)]
pub struct Closed;

#[derive(Default)]
pub struct OutQ {
    st: Mutex<State>,
    changed: Notify,
}

#[derive(Default)]
struct State {
    q: VecDeque<Arc<[u8]>>,
    bytes: usize,
    closed: bool,
    finished: bool,
}

impl OutQ {
    pub fn push_event(&self, line: Arc<[u8]>) -> Result<(), Closed> {
        let mut st = lock(&self.st);
        if st.closed || st.finished {
            return Err(Closed);
        }
        if st.bytes > 0 && st.bytes + line.len() > CONN_QUEUE {
            st.close();
            drop(st);
            self.changed.notify_waiters();
            return Err(Closed);
        }
        st.bytes += line.len();
        st.q.push_back(line);
        drop(st);
        self.changed.notify_waiters();
        Ok(())
    }

    pub fn push_reply(&self, line: Arc<[u8]>) {
        let mut st = lock(&self.st);
        if st.closed || st.finished {
            return;
        }
        st.bytes += line.len();
        st.q.push_back(line);
        drop(st);
        self.changed.notify_waiters();
    }

    /// Ignores later pushes; [`pop`](Self::pop) ends once the queue is empty.
    pub fn finish(&self) {
        lock(&self.st).finished = true;
        self.changed.notify_waiters();
    }

    /// Drops everything queued; later pushes are ignored.
    pub fn close(&self) {
        lock(&self.st).close();
        self.changed.notify_waiters();
    }

    /// The next line to write, or `None` once the queue is closed, or finished and empty.
    pub async fn pop(&self) -> Option<Arc<[u8]>> {
        let line = self
            .wait(|st| {
                if st.closed || (st.finished && st.q.is_empty()) {
                    return Some(None);
                }
                let line = st.q.pop_front()?;
                st.bytes -= line.len();
                Some(Some(line))
            })
            .await;
        if line.is_some() {
            self.changed.notify_waiters();
        }
        line
    }

    /// Waits until `line` fits under the cap, or the queue is empty, then queues it
    /// (10-hub §4.3), so a replay never takes the queue past the cap. Whether it was
    /// queued: not once the queue is closed or `cancel` is set, which a replaced
    /// replay sees under the queue's lock, before the reply of the open that replaced
    /// it.
    pub async fn push_paced(&self, line: Arc<[u8]>, cancel: &AtomicBool) -> bool {
        let queued = self
            .wait(|st| {
                if st.closed || st.finished || cancel.load(Ordering::Relaxed) {
                    Some(false)
                } else if st.bytes == 0 || st.bytes + line.len() <= CONN_QUEUE {
                    st.bytes += line.len();
                    st.q.push_back(line.clone());
                    Some(true)
                } else {
                    None
                }
            })
            .await;
        if queued {
            self.changed.notify_waiters();
        }
        queued
    }

    /// Waits until the writer has taken everything queued. Whether it did: not once
    /// the queue is closed or `cancel` is set.
    pub async fn drained(&self, cancel: &AtomicBool) -> bool {
        self.wait(|st| {
            if st.closed || cancel.load(Ordering::Relaxed) {
                Some(false)
            } else if st.q.is_empty() {
                Some(true)
            } else {
                None
            }
        })
        .await
    }

    /// Waits until the queue is below the cap.
    pub async fn room(&self) -> Result<(), Closed> {
        self.wait(|st| {
            if st.closed {
                Some(Err(Closed))
            } else if st.bytes < CONN_QUEUE {
                Some(Ok(()))
            } else {
                None
            }
        })
        .await
    }

    pub async fn closed(&self) {
        self.wait(|st| st.closed.then_some(())).await
    }

    async fn wait<T>(&self, mut ready: impl FnMut(&mut State) -> Option<T>) -> T {
        loop {
            let mut changed = pin!(self.changed.notified());
            changed.as_mut().enable();
            if let Some(t) = ready(&mut lock(&self.st)) {
                return t;
            }
            changed.await;
        }
    }
}

impl State {
    fn close(&mut self) {
        self.closed = true;
        self.q.clear();
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(n: usize) -> Arc<[u8]> {
        vec![b'x'; n].into()
    }

    #[tokio::test]
    async fn an_event_over_the_cap_closes_a_non_empty_queue() {
        let q = OutQ::default();
        q.push_event(line(10)).unwrap();
        assert_eq!(q.push_event(line(CONN_QUEUE)), Err(Closed));
        assert_eq!(q.pop().await, None);
        assert_eq!(q.push_event(line(1)), Err(Closed));
    }

    #[tokio::test]
    async fn an_empty_queue_admits_any_event() {
        let q = OutQ::default();
        q.push_event(line(10 << 20)).unwrap();
        assert_eq!(q.pop().await.unwrap().len(), 10 << 20);
        q.push_event(line(CONN_QUEUE)).unwrap();
        q.push_reply(line(5));
        assert_eq!(q.pop().await.unwrap().len(), CONN_QUEUE);
        assert_eq!(q.pop().await.unwrap().len(), 5);
    }

    #[tokio::test]
    async fn replies_are_admitted_over_the_cap() {
        let q = OutQ::default();
        q.push_reply(line(CONN_QUEUE));
        q.push_reply(line(CONN_QUEUE));
        assert_eq!(q.pop().await.unwrap().len(), CONN_QUEUE);
        assert_eq!(q.pop().await.unwrap().len(), CONN_QUEUE);
    }

    #[tokio::test]
    async fn room_waits_for_the_writer() {
        let q = Arc::new(OutQ::default());
        q.push_reply(line(CONN_QUEUE));
        let waiter = tokio::spawn({
            let q = q.clone();
            async move { q.room().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        q.pop().await.unwrap();
        assert_eq!(waiter.await.unwrap(), Ok(()));
    }

    #[tokio::test]
    async fn push_paced_waits_until_the_line_fits() {
        let q = Arc::new(OutQ::default());
        let go = Arc::new(AtomicBool::new(false));
        assert!(q.push_paced(line(10 << 20), &go).await);
        let paced = |n| {
            let (q, go) = (q.clone(), go.clone());
            tokio::spawn(async move { q.push_paced(line(n), &go).await })
        };
        let pusher = paced(1);
        tokio::task::yield_now().await;
        assert!(!pusher.is_finished());
        assert_eq!(q.pop().await.unwrap().len(), 10 << 20);
        assert!(pusher.await.unwrap());
        assert!(q.push_paced(line(CONN_QUEUE - 1), &go).await);
        let pusher = paced(1);
        tokio::task::yield_now().await;
        assert!(
            !pusher.is_finished(),
            "1 + (CONN_QUEUE - 1) + 1 is over the cap"
        );
        assert_eq!(q.pop().await.unwrap().len(), 1);
        assert!(pusher.await.unwrap());

        // Cancelled while it waits: nothing is queued once there is room.
        let pusher = paced(1);
        tokio::task::yield_now().await;
        go.store(true, Ordering::Relaxed);
        assert_eq!(q.pop().await.unwrap().len(), CONN_QUEUE - 1);
        assert!(!pusher.await.unwrap());
        assert_eq!(q.pop().await.unwrap().len(), 1);
        go.store(false, Ordering::Relaxed);
        q.close();
        assert!(!q.push_paced(line(1), &go).await);
    }

    #[tokio::test]
    async fn drained_waits_for_the_writer() {
        let q = Arc::new(OutQ::default());
        let go = Arc::new(AtomicBool::new(false));
        assert!(q.drained(&go).await);
        q.push_reply(line(3));
        q.push_reply(line(4));
        let drained = || {
            let (q, go) = (q.clone(), go.clone());
            tokio::spawn(async move { q.drained(&go).await })
        };
        let waiter = drained();
        tokio::task::yield_now().await;
        q.pop().await.unwrap();
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        q.pop().await.unwrap();
        assert!(waiter.await.unwrap());

        // Cancelled while it waits: it ends at the next change.
        q.push_reply(line(5));
        q.push_reply(line(6));
        let waiter = drained();
        tokio::task::yield_now().await;
        go.store(true, Ordering::Relaxed);
        q.pop().await.unwrap();
        assert!(!waiter.await.unwrap());
        go.store(false, Ordering::Relaxed);
        q.close();
        assert!(!q.drained(&go).await);
    }

    #[tokio::test]
    async fn a_finished_queue_delivers_what_it_holds_then_ends() {
        let q = Arc::new(OutQ::default());
        q.push_reply(line(3));
        q.finish();
        q.push_reply(line(4));
        assert_eq!(q.push_event(line(5)), Err(Closed));
        assert_eq!(q.pop().await.unwrap().len(), 3);
        assert_eq!(q.pop().await, None);

        // A pop already waiting on an empty queue ends too.
        let q = Arc::new(OutQ::default());
        let popper = tokio::spawn({
            let q = q.clone();
            async move { q.pop().await }
        });
        tokio::task::yield_now().await;
        q.finish();
        assert_eq!(popper.await.unwrap(), None);
    }

    #[tokio::test]
    async fn close_wakes_a_blocked_pop() {
        let q = Arc::new(OutQ::default());
        let popper = tokio::spawn({
            let q = q.clone();
            async move { q.pop().await }
        });
        tokio::task::yield_now().await;
        q.close();
        assert_eq!(popper.await.unwrap(), None);
        q.closed().await;
        assert_eq!(q.room().await, Err(Closed));
    }
}
