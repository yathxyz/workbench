//! `/edit` through the real binary (edwind spec R9.16, R9.17, R9.20): a verbatim relay
//! to `edit.sock`, its close codes, the auth floor, and the `edit`/`editUp` fields of
//! `/api/info`.

mod common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::{FakeEdit, ORIGIN, Req, Web, next_json, read_to_close, send_json};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use wb_proto::limits::MAX_LINE;

const SECRET_HEADER: &str = "X-Workbench-Proxy-Secret";

/// A web with `editSocket` set to `edit`; the hub is down, which `/edit` never minds.
fn web_with_edit(edit: &Path, frames: Option<bool>) -> Web {
    let edit = edit.to_path_buf();
    Web::start_with(&edit.with_file_name("hub.sock"), move |cfg| {
        cfg["editSocket"] = json!(edit);
        if let Some(frames) = frames {
            cfg["frames"] = json!(frames);
        }
    })
}

/// What a frame runtime sends first (R9.16); the relay does not read it.
fn hello() -> Value {
    json!({"t": "hello", "proto": 1, "cid": "cid-1", "kind": "frame", "device": "dev-1", "caps": {}})
}

/// Opens `/edit`, sends `hello` and reads the fake edwind's `welcome`.
async fn connected(web: &Web) -> common::Ws {
    let mut ws = web.ws("/edit").await;
    send_json(&mut ws, hello()).await;
    let welcome = next_json(&mut ws).await;
    assert_eq!(welcome["t"], "welcome", "{welcome}");
    assert_eq!(welcome["proto"], 1);
    ws
}

/// Sends `msg` and returns the fake edwind connection that recorded it.
async fn opened(ws: &mut common::Ws, edit: &FakeEdit, buf: &str) -> usize {
    let open = json!({"t": "open", "buf": buf, "rid": format!("r-{buf}")});
    send_json(ws, open.clone()).await;
    let (conn, got) = edit.wait_for(|m| m["t"] == "open" && m["buf"] == buf).await;
    assert_eq!(got, open);
    conn
}

