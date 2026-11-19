use std::cell::Cell;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wb_proto::line;

use super::*;
use crate::hub::ready_tests::{Browser, buffered};

#[tokio::test]
async fn failed_flush_keeps_superseded_open_reply_for_pending_kill() {
    // B was opening when killed, then A superseded it and became current.
    let rid_b = 1;
    let (hub, mut wire, first) = buffered(&line::encode(&HubMessage::ok(rid_b, &json!({})))).await;
    wire.shutdown().await.unwrap(); // lost lookahead yields EOF, not a timeout
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
                deadline: Instant::now() + REPLY_TIMEOUT,
                kill: Some(true),
            },
        )]),
    };
    let saw_reply = Cell::new(false);
    let mut browser = Browser::failing();
    let end = relay
        .hub
        .send_ready(&mut browser, first.clone(), |msg| {
            assert!(matches!(msg, HubMessage::Ok { rid, .. } if *rid == rid_b));
            saw_reply.set(true);
            None
        })
        .await;
    assert!(saw_reply.get(), "flush failed before consuming B's reply");
    assert!(!relay.hub.has_buffered_line(), "B's reply was not consumed");
    assert!(matches!(end, Err(End::Gone)));
    assert_eq!(browser.flushes, [vec![first]]);

    assert!(relay.finish_kills().await.is_ok());
    drop(relay);
    let mut requests = Vec::new();
    wire.read_to_end(&mut requests).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<HubRequest>(&requests).unwrap(),
        HubRequest::PtyKill {
            rid: 3,
            sid: "B".into(),
            forget: true,
        }
    );
}
