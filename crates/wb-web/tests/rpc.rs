//! The control connection's results through `/rpc`, `/api/info`, `/api/sessions`,
//! `/api/status` and capture, as the hub comes and goes (design §3.5.3, §3.5.5, 20-web
//! §9 and §11.2 "Hub down").

mod common;

use std::time::{Duration, Instant};

use common::{FakeHub, Hello, Web, Ws, next_json, pty_summary, read_to_close};
use serde_json::{Value, json};
use wb_proto::hub::{Agent, ErrorCode, HubMessage, HubRequest};

const STARTED_AT: u64 = 1_700_000_000_000;
/// What the web under test was built with; the binary and this crate share the build.
const WEB_BUILD: Option<&str> = option_env!("WB_HUB_BUILD");
const WEB_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Polls `/api/sessions` until `pred` holds.
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

/// `summary` as the browser gets it.
fn with_state(summary: &wb_proto::hub::Summary, state: &str) -> Value {
    let mut v = serde_json::to_value(summary).unwrap();
    v["state"] = state.into();
    v
}

async fn up_with(hello: Hello) -> (FakeHub, Web, Ws) {
    let hub = FakeHub::start_with(hello);
    let web = Web::start(&hub.path);
    let mut rpc = web.ws("/rpc").await;
    loop {
        let msg = next_json(&mut rpc).await;
        if msg["t"] == "sessions" {
            break;
        }
    }
    (hub, web, rpc)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_status_and_sessions_follow_the_hub() {
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
    assert_eq!(
        info["hub"],
        json!({"status": "down", "version": null, "build": null, "proto": null,
               "startedAt": null, "stale": null})
    );
    assert_eq!(info["shells"], json!([]));
    assert_eq!(info["defaultShell"], Value::Null);

    let hub = FakeHub::start_at(dir, path);
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "hub", "status": "up", "version": "0.1.0", "startedAt": STARTED_AT,
               "stale": WEB_VERSION != "0.1.0"})
    );
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "sessions", "sessions": []})
    );

    // The control connection keeps the session map and feeds every change to /rpc.
    let s1 = pty_summary("s1", 5, true, false);
    hub.send(
        0,
        HubMessage::Session {
            session: Box::new(s1.clone()),
        },
    );
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "session", "session": with_state(&s1, "idle")})
    );
    let body = sessions_until(&web, |b| b["sessions"].as_array().unwrap().len() == 1).await;
    assert_eq!(
        body,
        json!({"host": "testhost", "sessions": [with_state(&s1, "idle")]})
    );
    // Every gone reaches /rpc, where the frontend matches the epoch. Only the matching
    // incarnation leaves the map.
    for epoch in [4, 5] {
        hub.send(
            0,
            HubMessage::Gone {
                sid: "s1".into(),
                epoch,
            },
        );
        assert_eq!(
            next_json(&mut rpc).await,
            json!({"t": "gone", "sid": "s1", "epoch": epoch})
        );
        if epoch == 4 {
            assert_eq!(
                sessions_until(&web, |_| true).await["sessions"][0]["sid"],
                "s1"
            );
        }
    }
    sessions_until(&web, |b| b["sessions"] == json!([])).await;

    // Dropping the control connection: down, then up again with a fresh snapshot.
    let s2 = pty_summary("s2", 9, true, true);
    hub.set_sessions(vec![s2.clone()]);
    hub.close(0);
    assert_eq!(next_json(&mut rpc).await["status"], "down");
    assert_eq!(next_json(&mut rpc).await["status"], "up");
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "sessions", "sessions": [with_state(&s2, "running")]})
    );

    hub.stop();
    assert_eq!(next_json(&mut rpc).await["status"], "down");
    assert_eq!(web.req("GET", "/api/sessions").send().await.status, 503);
    let mut pty = web.ws("/pty").await;
    assert_eq!(read_to_close(&mut pty).await.0, 1013);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_rpc_client_gets_the_sessions_with_their_state() {
    let hub = FakeHub::start();
    let (idle, running, exited) = (
        pty_summary("a1", 1, true, false),
        pty_summary("b2", 2, true, true),
        pty_summary("c3", 3, false, false),
    );
    hub.set_sessions(vec![idle.clone(), running.clone(), exited.clone()]);
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;
    let mut rpc = web.ws("/rpc").await;
    assert_eq!(next_json(&mut rpc).await["status"], "up");
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "sessions", "sessions": [
            with_state(&idle, "idle"), with_state(&running, "running"), with_state(&exited, "exited"),
        ]})
    );
    let body = web.req("GET", "/api/sessions").send().await.json();
    assert_eq!(body["sessions"][1]["state"], "running");
    assert_eq!(body["sessions"][2]["state"], "exited");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_board_write_reaches_every_rpc_client() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let mut a = web.ws("/rpc").await;
    let mut b = web.ws("/rpc").await;
    assert_eq!(next_json(&mut a).await["t"], "hub");
    assert_eq!(next_json(&mut b).await["t"], "hub");
    let etag = web.req("GET", "/api/board").send().await;
    let res = web
        .req("PUT", "/api/board")
        .add("If-Match", etag.header("etag").unwrap())
        .body(r#"{"nodes":[],"edges":[]}"#)
        .send()
        .await;
    assert_eq!(res.status, 204);
    let tag = res.header("etag").unwrap();
    for rpc in [&mut a, &mut b] {
        assert_eq!(next_json(rpc).await, json!({"t": "board", "etag": tag}));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn info_reports_what_the_hub_hello_says() {
    let (_hub, web, _rpc) = up_with(Hello {
        agents: vec![Agent {
            name: "claude".into(),
            label: "Claude".into(),
        }],
        shells: vec!["bash".into(), "nu".into(), "zsh".into()],
        default_shell: "zsh".into(),
        ..Hello::default()
    })
    .await;
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["shells"], json!(["bash", "nu", "zsh"]));
    assert_eq!(info["defaultShell"], "zsh");
    assert_eq!(
        info["agents"],
        json!([{"name": "claude", "label": "Claude"}])
    );
    assert_eq!(
        info["hub"],
        json!({"status": "up", "version": "0.1.0", "build": null, "proto": 1,
               "startedAt": STARTED_AT, "stale": WEB_VERSION != "0.1.0"})
    );
    for (key, want) in [
        ("models", json!({})),
        ("dist", Value::Null),
        ("tmux", json!(false)),
        ("artifactOrigin", Value::Null),
        ("sample", json!(false)),
    ] {
        assert_eq!(info[key], want, "{key}");
    }

    // A hub from before shell choice: no shells, no default.
    let (_hub, web, _rpc) = up_with(Hello {
        shells: Vec::new(),
        default_shell: String::new(),
        ..Hello::default()
    })
    .await;
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["shells"], json!([]));
    assert_eq!(info["defaultShell"], Value::Null);
}

