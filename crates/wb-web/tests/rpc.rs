//! Hub status through `/rpc`, `/api/info` and `/api/sessions` as the hub comes and goes
//! (design §3.5.3, 20-web §11.2 "Hub down").

mod common;

use std::time::{Duration, Instant};

use common::{FakeHub, Web, next_json, read_to_close};
use serde_json::{Value, json};
use wb_proto::hub::HubMessage;

/// Polls `/api/sessions` until `pred` holds; the session map has no event to wait on.
async fn sessions_until(web: &Web, pred: impl Fn(&Value) -> bool) -> Value {
    let started = Instant::now();
    loop {
        let res = web.req("GET", "/api/sessions").send().await;
        if res.status == 200 {
            let body = res.json();
            if pred(&body) {
                return body;
            }
        }
        assert!(started.elapsed() < common::WAIT, "sessions never matched");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn summary(sid: &str, created_at: u64) -> Value {
    json!({
        "sid": sid, "kind": "pty", "host": "testhost", "createdAt": created_at,
        "updatedAt": created_at, "alive": true, "viewers": 0, "cwd": "/home/alice",
        "fault": null, "pty": {"argv": ["/test/bin/sh"], "pid": 7},
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_status_follows_the_hub() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hub.sock");
    let web = Web::start(&path);
    let mut rpc = web.ws("/rpc").await;
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "hub", "status": "down"})
    );
    let res = web.req("GET", "/api/sessions").send().await;
    assert_eq!(res.status, 503);
    assert_eq!(res.json(), json!({"error": "hub unavailable"}));
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["hub"]["status"], "down");

    let hub = FakeHub::start_at(dir, path);
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "hub", "status": "up", "version": "0.1.0",
               "startedAt": 1_700_000_000_000u64})
    );

    // The control connection keeps the session map.
    let session = serde_json::from_value(summary("s1", 5)).unwrap();
    hub.send(
        0,
        HubMessage::Session {
            session: Box::new(session),
        },
    );
    let body = sessions_until(&web, |b| b["sessions"].as_array().unwrap().len() == 1).await;
    assert_eq!(body["host"], "testhost");
    assert_eq!(body["sessions"][0]["sid"], "s1");
    // A gone for another incarnation leaves the entry; the matching one removes it.
    hub.send(
        0,
        HubMessage::Gone {
            sid: "s1".into(),
            epoch: 4,
        },
    );
    hub.send(
        0,
        HubMessage::Gone {
            sid: "s1".into(),
            epoch: 5,
        },
    );
    sessions_until(&web, |b| b["sessions"] == json!([])).await;

    // Dropping the control connection: down, then up again on reconnect.
    hub.close(0);
    assert_eq!(next_json(&mut rpc).await["status"], "down");
    assert_eq!(next_json(&mut rpc).await["status"], "up");

    hub.stop();
    assert_eq!(next_json(&mut rpc).await["status"], "down");
    assert_eq!(web.req("GET", "/api/sessions").send().await.status, 503);
    let mut pty = web.ws("/pty").await;
    assert_eq!(read_to_close(&mut pty).await.0, 1013);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_closes_1012_on_sigterm() {
    let dir = tempfile::tempdir().unwrap();
    let mut web = Web::start(&dir.path().join("hub.sock"));
    let mut rpc = web.ws("/rpc").await;
    assert_eq!(next_json(&mut rpc).await["t"], "hub");
    web.sigterm();
    assert_eq!(read_to_close(&mut rpc).await.0, 1012);
    assert!(web.wait_exit().await.success());
}