/// A WebSocket handshake as a raw request, for the cases that must never reach 101.
fn upgrade(web: &Web, path: &str) -> Req {
    web.req("GET", path)
        .set("Origin", ORIGIN)
        .add("Upgrade", "websocket")
        .add("Connection", "Upgrade")
        .add("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .add("Sec-WebSocket-Version", "13")
}

/// Polls `/api/info` until `editUp` is `up`; returns the whole body.
async fn wait_edit_up(web: &Web, up: bool) -> Value {
    let started = Instant::now();
    loop {
        let info = web.req("GET", "/api/info").send().await.json();
        if info["editUp"] == up {
            return info;
        }
        assert!(
            started.elapsed() < common::WAIT,
            "editUp never became {up}:\n{}",
            web.log()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn frames_are_lines_both_ways_and_edwind_closing_is_1011() {
    let edit = FakeEdit::start();
    let web = web_with_edit(&edit.path, None);
    let mut ws = connected(&web).await;
    // The hello went through as the browser wrote it, kind and all.
    assert!(
        edit.hellos()
            .iter()
            .any(|h| h["kind"] == "frame" && h["cid"] == "cid-1" && h["device"] == "dev-1"),
        "{:?}",
        edit.hellos()
    );
    let conn = opened(&mut ws, &edit, "notes/a.md").await;

    // Lines from edwind arrive as text frames, one each, in order.
    let snap = json!({"t": "snap", "buf": "notes/a.md", "sver": 3, "text": "hello\nworld"});
    let meta = json!({"t": "meta", "buf": "notes/a.md", "mode": "markdown-mode"});
    edit.send(conn, snap.clone());
    edit.send(conn, meta.clone());
    assert_eq!(next_json(&mut ws).await, snap);
    assert_eq!(next_json(&mut ws).await, meta);

    // Frames reach edwind as they are: a field the web never parses survives.
    let edit_msg = json!({"t": "edit", "buf": "notes/a.md", "seq": 1, "ops": [[0, "x"]], "odd": {"nested": [1, 2]}});
    send_json(&mut ws, edit_msg.clone()).await;
    assert_eq!(edit.wait_for(|m| m["t"] == "edit").await, (conn, edit_msg));

    // A second tab is a second edwind connection of its own.
    let mut other = connected(&web).await;
    let conn2 = opened(&mut other, &edit, "notes/b.md").await;
    assert_ne!(conn, conn2);
    edit.send(conn2, json!({"t": "ack", "buf": "notes/b.md"}));
    assert_eq!(
        next_json(&mut other).await,
        json!({"t": "ack", "buf": "notes/b.md"})
    );

    // edwind closing one socket ends that tab's socket with 1011; the other lives on.
    edit.close(conn);
    assert_eq!(read_to_close(&mut ws).await.0, 1011);
    edit.send(conn2, json!({"t": "pong", "rid": "p"}));
    assert_eq!(
        next_json(&mut other).await,
        json!({"t": "pong", "rid": "p"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_binary_frame_or_an_embedded_newline_closes_1003() {
    let edit = FakeEdit::start();
    let web = web_with_edit(&edit.path, None);

    let mut ws = connected(&web).await;
    ws.send(Message::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(read_to_close(&mut ws).await.0, 1003);

    let mut ws = connected(&web).await;
    let two = "{\"t\":\"open\",\"buf\":\"notes/x.md\"}\n{\"t\":\"open\",\"buf\":\"notes/y.md\"}";
    ws.send(Message::Text(two.into())).await.unwrap();
    assert_eq!(read_to_close(&mut ws).await.0, 1003);
    // Neither line was forwarded.
    assert!(
        edit.requests().iter().all(|(_, m)| m["t"] != "open"),
        "{:?}",
        edit.requests()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frame_or_a_line_over_max_line_closes_1009() {
    let edit = FakeEdit::start();
    let web = web_with_edit(&edit.path, None);

    // Exactly MAX_LINE passes in both directions.
    let mut ws = connected(&web).await;
    let head = r#"{"t":"chunk","buf":"n","text":""}"#;
    let full = json!({"t": "chunk", "buf": "n", "text": "x".repeat(MAX_LINE - head.len())});
    let full_text = full.to_string();
    assert_eq!(full_text.len(), MAX_LINE);
    ws.send(Message::Text(full_text.clone().into()))
        .await
        .unwrap();
    let (conn, got) = edit.wait_for(|m| m["t"] == "chunk").await;
    assert_eq!(got, full);
    edit.send(conn, full.clone());
    assert_eq!(next_json(&mut ws).await, full);

    // One byte more from the browser: 1009 before anything reaches edwind.
    let over = json!({"t": "chunk", "buf": "n", "text": "x".repeat(MAX_LINE + 1 - head.len())})
        .to_string();
    assert_eq!(over.len(), MAX_LINE + 1);
    let (mut tx, mut rx) = ws.split();
    // The web stops reading at the header, so the write may never finish.
    let writer = tokio::spawn(async move {
        let _ = tx.send(Message::Text(over.into())).await;
    });
    assert_eq!(read_to_close(&mut rx).await.0, 1009);
    writer.abort();
    assert_eq!(
        edit.requests()
            .iter()
            .filter(|(_, m)| m["t"] == "chunk")
            .count(),
        1
    );

    // A line over MAX_LINE from edwind closes the browser socket with 1009 too.
    let mut ws = connected(&web).await;
    let conn = opened(&mut ws, &edit, "notes/big.md").await;
    edit.send(
        conn,
        json!({"t": "chunk", "buf": "notes/big.md", "text": "y".repeat(MAX_LINE + 1)}),
    );
    assert_eq!(read_to_close(&mut ws).await.0, 1009);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_edwind_closes_1013_and_info_says_so() {
    // No editSocket at all, whatever an old web.json says about frames.
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start_with(&dir.path().join("hub.sock"), |cfg| {
        cfg["frames"] = json!(true);
    });
    let mut ws = web.ws("/edit").await;
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1013);
    assert!(texts.is_empty());
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["edit"], false);
    assert_eq!(info["editUp"], false);

    // An editSocket nobody listens on.
    let web = web_with_edit(&dir.path().join("edit.sock"), Some(true));
    let mut ws = web.ws("/edit").await;
    assert_eq!(read_to_close(&mut ws).await.0, 1013);
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["edit"], true);
    assert_eq!(info["editUp"], false);

    // Frames are the only page editor (R9.21): an editSocket turns them on, and the
    // frames key an older web.json carries changes nothing.
    let edit = FakeEdit::start();
    let web = web_with_edit(&edit.path, None);
    let info = wait_edit_up(&web, true).await;
    assert_eq!(info["edit"], true);
    assert_eq!(info["editUp"], true);
    let web = web_with_edit(&edit.path, Some(false));
    assert_eq!(wait_edit_up(&web, true).await["edit"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn info_reports_frames_on_and_edwind_up_and_down() {
    let edit = FakeEdit::start();
    let web = web_with_edit(&edit.path, Some(true));
    let info = wait_edit_up(&web, true).await;
    assert_eq!(info["edit"], true);
    // A frame socket works while edwind is up.
    let mut ws = connected(&web).await;
    edit.stop();
    assert_eq!(read_to_close(&mut ws).await.0, 1011);
    let info = wait_edit_up(&web, false).await;
    // edit stays what the config says; only editUp follows edwind.
    assert_eq!(info["edit"], true);
    let mut ws = web.ws("/edit").await;
    assert_eq!(read_to_close(&mut ws).await.0, 1013);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_closes_1012_and_exits() {
    let edit = FakeEdit::start();
    let mut web = web_with_edit(&edit.path, Some(true));
    let mut ws = connected(&web).await;
    let started = Instant::now();
    web.sigterm();
    assert_eq!(read_to_close(&mut ws).await.0, 1012);
    assert!(web.wait_exit().await.success());
    assert!(started.elapsed() < Duration::from_secs(6));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_floor_guards_edit_as_it_guards_pty() {
    let edit = FakeEdit::start();
    let web = web_with_edit(&edit.path, Some(true));
    let wrong = common::SECRET.replace('0', "1");
    let refused = [
        upgrade(&web, "/edit").without("Origin"),
        upgrade(&web, "/edit").without(SECRET_HEADER),
        upgrade(&web, "/edit").set(SECRET_HEADER, &wrong),
        upgrade(&web, "/edit").set("Origin", "http://evil.example.org"),
        upgrade(&web, "/edit").set("Origin", "null"),
        upgrade(&web, "/edit").from("127.0.0.2"),
        upgrade(&web, "/edit?token=")
            .without(SECRET_HEADER)
            .without("Origin"),
    ];
    for req in refused {
        let res = req.send().await;
        assert_eq!(res.status, 403);
        assert_eq!(res.json(), json!({"error": "forbidden"}));
    }
    // The same through a WebSocket client: the handshake fails, no 101.
    match web.ws_with("/edit", &[("origin", None)]).await {
        Err(WsError::Http(res)) => assert_eq!(res.status(), 403),
        other => panic!("expected 403, got {other:?}"),
    }
    // A plain GET is not an upgrade; an upgrade next to the path is 404.
    let res = web.req("GET", "/edit").send().await;
    assert_eq!(res.status, 400);
    assert_eq!(res.json(), json!({"error": "websocket upgrade required"}));
    assert_eq!(upgrade(&web, "/edit/").send().await.status, 404);
    assert_eq!(upgrade(&web, "/editx").send().await.status, 404);
    // Nothing above reached edwind: only wb-web's own hello is there.
    assert!(edit.hellos().iter().all(|h| h["kind"] == "web"));
    // And the correct handshake still works.
    drop(connected(&web).await);
}
