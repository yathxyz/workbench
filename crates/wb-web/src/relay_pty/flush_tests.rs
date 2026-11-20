use std::cell::Cell;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wb_proto::line;

use super::*;
use crate::hub::ready_tests::{Browser, buffered};

#[tokio::test(start_paused = true)]
async fn failed_flush_keeps_superseded_open_reply_for_pending_kill() {
    // B was opening when killed, then A superseded it and became current.
    let rid_b = 1;
    let (hub, mut wire, first) = buffered(&line::encode(&HubMessage::ok(rid_b, &json!({})))).await;
    wire.shutdown().await.unwrap(); // lost lookahead yields EOF, not a timeout
    let deadline = Instant::now() + REPLY_TIMEOUT;
    let mut relay = Relay {
        hub,
        default_shell: String::new(),
        next_rid: 2,
        cur: Some("A".into()),
        pending: None,
        superseded: HashMap::from([(
            rid_b,
            PendingOpen {
                rid: rid_b,
                sid: "B".into(),
                deadline,
                kill: Some(true),
            },
        )]),
    };
    let saw_reply = Cell::new(false);
    let mut browser = Browser::flushing_after(deadline + REPLY_TIMEOUT, true);
    let end = relay
        .hub
        .send_ready(&mut browser, first.clone(), |msg| {
            assert!(matches!(msg, HubMessage::Ok { rid, .. } if *rid == rid_b));
            assert!(Instant::now() < deadline, "B's reply arrived too late");
            saw_reply.set(true);
            None
        })
        .await;
    assert!(saw_reply.get(), "flush failed before consuming B's reply");
    assert!(!relay.hub.has_buffered_line(), "B's reply was not consumed");
    assert!(matches!(end, Err(End::Gone)));
    assert!(
        Instant::now() > deadline,
        "flush did not outlive B's deadline"
    );
    assert_eq!(browser.flushes, [vec![first]]);

    assert!(relay.finish_kills().await.is_ok());
    drop(relay);
    let mut requests = Vec::new();
    wire.read_to_end(&mut requests).await.unwrap();
    assert!(!requests.is_empty(), "cleanup dropped B's pending kill");
    assert_eq!(
        serde_json::from_slice::<HubRequest>(&requests).unwrap(),
        HubRequest::PtyKill {
            rid: 3,
            sid: "B".into(),
            epoch: None,
            forget: true,
        }
    );
}

#[tokio::test(start_paused = true)]
async fn failed_flush_leaves_a_non_kill_reply_parked_after_cleanup() {
    for unrelated_kill in [None, Some(true)] {
        let rid_b = 1;
        let (hub, mut wire, first) =
            buffered(&line::encode(&HubMessage::ok(rid_b, &json!({})))).await;
        let deadline = Instant::now() + REPLY_TIMEOUT;
        let mut relay = Relay {
            hub,
            default_shell: String::new(),
            next_rid: 3,
            cur: Some("A".into()),
            pending: None,
            superseded: HashMap::from([
                (
                    rid_b,
                    PendingOpen {
                        rid: rid_b,
                        sid: "B".into(),
                        deadline,
                        kill: None,
                    },
                ),
                (
                    2,
                    PendingOpen {
                        rid: 2,
                        sid: "C".into(),
                        deadline,
                        kill: unrelated_kill,
                    },
                ),
            ]),
        };
        let mut browser = Browser::flushing_after(deadline + REPLY_TIMEOUT, true);
        let end = relay.hub.send_ready(&mut browser, first, |_| None).await;
        assert!(matches!(end, Err(End::Gone)));
        assert!(Instant::now() > deadline);
        assert!(!relay.hub.has_buffered_line());

        assert!(relay.finish_kills().await.is_ok());
        let parked = relay.hub.take_parked();
        drop(relay);
        let mut requests = Vec::new();
        wire.read_to_end(&mut requests).await.unwrap();
        assert!(requests.is_empty(), "shutdown detached an unrelated open");
        assert!(matches!(parked, Some(HubMessage::Ok { rid, .. }) if rid == rid_b));
    }
}

#[tokio::test(start_paused = true)]
async fn reply_deadline_dispatches_parked_kill_after_successful_flush() {
    let rid_b = 1;
    let (hub, mut wire, first) = buffered(&line::encode(&HubMessage::ok(rid_b, &json!({})))).await;
    let deadline = Instant::now() + REPLY_TIMEOUT;
    let mut relay = Relay {
        hub,
        default_shell: String::new(),
        next_rid: 2,
        cur: Some("A".into()),
        pending: None,
        superseded: HashMap::from([(
            rid_b,
            PendingOpen {
                rid: rid_b,
                sid: "B".into(),
                deadline,
                kill: Some(true),
            },
        )]),
    };
    let mut browser = Browser::flushing_after(deadline + REPLY_TIMEOUT, false);
    let end = relay
        .hub
        .send_ready(&mut browser, first.clone(), |msg| {
            assert!(matches!(msg, HubMessage::Ok { rid, .. } if *rid == rid_b));
            assert!(Instant::now() < deadline, "B's reply arrived too late");
            None
        })
        .await;
    assert!(end.is_ok());
    assert!(Instant::now() > deadline);
    assert!(!relay.hub.has_buffered_line());
    assert_eq!(browser.flushes, [vec![first]]);

    // Force the timer-first ordering of the production select when both arms are ready.
    let msg = tokio::select! {
        biased;
        () = sleep_until(deadline) => relay.reply_deadline_msg(),
        _ = relay.hub.recv() => panic!("the already elapsed timer must win"),
    };
    let Ok(HubMessage::Ok { rid, result }) = msg else {
        panic!("reply deadline would close the browser despite the parked reply");
    };
    assert_eq!(rid, rid_b);
    assert!(matches!(relay.open_ok(rid, result).await, Ok(None)));
    assert!(relay.superseded.is_empty());
    assert!(relay.is_cur("A"));

    drop(relay);
    let mut requests = Vec::new();
    wire.read_to_end(&mut requests).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<HubRequest>(&requests).unwrap(),
        HubRequest::PtyKill {
            rid: 3,
            sid: "B".into(),
            epoch: None,
            forget: true,
        }
    );
}
