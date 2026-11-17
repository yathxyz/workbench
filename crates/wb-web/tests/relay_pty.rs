//! `/pty` against a fake hub (design §3.5.1, §3.5.4).

mod common;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use common::{
    DEFAULT_SHELL, FakeHub, Hello, OpenReply, Req, Web, Ws, next_json, read_to_close, send_json,
    spawned,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use wb_proto::hub::{
    ErrorCode, Exit, ExitReason, HubMessage, HubRequest, PtyOpenReply, Resume, SpawnPty,
};
use wb_proto::limits::{PTY_INPUT_FRAME, WS_MAX_PTY};

const EPOCH: u64 = 1_700_000_000_000;

async fn up() -> (FakeHub, Web) {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;
    (hub, web)
}

/// An open as a page load or reconnect sends it, minus `resume`: no `spawn`.
fn open(id: &str) -> Value {
    json!({
        "t": "open", "id": id, "cmd": "", "parent": "", "cwd": "", "tmux": "",
        "cols": 100, "rows": 30, "env": {"CANVAS_NODE": id},
    })
}

fn is_open(r: &HubRequest) -> bool {
    matches!(r, HubRequest::PtyOpen { .. })
}

/// The `spawn` field of every `pty.open` so far, in order.
fn spawns(hub: &FakeHub) -> Vec<Option<SpawnPty>> {
    hub.requests()
        .into_iter()
        .filter_map(|(_, r)| match r {
            HubRequest::PtyOpen { spawn, .. } => Some(spawn),
            _ => None,
        })
        .collect()
}

fn is_input(r: &HubRequest) -> bool {
    matches!(r, HubRequest::PtyInput { .. })
}

/// Opens `id` on a new `/pty` socket; returns the socket and its hub connection.
async fn attached(hub: &FakeHub, web: &Web, id: &str) -> (Ws, usize) {
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open(id)).await;
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    let (conn, _) = hub
        .wait_for(|r| matches!(r, HubRequest::PtyOpen { sid, .. } if sid == id))
        .await;
    (ws, conn)
}

/// The requests on one hub connection after its hello.
fn on_conn(hub: &FakeHub, conn: usize) -> Vec<HubRequest> {
    hub.requests()
        .into_iter()
        .filter(|(c, r)| *c == conn && !matches!(r, HubRequest::Hello { .. }))
        .map(|(_, r)| r)
        .collect()
}

fn rid_of(r: &HubRequest) -> u64 {
    match r {
        HubRequest::PtyOpen { rid, .. }
        | HubRequest::PtyDetach { rid, .. }
        | HubRequest::PtyKill { rid, .. } => *rid,
        other => panic!("no rid in {other:?}"),
    }
}

/// A pong proves all preceding browser frames were handled while the scripted
/// open was still pending; receiving a hello first would invalidate the test.
async fn browser_barrier(ws: &mut Ws) {
    let ping = b"pending open".to_vec();
    ws.send(Message::Ping(ping.clone().into())).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("no browser barrier")
            .expect("browser closed")
            .unwrap(),
        Message::Pong(ping.into())
    );
}

