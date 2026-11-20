use std::cell::Cell;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::extract::ws::Message;
use futures_util::{FutureExt, Sink};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::time::{Instant, Sleep, sleep_until};
use wb_proto::hub::HubMessage;
use wb_proto::line;

use super::HubConn;
use crate::http::End;

/// Each entry records exactly the text frames submitted since the previous flush.
#[derive(Default)]
pub(crate) struct Browser {
    queued: Vec<Value>,
    pub(crate) flushes: Vec<Vec<Value>>,
    fail_flush: bool,
    flush_after: Option<Pin<Box<Sleep>>>,
}

impl Browser {
    pub(crate) fn failing() -> Self {
        Self {
            fail_flush: true,
            ..Self::default()
        }
    }

    pub(crate) fn flushing_after(deadline: Instant, fail_flush: bool) -> Self {
        Self {
            flush_after: Some(Box::pin(sleep_until(deadline))),
            fail_flush,
            ..Self::default()
        }
    }
}

impl Sink<Message> for Browser {
    type Error = ();

    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), ()>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(mut self: Pin<&mut Self>, frame: Message) -> Result<(), ()> {
        let Message::Text(text) = frame else {
            panic!("expected a distinct text frame, got {frame:?}");
        };
        self.queued
            .push(serde_json::from_str(text.as_str()).unwrap());
        Ok(())
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
        if let Some(after) = &mut self.flush_after {
            std::task::ready!(after.as_mut().poll(cx));
        }
        let queued = std::mem::take(&mut self.queued);
        self.flushes.push(queued);
        Poll::Ready(if self.fail_flush { Err(()) } else { Ok(()) })
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
        self.poll_flush(cx)
    }
}

fn line(out: u64, data: &str) -> Vec<u8> {
    line::encode(&HubMessage::PtyOut {
        sid: "A".into(),
        d: data.into(),
        out,
    })
}

fn frame(msg: &HubMessage) -> Option<Value> {
    match msg {
        HubMessage::PtyOut { sid, d, out } if sid == "A" => {
            Some(json!({"t": "out", "d": d, "out": out}))
        }
        _ => None,
    }
}

/// Deliver the first event normally, then put the specified complete lines exactly
/// in decoder read-ahead, independent of socket read sizes and Tokio readiness.
pub(crate) async fn buffered(lines: &[u8]) -> (HubConn, UnixStream, Value) {
    let (client, mut peer) = UnixStream::pair().unwrap();
    let mut hub = HubConn::from_stream(client);
    peer.write_all(&line(1, "a")).await.unwrap();
    let first = frame(&hub.recv().await.unwrap()).unwrap();
    hub.rx.read_buffer_mut().extend_from_slice(lines);
    (hub, peer, first)
}

#[tokio::test]
async fn buffered_data_flushes_distinct_frames_before_yielding() {
    let (mut hub, _peer, first) = buffered(&[line(2, "b"), line(3, "c")].concat()).await;
    let mut browser = Browser::default();
    let sent = hub.send_ready(&mut browser, first, frame).now_or_never();
    assert!(sent.is_none(), "a ready batch completed without yielding");
    assert_eq!(
        browser.flushes,
        [vec![
            json!({"t": "out", "d": "a", "out": 1}),
            json!({"t": "out", "d": "b", "out": 2}),
            json!({"t": "out", "d": "c", "out": 3}),
        ]]
    );
}

#[tokio::test]
async fn malformed_buffered_line_flushes_before_buffered_or_socket_data() {
    let second = line(2, "b");
    let (mut hub, mut peer, first) = buffered(&[b"not JSON\n", second.as_slice()].concat()).await;
    peer.write_all(&line(3, "c")).await.unwrap();
    peer.shutdown().await.unwrap();
    let mut browser = Browser::default();
    assert!(matches!(
        hub.send_ready(&mut browser, first.clone(), frame)
            .now_or_never(),
        Some(Ok(()))
    ));
    assert_eq!(browser.flushes, [vec![first]]);
    assert!(
        hub.rx.read_buffer().ends_with(&second),
        "fresh input was read"
    );
    for (out, d) in [(2, "b"), (3, "c")] {
        assert_eq!(
            frame(&hub.recv().await.unwrap()),
            Some(json!({"t": "out", "d": d, "out": out}))
        );
    }
    assert!(hub.recv().await.is_none());
}

#[tokio::test]
async fn oversized_lookahead_is_still_raw_when_the_preceding_flush_fails() {
    let candidate = line(2, &"x".repeat(64 * 1024));
    let (mut hub, _peer, first) = buffered(&candidate).await;
    let mut browser = Browser::failing();
    let classified = Cell::new(false);
    let end = hub
        .send_ready(&mut browser, first.clone(), |msg| {
            classified.set(true);
            frame(msg)
        })
        .await;
    assert!(matches!(end, Err(End::Gone)));
    assert_eq!(browser.flushes, [vec![first]]);
    assert!(!classified.get(), "oversized candidate was classified");
    assert!(
        hub.rx.read_buffer().as_ref() == candidate.as_slice(),
        "raw candidate was consumed"
    );
}
