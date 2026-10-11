//! `/pty` against a fake hub (design §3.5.1, §3.5.4).

mod common;

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use common::{FakeHub, OpenReply, SHELL, Web, Ws, next_json, read_to_close, send_json, spawned};
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

/// An open as the unchanged prototype frontend sends it: no `spawn`.
fn open(id: &str) -> Value {
    json!({
        "t": "open", "id": id, "cmd": "", "parent": "", "cwd": "", "tmux": "",
        "cols": 100, "rows": 30, "env": {"CANVAS_NODE": id},
    })
}

fn is_open(r: &HubRequest) -> bool {
    matches!(r, HubRequest::PtyOpen { .. })
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
    // M0: an absent `spawn` spawns.
    let want = HubRequest::PtyOpen {
        rid: rid_of(&req),
        sid: "a1".into(),
        cols: 100,
        rows: 30,
        spawn: Some(SpawnPty {
            argv: vec![SHELL.into()],
            cwd: None,
            cwd_from: None,
            env: Some(BTreeMap::from([("CANVAS_NODE".into(), "a1".into())])),
        }),
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
                argv: vec![SHELL.into(), "-c".into(), "htop -d 5".into()],
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
async fn a_failed_open_sends_error_and_keeps_the_socket() {
    let (hub, web) = up().await;
    hub.reply_next_open(OpenReply::Err(ErrorCode::NotFound, "no session e5"));
    let mut ws = web.ws("/pty").await;
    let mut msg = open("e5");
    msg["spawn"] = false.into();
    send_json(&mut ws, msg).await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "error": "no session e5", "code": "not_found"})
    );
    // Enter on the card re-sends open on the same socket.
    send_json(&mut ws, open("e5")).await;
    assert_eq!(next_json(&mut ws).await["t"], "hello");
    assert_eq!(hub.wait_count(2, is_open).await.len(), 2);
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