/// `stale` in `/api/info` and `/rpc` for a hub announcing `version` and `build`.
async fn stale_for(version: &str, build: Option<&str>) -> bool {
    let hub = FakeHub::start_with(Hello {
        version: version.into(),
        build: build.map(str::to_owned),
        ..Hello::default()
    });
    let web = Web::start(&hub.path);
    let rpc = web.wait_hub("up").await;
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["hub"]["stale"], rpc["stale"]);
    assert_eq!(info["hub"]["build"], json!(build));
    assert_eq!(rpc.get("build"), build.map(Value::from).as_ref());
    info["hub"]["stale"].as_bool().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_compares_builds_when_both_have_one_else_versions() {
    // A different build: stale whenever this web has a build to compare.
    assert_eq!(
        stale_for(WEB_VERSION, Some("another-build")).await,
        WEB_BUILD.is_some()
    );
    assert!(!stale_for(WEB_VERSION, None).await);
    assert!(stale_for("0.0.0-other", None).await);
    // The same build wins over a different version.
    assert_eq!(
        stale_for("0.0.0-other", WEB_BUILD).await,
        WEB_BUILD.is_none()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_counts_sessions_by_state() {
    let hub = FakeHub::start();
    hub.set_sessions(vec![
        pty_summary("a1", 1, true, false),
        pty_summary("b2", 2, true, false),
        pty_summary("c3", 3, true, true),
        pty_summary("d4", 4, false, false),
    ]);
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;
    let res = web.req("GET", "/api/status").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("cache-control"), Some("no-store"));
    let status = res.json();
    assert_eq!(status["host"], "testhost");
    assert!(status["time"].as_u64().unwrap() > 1_700_000_000);
    assert_eq!(
        status["sessions"],
        json!({"alive": 3, "tmux": 0, "byState": {"idle": 2, "running": 1, "exited": 1}})
    );
    assert_eq!(status["load"].as_array().unwrap().len(), 3);
    for key in ["total", "available"] {
        assert!(status["mem"][key].as_u64().unwrap() > 0, "mem.{key}");
    }
    assert!(status["mem"]["total"].as_u64() >= status["mem"]["available"].as_u64());
    assert!(status["uptime"].is_u64());
    assert!(status["disk"]["total"].as_u64() >= status["disk"]["free"].as_u64());
    assert_eq!(
        status["units"],
        json!({"total": 0, "active": 0, "failed": 0, "failedNames": []})
    );

    hub.stop();
    web.wait_hub("down").await;
    let status = web.req("GET", "/api/status").send().await.json();
    assert_eq!(
        status["sessions"],
        json!({"alive": null, "tmux": null, "byState": null})
    );
    assert_eq!(status["load"].as_array().unwrap().len(), 3);
}

fn captures(hub: &FakeHub) -> Vec<(usize, String, Option<u32>)> {
    hub.requests()
        .into_iter()
        .filter_map(|(conn, r)| match r {
            HubRequest::PtyCapture { sid, lines, .. } => Some((conn, sid, lines)),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capture_goes_over_the_control_connection() {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;

    hub.reply_next_capture(Ok("$ make\nok\n"));
    let res = web.req("GET", "/api/pty/a1/capture?lines=50").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(
        res.json(),
        json!({"id": "a1", "tmux": false, "text": "$ make\nok\n"})
    );
    // The default, the clamps, and `token` ignored.
    for query in ["", "?lines=5000", "?lines=0", "?token=MARK1"] {
        let res = web
            .req("GET", &format!("/api/pty/a1/capture{query}"))
            .send()
            .await;
        assert_eq!(res.status, 200, "{query}");
    }
    assert_eq!(
        captures(&hub),
        [
            (0, "a1".into(), Some(50)),
            (0, "a1".into(), Some(200)),
            (0, "a1".into(), Some(1000)),
            (0, "a1".into(), Some(1)),
            (0, "a1".into(), Some(200)),
        ]
    );

    hub.reply_next_capture(Err((ErrorCode::NotFound, "no session b2")));
    let res = web.req("GET", "/api/pty/b2/capture").send().await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json(), json!({"error": "no terminal b2"}));
    hub.reply_next_capture(Err((ErrorCode::KindMismatch, "b3 is acp")));
    assert_eq!(
        web.req("GET", "/api/pty/b3/capture").send().await.status,
        404
    );
    hub.reply_next_capture(Err((ErrorCode::Internal, "vt state lost")));
    let res = web.req("GET", "/api/pty/b4/capture").send().await;
    assert_eq!(res.status, 502);
    assert_eq!(res.json(), json!({"error": "vt state lost"}));

    for (path, error) in [
        ("/api/pty/a1/capture?lines=many", "bad query"),
        ("/api/pty/a1/capture?lines=-1", "bad query"),
        ("/api/pty/!!!/capture", "bad id"),
    ] {
        let res = web.req("GET", path).send().await;
        assert_eq!(res.status, 400, "{path}");
        assert_eq!(res.json(), json!({"error": error}), "{path}");
    }
    assert_eq!(captures(&hub).len(), 8);

    hub.stop();
    web.wait_hub("down").await;
    let res = web.req("GET", "/api/pty/a1/capture").send().await;
    assert_eq!(res.status, 503);
    assert_eq!(res.json(), json!({"error": "hub unavailable"}));
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