async fn pending_kill(browser_gone: bool, session: bool) {
    let (hub, web) = up().await;
    let release = hub.hold_next_open();
    let mut ws = web.ws("/pty").await;
    send_json(
        &mut ws,
        json!({"t": "open", "id": "pending", "spawn": true}),
    )
    .await;
    let (conn, request) = hub.wait_for(is_open).await;
    let kill = if session {
        json!({"t": "kill", "session": true})
    } else {
        json!({"t": "kill"})
    };
    send_json(&mut ws, kill).await;
    browser_barrier(&mut ws).await;
    if browser_gone {
        ws.close(None).await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("browser did not close");
        assert!(
            matches!(closed, None | Some(Ok(Message::Close(_))) | Some(Err(_))),
            "open replied before the browser disconnected: {closed:?}"
        );
    }
    release.send(Ok(spawned())).unwrap();
    if !browser_gone {
        assert_eq!(next_json(&mut ws).await["t"], "hello");
    }
    let (kill_conn, kill) = hub
        .wait_for(|r| matches!(r, HubRequest::PtyKill { .. }))
        .await;
    assert_eq!(kill_conn, conn);
    assert_eq!(
        kill,
        HubRequest::PtyKill {
            rid: rid_of(&request) + 1,
            sid: "pending".into(),
            forget: !session,
        }
    );
    assert_eq!(
        on_conn(&hub, conn)
            .iter()
            .filter(|r| matches!(r, HubRequest::PtyKill { .. }))
            .count(),
        1
    );
    if browser_gone {
        hub.wait_closed(conn).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_before_open_reply_kills_and_forgets_after_open() {
    pending_kill(false, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_before_open_reply_survives_browser_disconnect() {
    pending_kill(true, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_kill_before_open_reply_preserves_the_session_record() {
    pending_kill(false, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_kill_follows_its_superseded_open_not_the_new_sid() {
    let (hub, web) = up().await;
    let release = hub.hold_next_open();
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("old")).await;
    let (conn, _) = hub.wait_for(is_open).await;
    send_json(&mut ws, json!({"t": "kill"})).await;
    send_json(&mut ws, open("new")).await;
    browser_barrier(&mut ws).await;
    release.send(Ok(spawned())).unwrap();
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    let (kill_conn, kill) = hub
        .wait_for(|r| matches!(r, HubRequest::PtyKill { .. }))
        .await;
    assert_eq!(kill_conn, conn);
    assert!(matches!(
        kill,
        HubRequest::PtyKill { sid, forget: true, .. } if sid == "old"
    ));
    send_json(&mut ws, json!({"t": "in", "d": "still new"})).await;
    let (_, input) = hub.wait_for(is_input).await;
    assert!(matches!(input, HubRequest::PtyInput { sid, .. } if sid == "new"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reopen_of_the_same_sid_supersedes_its_pending_kill() {
    let (hub, web) = up().await;
    let release = hub.hold_next_open();
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("same")).await;
    let (conn, _) = hub.wait_for(is_open).await;
    send_json(&mut ws, json!({"t": "kill"})).await;
    send_json(&mut ws, open("same")).await;
    browser_barrier(&mut ws).await;
    release.send(Ok(spawned())).unwrap();
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    send_json(&mut ws, json!({"t": "in", "d": "still same"})).await;
    hub.wait_for(is_input).await;
    let requests = on_conn(&hub, conn);
    assert!(
        !requests
            .iter()
            .any(|r| matches!(r, HubRequest::PtyKill { .. } | HubRequest::PtyDetach { .. })),
        "old cleanup affected the reopened sid: {requests:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_pending_open_never_turns_its_kill_into_a_session_kill() {
    let (hub, web) = up().await;
    let release = hub.hold_next_open();
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("refused")).await;
    let (conn, _) = hub.wait_for(is_open).await;
    send_json(&mut ws, json!({"t": "kill"})).await;
    browser_barrier(&mut ws).await;
    release
        .send(Err((ErrorCode::NotFound, "no session refused")))
        .unwrap();
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    assert_eq!(
        texts,
        [json!({"t": "error", "error": "no session refused", "code": "not_found"})]
    );
    hub.wait_closed(conn).await;
    assert!(
        !on_conn(&hub, conn)
            .iter()
            .any(|r| matches!(r, HubRequest::PtyKill { .. }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_pending_kill_finishes_after_the_browser_disconnects() {
    let (hub, web) = up().await;
    let release = hub.hold_next_open();
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("refused")).await;
    let (conn, _) = hub.wait_for(is_open).await;
    send_json(&mut ws, json!({"t": "kill"})).await;
    browser_barrier(&mut ws).await;
    ws.close(None).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("browser did not close");
    assert!(matches!(
        closed,
        None | Some(Ok(Message::Close(_))) | Some(Err(_))
    ));
    release
        .send(Err((ErrorCode::NotFound, "no session refused")))
        .unwrap();
    hub.wait_closed(conn).await;
    assert!(
        !on_conn(&hub, conn)
            .iter()
            .any(|r| matches!(r, HubRequest::PtyKill { .. }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pending_kill_survives_a_browser_read_error() {
    let (hub, web) = up().await;
    let release = hub.hold_next_open();
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("too-big")).await;
    let (conn, _) = hub.wait_for(is_open).await;
    send_json(&mut ws, json!({"t": "kill"})).await;
    browser_barrier(&mut ws).await;
    let (mut tx, mut rx) = ws.split();
    let writer = tokio::spawn(async move {
        let _ = tx
            .send(Message::Text("x".repeat(WS_MAX_PTY + 1).into()))
            .await;
    });
    let (code, _) = read_to_close(&mut rx).await;
    assert_eq!(code, 1009);
    writer.abort();
    release.send(Ok(spawned())).unwrap();
    let (kill_conn, kill) = hub
        .wait_for(|r| matches!(r, HubRequest::PtyKill { .. }))
        .await;
    assert_eq!(kill_conn, conn);
    assert!(matches!(
        kill,
        HubRequest::PtyKill { sid, forget: true, .. } if sid == "too-big"
    ));
    hub.wait_closed(conn).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ordinary_browser_disconnect_does_not_kill_its_session() {
    let (hub, web) = up().await;
    let release = hub.hold_next_open();
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("kept")).await;
    let (conn, _) = hub.wait_for(is_open).await;
    browser_barrier(&mut ws).await;
    ws.close(None).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), ws.next())
        .await
        .expect("browser did not close");
    assert!(matches!(
        closed,
        None | Some(Ok(Message::Close(_))) | Some(Err(_))
    ));
    release.send(Ok(spawned())).unwrap();
    hub.wait_closed(conn).await;
    assert!(
        !on_conn(&hub, conn)
            .iter()
            .any(|r| matches!(r, HubRequest::PtyKill { .. }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_attach_uses_registry_and_default_shell() {
    const TOKEN: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const COMMAND: &str = "/run/current-system/sw/bin/attach-agent";
    let tokens = tempfile::tempdir().unwrap();
    let token = tokens.path().join("token");
    std::fs::write(&token, TOKEN).unwrap();
    let hub = FakeHub::start();
    let web = Web::start_with(&hub.path, |cfg| {
        cfg["attachCommand"] = json!(COMMAND);
        cfg["api"] = json!({
            "listen": "127.0.0.2:0",
            "clients": {"owner": {
                "tokenFile": token, "scopes": ["read", "events"], "host": "devbox"
            }}
        });
    });
    web.wait_hub("up").await;
    let addr = web.api_addr().await;
    let request = |method: &str, path: &str| {
        Req::to(addr, method, path).set("Authorization", &format!("Bearer {TOKEN}"))
    };
    for (sid, attach, kind) in [
        (
            "claude",
            json!({"kind": "claude", "id": "deadbeef"}),
            "start",
        ),
        (
            "tmux",
            json!({"kind": "tmux", "socket": "/tmp/tmux-1000/default", "pane": 17}),
            "start",
        ),
        ("none", Value::Null, "start"),
        ("ended", json!({"kind": "claude", "id": "deadbeef"}), "end"),
    ] {
        let response = request("POST", "/v1/events")
            .set("Content-Type", "application/json")
            .body(
                json!({
                    "harness": "pi", "attach": attach,
                    "payload": {"session_id": sid, "kind": kind}
                })
                .to_string(),
            )
            .send()
            .await;
        assert_eq!(response.status, 204);
    }
    let observed = request("GET", "/v1/observed").send().await.json();
    let mut rpc = web.ws("/rpc").await;
    for kind in ["hub", "board", "sessions"] {
        assert_eq!(next_json(&mut rpc).await["t"], kind);
    }
    let snapshot = next_json(&mut rpc).await;
    assert_eq!(snapshot["t"], "observed");
    assert_eq!(snapshot["sessions"], observed["sessions"]);
    for session in observed["sessions"].as_array().unwrap() {
        let response = request(
            "GET",
            &format!("/v1/observed/{}", session["id"].as_str().unwrap()),
        )
        .send()
        .await;
        assert_eq!(response.json(), *session);
        assert_eq!(
            session["attach"],
            match session["sessionId"].as_str().unwrap() {
                "claude" | "ended" => json!({"kind": "claude", "id": "deadbeef"}),
                "tmux" => {
                    json!({"kind": "tmux", "socket": "/tmp/tmux-1000/default", "pane": 17})
                }
                "none" => Value::Null,
                sid => panic!("unexpected session {sid}"),
            }
        );
    }
    let id = |sid: &str| {
        observed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sessionId"] == sid)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["attach"], true);
    assert!(info.get("attachCommand").is_none());
    assert!(!info.to_string().contains(COMMAND));
    let mut ws = web.ws("/pty").await;
    for (sid, address) in [
        ("claude", "devbox:claude:deadbeef"),
        ("tmux", "devbox:tmux:17:/tmp/tmux-1000/default"),
    ] {
        send_json(
            &mut ws,
            json!({
                "t": "open", "id": sid, "spawn": true, "attach": id(sid),
                "shell": "not-the-default"
            }),
        )
        .await;
        assert_eq!(next_json(&mut ws).await["t"], "hello");
        assert_eq!(
            spawns(&hub).last().unwrap().as_ref().unwrap(),
            &SpawnPty {
                argv: vec![
                    DEFAULT_SHELL.into(),
                    "-c".into(),
                    format!("{COMMAND} {address}")
                ],
                shell: None,
                cwd: None,
                cwd_from: None,
                env: None,
            }
        );
    }
    // Null and malformed updates are sticky in both the API and the browser feed.
    for attach in [
        Value::Null,
        json!({"kind": "claude", "id": "BAD"}),
        json!({"kind": "claude", "id": "0123abcd"}),
    ] {
        let response = request("POST", "/v1/events")
            .set("Content-Type", "application/json")
            .body(
                json!({
                    "harness": "pi", "attach": attach,
                    "payload": {"session_id": "claude", "kind": "note"}
                })
                .to_string(),
            )
            .send()
            .await;
        assert_eq!(response.status, 204);
        let expected = if attach["id"] == "0123abcd" {
            attach
        } else {
            json!({"kind": "claude", "id": "deadbeef"})
        };
        let current = request("GET", &format!("/v1/observed/{}", id("claude")))
            .send()
            .await
            .json();
        assert_eq!(current["attach"], expected);
        loop {
            let update = next_json(&mut rpc).await;
            assert_eq!(update["t"], "observed_put");
            if update["session"]["id"] == id("claude")
                && update["session"]["counts"] == current["counts"]
            {
                assert_eq!(update["session"]["attach"], expected);
                break;
            }
        }
    }
    let before = hub.requests().len();
    for (attach, cmd, message) in [
        (json!("o_missing"), None, "unknown observed session"),
        (
            json!(id("none")),
            None,
            "observed session has no terminal attachment",
        ),
        (json!(id("ended")), None, "observed session has ended"),
        (
            json!(id("claude")),
            Some(json!("echo unsafe")),
            "attach and cmd are mutually exclusive",
        ),
        (
            json!(id("claude")),
            Some(json!("")),
            "attach and cmd are mutually exclusive",
        ),
        (
            json!(id("claude")),
            Some(Value::Null),
            "attach and cmd are mutually exclusive",
        ),
        (
            json!({"kind": "claude", "id": "deadbeef"}),
            None,
            "bad attach id",
        ),
        (json!(""), None, "bad attach id"),
        (Value::Null, None, "bad attach id"),
    ] {
        let mut frame = json!({
            "t": "open", "id": "refused", "spawn": true, "attach": attach
        });
        if let Some(cmd) = cmd {
            frame["cmd"] = cmd;
        }
        send_json(&mut ws, frame).await;
        assert_eq!(
            next_json(&mut ws).await,
            json!({"t": "error", "error": message})
        );
    }
    assert_eq!(
        hub.requests().len(),
        before,
        "refusals do not detach or spawn"
    );
    // Reconnects ignore attach entirely and never spawn, even malformed or conflicting.
    for spawn in [None, Some(json!(false)), Some(json!("true"))] {
        let mut frame = json!({
            "t": "open", "id": "reconnect", "attach": {"unsafe": true}, "cmd": "ignored"
        });
        if let Some(spawn) = spawn {
            frame["spawn"] = spawn;
        }
        send_json(&mut ws, frame).await;
        assert_eq!(next_json(&mut ws).await["t"], "hello");
        assert_eq!(spawns(&hub).last(), Some(&None));
    }
    ws.close(None).await.unwrap();
    rpc.close(None).await.unwrap();
    assert!(
        !hub.requests()
            .iter()
            .any(|(_, r)| matches!(r, HubRequest::PtyKill { .. }))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_attach_refuses_when_not_configured() {
    let (hub, web) = up().await;
    let mut ws = web.ws("/pty").await;
    send_json(
        &mut ws,
        json!({
            "t": "open", "id": "noattach", "spawn": true, "attach": "o_missing"
        }),
    )
    .await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({
            "t": "error", "error": "terminal attachment is not configured"
        })
    );
    assert!(spawns(&hub).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_in_out_exit_are_relayed() {
    let (hub, web) = up().await;
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("a1")).await;
    let hello = next_json(&mut ws).await;
    assert_eq!(
        hello,
        json!({"t": "hello", "new": true, "resumed": false, "stream": 1, "out": 0,
               "epoch": EPOCH, "cwd": "/home/alice"})
    );
    let (conn, req) = hub.wait_for(is_open).await;
    assert_ne!(conn, 0, "the card has a hub connection of its own");
    // An absent `spawn` attaches only (SEC-2).
    let want = HubRequest::PtyOpen {
        rid: rid_of(&req),
        sid: "a1".into(),
        cols: 100,
        rows: 30,
        spawn: None,
        resume: None,
    };
    assert_eq!(req, want);

    send_json(&mut ws, json!({"t": "in", "d": "echo hi\r"})).await;
    let (_, input) = hub.wait_for(is_input).await;
    assert_eq!(
        input,
        HubRequest::PtyInput {
            sid: "a1".into(),
            d: "echo hi\r".into()
        }
    );

    // Another sid's events on the same connection never reach this card.
    hub.send(
        conn,
        HubMessage::PtyOut {
            sid: "zz".into(),
            d: "nope".into(),
            out: 4,
        },
    );
    hub.send(
        conn,
        HubMessage::PtyOut {
            sid: "a1".into(),
            d: "hi\r\n".into(),
            out: 4,
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "out", "d": "hi\r\n", "out": 4})
    );
    hub.send(
        conn,
        HubMessage::PtyFg {
            sid: "a1".into(),
            comm: "vim".into(),
            cwd: "/home/alice/src".into(),
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "fg", "comm": "vim", "cwd": "/home/alice/src"})
    );

    send_json(&mut ws, json!({"t": "resize", "cols": 120, "rows": 40})).await;
    let (_, resize) = hub
        .wait_for(|r| matches!(r, HubRequest::PtyResize { .. }))
        .await;
    assert_eq!(
        resize,
        HubRequest::PtyResize {
            sid: "a1".into(),
            cols: 120,
            rows: 40
        }
    );

    hub.send(
        conn,
        HubMessage::PtyExit {
            sid: "a1".into(),
            code: Some(0),
            signal: None,
            reason: ExitReason::Exited,
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "exit", "code": 0, "signal": null, "reason": "exited"})
    );

    // forget = (session === undefined)
    send_json(&mut ws, json!({"t": "kill"})).await;
    send_json(&mut ws, json!({"t": "kill", "session": false})).await;
    send_json(&mut ws, json!({"t": "kill", "session": true})).await;
    let kills = hub
        .wait_count(3, |r| matches!(r, HubRequest::PtyKill { .. }))
        .await;
    let forgets: Vec<(String, bool)> = kills
        .into_iter()
        .map(|(_, r)| match r {
            HubRequest::PtyKill { sid, forget, .. } => (sid, forget),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(
        forgets,
        [
            ("a1".into(), true),
            ("a1".into(), false),
            ("a1".into(), false)
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_open_detaches_first_and_maps_the_spawn_fields() {
    let (hub, web) = up().await;
    let (mut ws, conn) = attached(&hub, &web, "a1").await;

    send_json(
        &mut ws,
        json!({
            "t": "open", "id": "b2", "cmd": "htop -d 5", "parent": "a1", "cwd": "/home/alice/src",
            "tmux": "main", "cols": 90, "rows": 20, "spawn": true,
            "env": {"CANVAS_NODE": "b2", "N": 5},
        }),
    )
    .await;
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    let reqs = on_conn(&hub, conn);
    assert_eq!(reqs.len(), 3, "{reqs:?}");
    assert_eq!(
        reqs[1],
        HubRequest::PtyDetach {
            rid: rid_of(&reqs[1]),
            sid: "a1".into()
        }
    );
    assert_eq!(
        reqs[2],
        HubRequest::PtyOpen {
            rid: rid_of(&reqs[2]),
            sid: "b2".into(),
            cols: 90,
            rows: 20,
            spawn: Some(SpawnPty {
                argv: vec![DEFAULT_SHELL.into(), "-c".into(), "htop -d 5".into()],
                shell: None,
                cwd: Some("/home/alice/src".into()),
                cwd_from: Some("a1".into()),
                env: Some(BTreeMap::from([("CANVAS_NODE".into(), "b2".into())])),
            }),
            resume: None,
        }
    );

    // spawn:false ignores cmd/env/cwd/parent; resume passes through.
    send_json(
        &mut ws,
        json!({
            "t": "open", "id": "c3", "cmd": "rm -rf /home/alice", "parent": "a1",
            "cwd": "/", "env": {"X": "1"}, "cols": 80.9, "rows": 24, "spawn": false,
            "resume": {"stream": 3, "out": 42},
        }),
    )
    .await;
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    let reqs = on_conn(&hub, conn);
    assert_eq!(reqs.len(), 5, "{reqs:?}");
    assert_eq!(
        reqs[3],
        HubRequest::PtyDetach {
            rid: rid_of(&reqs[3]),
            sid: "b2".into()
        }
    );
    assert_eq!(
        reqs[4],
        HubRequest::PtyOpen {
            rid: rid_of(&reqs[4]),
            sid: "c3".into(),
            cols: 80,
            rows: 24,
            spawn: None,
            resume: Some(Resume { stream: 3, out: 42 }),
        }
    );

    // Late events for the detached sid are dropped.
    hub.send(
        conn,
        HubMessage::PtyOut {
            sid: "b2".into(),
            d: "late".into(),
            out: 9,
        },
    );
    hub.send(
        conn,
        HubMessage::PtyOut {
            sid: "c3".into(),
            d: "now".into(),
            out: 45,
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "out", "d": "now", "out": 45})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_spawns_without_spawn_true() {
    let (hub, web) = up().await;
    let mut ws = web.ws("/pty").await;
    let flags = [
        None,
        Some(json!(false)),
        Some(json!(null)),
        Some(json!("true")),
        Some(json!(1)),
    ];
    for (i, flag) in flags.iter().enumerate() {
        let mut msg = open(&format!("n{i}"));
        msg["cmd"] = "make".into();
        msg["shell"] = "zsh".into();
        if let Some(flag) = flag {
            msg["spawn"] = flag.clone();
        }
        send_json(&mut ws, msg).await;
        assert_eq!(next_json(&mut ws).await["t"], "hello");
    }
    assert_eq!(spawns(&hub), vec![None; flags.len()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_spawn_passes_the_shell_through() {
    // argv[0] names the shell; without one from the browser it is the hello's default.
    let hub = FakeHub::start_with(Hello {
        shells: vec!["fish".into(), "zsh".into()],
        default_shell: "fish".into(),
        ..Hello::default()
    });
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;
    let mut ws = web.ws("/pty").await;
    let opens = [
        json!({"shell": "zsh"}),
        json!({"shell": "zsh", "cmd": "make"}),
        json!({}),
        json!({"shell": "", "cmd": "make"}),
        // The hub validates the name and answers bad_request for an unknown one.
        json!({"shell": "/bin/sh"}),
    ];
    for (i, fields) in opens.iter().enumerate() {
        let mut msg = open(&format!("s{i}"));
        msg["spawn"] = true.into();
        for (k, v) in fields.as_object().unwrap() {
            msg[k] = v.clone();
        }
        send_json(&mut ws, msg).await;
        assert_eq!(next_json(&mut ws).await["t"], "hello");
    }
    let spawn = |argv: &[&str], shell: Option<&str>, id: &str| {
        Some(SpawnPty {
            argv: argv.iter().map(|a| a.to_string()).collect(),
            shell: shell.map(str::to_owned),
            cwd: None,
            cwd_from: None,
            env: Some(BTreeMap::from([("CANVAS_NODE".into(), id.into())])),
        })
    };
    assert_eq!(
        spawns(&hub),
        [
            spawn(&["zsh"], Some("zsh"), "s0"),
            spawn(&["zsh", "-c", "make"], Some("zsh"), "s1"),
            spawn(&["fish"], None, "s2"),
            spawn(&["fish", "-c", "make"], None, "s3"),
            spawn(&["/bin/sh"], Some("/bin/sh"), "s4"),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resume_passes_through() {
    let (hub, web) = up().await;
    let mut ws = web.ws("/pty").await;
    let mut msg = open("r1");
    msg["resume"] = json!({"stream": 7, "out": 1234});
    send_json(&mut ws, msg).await;
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    // A malformed resume is dropped, not guessed at.
    let mut msg = open("r2");
    msg["resume"] = json!({"stream": "7"});
    send_json(&mut ws, msg).await;
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    let resumes: Vec<(String, Option<Resume>, bool)> = hub
        .requests()
        .into_iter()
        .filter_map(|(_, r)| match r {
            HubRequest::PtyOpen {
                sid, resume, spawn, ..
            } => Some((sid, resume, spawn.is_some())),
            _ => None,
        })
        .collect();
    assert_eq!(
        resumes,
        [
            (
                "r1".into(),
                Some(Resume {
                    stream: 7,
                    out: 1234
                }),
                false
            ),
            ("r2".into(), None, false),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_repeated_open_before_the_first_reply_stays_attached() {
    let (hub, web) = up().await;
    // The first reply comes late, so the second open (a double Enter on a dead card)
    // goes out before it.
    hub.reply_next_open(OpenReply::Late(Duration::from_millis(300), spawned()));
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("x1")).await;
    send_json(&mut ws, open("x1")).await;
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    // Input follows whatever the relay sent on the two replies.
    send_json(&mut ws, json!({"t": "in", "d": "probe"})).await;
    let (conn, _) = hub.wait_for(is_input).await;
    let reqs = on_conn(&hub, conn);
    assert_eq!(reqs.iter().filter(|r| is_open(r)).count(), 2, "{reqs:?}");
    assert!(
        !reqs
            .iter()
            .any(|r| matches!(r, HubRequest::PtyDetach { .. })),
        "the relay detached the sid it had just re-opened: {reqs:?}"
    );
    hub.send(
        conn,
        HubMessage::PtyOut {
            sid: "x1".into(),
            d: "live".into(),
            out: 4,
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "out", "d": "live", "out": 4})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attach_to_a_dead_session_sends_replay_then_exit() {
    let (hub, web) = up().await;
    hub.reply_next_open(OpenReply::Ok(PtyOpenReply {
        new: false,
        pid: None,
        exit: Some(Exit {
            code: None,
            signal: Some(9),
            reason: ExitReason::Killed,
            at: EPOCH + 5,
        }),
        stream: 2,
        out: 4,
        resumed: true,
        replay: Some("MARK".into()),
        ..spawned()
    }));
    let mut ws = web.ws("/pty").await;
    let mut msg = open("d4");
    msg["spawn"] = false.into();
    send_json(&mut ws, msg).await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "hello", "new": false, "resumed": true, "stream": 2, "out": 4,
               "epoch": EPOCH, "cwd": "/home/alice", "replay": "MARK"})
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "exit", "code": null, "signal": 9, "reason": "killed"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_open_sends_error_then_closes_1000() {
    let (hub, web) = up().await;
    hub.reply_next_open(OpenReply::Err(ErrorCode::NotFound, "no session e5"));
    let mut ws = web.ws("/pty").await;
    let mut msg = open("e5");
    msg["spawn"] = false.into();
    send_json(&mut ws, msg).await;
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    assert_eq!(
        texts,
        [json!({"t": "error", "error": "no session e5", "code": "not_found"})]
    );

    // A refused spawn ends the same way.
    hub.reply_next_open(OpenReply::Err(
        ErrorCode::BadRequest,
        "shell nu not available",
    ));
    let mut ws = web.ws("/pty").await;
    let mut msg = open("e6");
    msg["spawn"] = true.into();
    msg["shell"] = "nu".into();
    send_json(&mut ws, msg).await;
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    assert_eq!(
        texts,
        [json!({"t": "error", "error": "shell nu not available", "code": "bad_request"})]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reloaded_session_closes_1011_so_the_card_reopens() {
    let (hub, web) = up().await;
    let (mut ws, conn) = attached(&hub, &web, "l12").await;
    // Another sid's async error is not this card's.
    hub.send(
        conn,
        HubMessage::Err {
            rid: None,
            sid: Some("zz".into()),
            code: ErrorCode::Internal,
            message: "session reloaded".into(),
        },
    );
    hub.send(
        conn,
        HubMessage::Err {
            rid: None,
            sid: Some("l12".into()),
            code: ErrorCode::Internal,
            message: "session reloaded".into(),
        },
    );
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1011);
    assert!(texts.is_empty(), "{texts:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gone_is_final() {
    let (hub, web) = up().await;
    let (mut ws, conn) = attached(&hub, &web, "f6").await;
    hub.send(
        conn,
        HubMessage::Gone {
            sid: "f6".into(),
            epoch: EPOCH,
        },
    );
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    assert_eq!(texts, [json!({"t": "gone", "epoch": EPOCH})]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn input_overflow_is_a_local_notice() {
    let (hub, web) = up().await;
    let (mut ws, conn) = attached(&hub, &web, "g7").await;
    hub.send(
        conn,
        HubMessage::Err {
            rid: None,
            sid: Some("g7".into()),
            code: ErrorCode::InputOverflow,
            message: "input queue full".into(),
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "out", "d": "\r\n[workbench: paste dropped, input queue full]\r\n"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_down_closes_1013() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let mut ws = web.ws("/pty").await;
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1013);
    assert!(texts.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_incompatible_hub_closes_1013() {
    let hub = FakeHub::start_with_proto(2);
    let web = Web::start(&hub.path);
    let status = web.wait_hub("incompatible").await;
    assert_eq!(status, json!({"t": "hub", "status": "incompatible"}));
    let mut ws = web.ws("/pty").await;
    assert_eq!(read_to_close(&mut ws).await.0, 1013);
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["hub"]["status"], "incompatible");
    assert_eq!(info["hub"]["proto"], 2);
    assert!(!hub.requests().iter().any(|(_, r)| is_open(r)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn losing_the_hub_closes_1011() {
    let (hub, web) = up().await;
    let (mut ws, conn) = attached(&hub, &web, "h8").await;
    hub.close(conn);
    assert_eq!(read_to_close(&mut ws).await.0, 1011);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bad_id_closes_1008() {
    let (hub, web) = up().await;
    let mut ws = web.ws("/pty").await;
    send_json(&mut ws, open("!!/..")).await;
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1008);
    assert_eq!(texts, [json!({"t": "error", "error": "bad id"})]);
    assert!(!hub.requests().iter().any(|(_, r)| is_open(r)));
}

/// `"€"` is 3 bytes; this many fill a 2 MiB `in` message exactly.
const EUROS: usize = (WS_MAX_PTY - r#"{"t":"in","d":""}"#.len()) / 3;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_two_mib_input_is_split_at_char_boundaries() {
    let (hub, web) = up().await;
    let (mut ws, _) = attached(&hub, &web, "i9").await;
    let d = "€".repeat(EUROS);
    let msg = json!({"t": "in", "d": d}).to_string();
    assert_eq!(msg.len(), WS_MAX_PTY);
    ws.send(Message::Text(msg.into())).await.unwrap();
    let pieces: Vec<String> = hub
        .wait_count(2, is_input)
        .await
        .into_iter()
        .map(|(_, r)| match r {
            HubRequest::PtyInput { d, .. } => d,
            _ => unreachable!(),
        })
        .collect();
    assert!(pieces.iter().all(|p| p.len() <= PTY_INPUT_FRAME));
    assert_eq!(pieces.concat(), d);
    // The socket is still usable.
    send_json(&mut ws, json!({"t": "in", "d": "x"})).await;
    let all = hub.wait_count(3, is_input).await;
    assert_eq!(all.len(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_above_two_mib_closes_1009() {
    let (hub, web) = up().await;
    let (ws, _) = attached(&hub, &web, "j10").await;
    let msg = json!({"t": "in", "d": format!("{}x", "€".repeat(EUROS))}).to_string();
    assert_eq!(msg.len(), WS_MAX_PTY + 1);
    let (mut tx, mut rx) = ws.split();
    // The web stops reading at the header, so the write may never finish.
    let writer = tokio::spawn(async move {
        let _ = tx.send(Message::Text(msg.into())).await;
    });
    let (code, _) = read_to_close(&mut rx).await;
    assert_eq!(code, 1009);
    writer.abort();
    assert!(!hub.requests().iter().any(|(_, r)| is_input(r)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_closes_1012_and_exits() {
    let (hub, mut web) = up().await;
    let (mut ws, _) = attached(&hub, &web, "k11").await;
    let started = Instant::now();
    web.sigterm();
    assert_eq!(read_to_close(&mut ws).await.0, 1012);
    assert!(web.wait_exit().await.success());
    assert!(started.elapsed() < Duration::from_secs(6));
}
