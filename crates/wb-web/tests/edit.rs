//! The edwind connection through the real binary (edwind spec §11.3, §12.2, R11.8,
//! R12.8, R15.5, R15.11): notes routes forwarded as `call`s, `sample` streams over
//! `/rpc`, `notes{gen}` on `/rpc`, the `edit` block of `/api/status`, and 503 while
//! edwind is unreachable.

mod common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::{FakeEdit, FakeHub, Web, Ws, edit_status, next_json, read_to_close, send_json};
use serde_json::{Value, json};

const NOT_RUNNING: &str = "workbench-edit is not running";

/// A web with the hub up and `editSocket` set to `edit`.
fn web_with_edit(hub: &FakeHub, edit: &Path) -> Web {
    let edit = edit.to_path_buf();
    Web::start_with(&hub.path, move |cfg| {
        cfg["editSocket"] = json!(edit);
    })
}

/// Polls `/api/status` until `edit.up` is `up`.
async fn wait_edit(web: &Web, up: bool) -> Value {
    let started = Instant::now();
    loop {
        let status = web.req("GET", "/api/status").send().await.json();
        if status["edit"].is_null() != up {
            return status["edit"].clone();
        }
        assert!(
            started.elapsed() < common::WAIT,
            "edwind never became up={up}:\n{}",
            web.log()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Opens `/rpc` and reads past the connect snapshot.
async fn rpc(web: &Web) -> Ws {
    let mut ws = web.ws("/rpc").await;
    loop {
        let msg = next_json(&mut ws).await;
        if msg["t"] == "sessions" {
            return ws;
        }
    }
}

async fn post(web: &Web, path: &str, body: Value) -> (u16, Value) {
    let res = web
        .req("POST", path)
        .body(body.to_string())
        .set("Content-Type", "application/json")
        .send()
        .await;
    (res.status, res.json())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn notes_routes_forward_as_calls_and_answer_with_the_value() {
    let hub = FakeHub::start();
    let edit = FakeEdit::start();
    let web = web_with_edit(&hub, &edit.path);
    wait_edit(&web, true).await;

    // The hello: kind web, device web:<host>, a 128-bit cid, proto 1.
    let hellos = edit.hellos();
    assert_eq!(hellos.len(), 1, "{hellos:?}");
    let hello = &hellos[0];
    assert_eq!(hello["proto"], 1);
    assert_eq!(hello["kind"], "web");
    assert_eq!(hello["device"], "web:testhost");
    assert_eq!(hello["caps"], json!({}));
    let cid = hello["cid"].as_str().unwrap();
    assert_eq!(cid.len(), 32);
    assert!(cid.bytes().all(|b| b.is_ascii_hexdigit()));

    // (method, path, body, cmd, args, value)
    let rows = [
        (
            "GET",
            "/api/nodes?limit=5",
            Value::Null,
            "notes-nodes",
            json!([{"limit": 5}]),
            json!({"root": "/n", "nodes": [{"id": "a.md", "kind": "file", "title": "A"}]}),
        ),
        (
            "GET",
            "/api/nodes",
            Value::Null,
            "notes-nodes",
            json!([{"limit": null}]),
            json!({"root": "/n", "nodes": []}),
        ),
        (
            "GET",
            "/api/links",
            Value::Null,
            "notes-links",
            json!([]),
            json!({"files": {"a.md": {"title": "A", "path": "a.md"}}, "links": [], "backlinks": {}}),
        ),
        (
            "GET",
            "/api/cards",
            Value::Null,
            "notes-cards",
            json!([]),
            json!({"root": "/n", "exists": true, "cards": [{"id": "c1"}]}),
        ),
        (
            "GET",
            "/api/reviews",
            Value::Null,
            "notes-reviews",
            json!([]),
            json!({"dir": "/n/.reviews", "reviews": ["{\"id\":\"c1\"}"]}),
        ),
        (
            "POST",
            "/api/reviews",
            json!({"reviews": [{"id": "c1", "grade": 3}]}),
            "notes-reviews-append",
            json!([{"reviews": [{"id": "c1", "grade": 3}]}]),
            json!({"dir": "/n/.reviews", "appended": 1}),
        ),
        (
            "GET",
            "/api/tasks",
            Value::Null,
            "notes-tasks",
            json!([]),
            json!({"tasks": [{"id": "t1", "kw": "TODO"}]}),
        ),
        (
            "GET",
            "/api/task/t1",
            Value::Null,
            "notes-task",
            json!([{"id": "t1"}]),
            json!({"id": "t1", "kw": "TODO", "title": "x"}),
        ),
        (
            "POST",
            "/api/task/t1",
            json!({"kw": "DONE", "set": {"session": "s9"}}),
            "notes-task-set",
            json!([{"id": "t1", "kw": "DONE", "set": {"session": "s9"}, "by": {"kind": "frame"}}]),
            json!({"id": "t1", "kw": "DONE", "title": "x"}),
        ),
        (
            "POST",
            "/api/task/t2",
            json!({"kw": "TODO"}),
            "notes-task-set",
            json!([{"id": "t2", "kw": "TODO", "set": null, "by": {"kind": "frame"}}]),
            json!({"id": "t2", "kw": "TODO"}),
        ),
        (
            "POST",
            "/api/journal",
            json!({"day": "2026-10-14"}),
            "notes-journal",
            json!([{"day": "2026-10-14"}]),
            json!({"path": "journal/2026-10-14.md", "created": true}),
        ),
        (
            "POST",
            "/api/notes/append",
            json!({"path": "inbox/cards.md", "text": "- q :: a\n", "by": {"kind": "frame", "cid": "c"}}),
            "notes-append",
            json!([{"path": "inbox/cards.md", "text": "- q :: a\n", "by": {"kind": "frame", "cid": "c"}}]),
            json!({"path": "inbox/cards.md"}),
        ),
        (
            "POST",
            "/api/notes/append",
            json!({"path": "inbox/cards.md", "text": "x"}),
            "notes-append",
            json!([{"path": "inbox/cards.md", "text": "x", "by": {"kind": "web"}}]),
            json!({"path": "inbox/cards.md"}),
        ),
    ];
    for (method, path, body, cmd, args, value) in rows {
        edit.answer(cmd, json!({"value": value}));
        let before = edit
            .requests()
            .iter()
            .filter(|(_, m)| m["cmd"] == cmd)
            .count();
        let (status, got) = match method {
            "GET" => {
                let res = web.req("GET", path).send().await;
                (res.status, res.json())
            }
            _ => post(&web, path, body).await,
        };
        assert_eq!(status, 200, "{method} {path}: {got}");
        assert_eq!(got, value, "{method} {path}");
        let calls = edit
            .wait_count(before + 1, |m| m["t"] == "call" && m["cmd"] == cmd)
            .await;
        let call = &calls.last().unwrap().1;
        assert_eq!(call["args"], args, "{method} {path}");
        assert_eq!(call["ctx"], json!({}), "{method} {path}");
        assert!(call["rid"].is_string(), "{method} {path}: {call}");
        assert!(call.get("buf").is_none(), "{method} {path}: {call}");
    }
    // Creating tasks is gone, with or without edwind.
    let (status, body) = post(&web, "/api/tasks", json!({"title": "x"})).await;
    assert_eq!((status, body), (404, json!({"error": "not found"})));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edwind_refusals_and_conditions_map_to_http_statuses() {
    let hub = FakeHub::start();
    let edit = FakeEdit::start();
    let web = web_with_edit(&hub, &edit.path);
    wait_edit(&web, true).await;

    // A protocol error and a condition carry the same code set.
    let cases = [
        (
            json!({"t": "error", "code": "bad_request", "msg": "limit must be a number"}),
            400,
            "limit must be a number",
        ),
        (
            json!({"error": {"condition": "bad_request", "report": "day is required", "restarts": []}}),
            400,
            "day is required",
        ),
        (
            json!({"t": "error", "code": "no_buffer", "msg": "no task t9"}),
            404,
            "no task t9",
        ),
        (
            json!({"error": {"condition": "no_buffer", "report": "missing.md: ENOENT", "restarts": []}}),
            404,
            "missing.md: ENOENT",
        ),
        (
            json!({"t": "error", "code": "refused_path", "msg": "../x: refused"}),
            403,
            "../x: refused",
        ),
        (
            json!({"error": {"condition": "refused_path", "report": "/etc/passwd: refused", "restarts": []}}),
            403,
            "/etc/passwd: refused",
        ),
        (
            json!({"error": {"condition": "error", "report": "vector-ref: index out of range", "restarts": ["abort"]}}),
            502,
            "vector-ref: index out of range",
        ),
        (
            json!({"t": "error", "code": "read_only", "msg": "the buffer is read-only"}),
            502,
            "the buffer is read-only",
        ),
    ];
    for (reply, status, message) in cases {
        edit.answer("notes-nodes", reply.clone());
        let res = web.req("GET", "/api/nodes").send().await;
        assert_eq!(res.status, status, "{reply}");
        assert_eq!(res.json(), json!({"error": message}), "{reply}");
        assert_eq!(res.header("cache-control"), Some("no-store"));
    }

    // Bodies the web itself refuses, before any call.
    let bad = [
        ("/api/journal", json!({})),
        ("/api/journal", json!({"day": 3})),
        ("/api/journal", json!([])),
        ("/api/notes/append", json!({"path": "a.md"})),
        ("/api/task/t1", json!({"set": {}})),
        ("/api/reviews", json!({})),
    ];
    for (path, body) in bad {
        let (status, got) = post(&web, path, body.clone()).await;
        assert_eq!(status, 400, "{path} {body}: {got}");
    }
    let res = web
        .req("POST", "/api/journal")
        .body("not json")
        .send()
        .await;
    assert_eq!(res.status, 400);
    assert!(
        edit.requests()
            .iter()
            .all(|(_, m)| m["cmd"] != "notes-journal" && m["cmd"] != "notes-append"),
        "{:?}",
        edit.requests()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn everything_is_503_until_edwind_listens_and_again_after_it_stops() {
    let hub = FakeHub::start();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("edit.sock");
    let web = web_with_edit(&hub, &path);
    web.wait_hub("up").await;

    for (method, path, body) in [
        ("GET", "/api/nodes", Value::Null),
        ("GET", "/api/links", Value::Null),
        ("GET", "/api/cards", Value::Null),
        ("GET", "/api/reviews", Value::Null),
        ("GET", "/api/tasks", Value::Null),
        ("GET", "/api/task/t1", Value::Null),
        ("POST", "/api/reviews", json!({"reviews": []})),
        ("POST", "/api/task/t1", json!({"kw": "DONE"})),
        ("POST", "/api/journal", json!({"day": "2026-10-14"})),
        (
            "POST",
            "/api/notes/append",
            json!({"path": "a.md", "text": "x"}),
        ),
    ] {
        let (status, got) = match method {
            "GET" => {
                let res = web.req("GET", path).send().await;
                (res.status, res.json())
            }
            _ => post(&web, path, body).await,
        };
        assert_eq!(
            (status, got),
            (503, json!({"error": NOT_RUNNING})),
            "{method} {path}"
        );
    }
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["sample"], false);
    assert_eq!(info["notesExists"], false);
    assert_eq!(info["models"], json!({}));
    assert_eq!(
        web.req("GET", "/api/status").send().await.json()["edit"],
        Value::Null
    );

    // On /rpc: limits answer null and a sample is refused as disabled.
    let mut ws = rpc(&web).await;
    send_json(&mut ws, json!({"t": "limits", "id": "l1"})).await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "ok", "id": "l1", "value": null})
    );
    send_json(&mut ws, json!({"t": "sample", "id": "s1", "input": "hi"})).await;
    let err = next_json(&mut ws).await;
    assert_eq!(err["t"], "error");
    assert_eq!(err["id"], "s1");
    assert_eq!(err["code"], "sampling_disabled");
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("no language model")
    );

    // edwind appears: the web reconnects by itself.
    let edit = FakeEdit::start_at(dir, path);
    let block = wait_edit(&web, true).await;
    assert_eq!(
        block,
        json!({"up": true, "version": "0.1.0", "build": "0.1.0", "clients": 1, "buffers": 2,
               "journalBytes": 4096, "imageGen": 3, "loopLagP95Ms": 1.5, "ackP95Ms": 0.5})
    );
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["sample"], true);
    assert_eq!(info["notesExists"], true);
    assert_eq!(
        info["models"],
        json!({"default": "tier-default", "quick": "tier-quick"})
    );
    edit.answer("notes-tasks", json!({"value": {"tasks": []}}));
    assert_eq!(web.req("GET", "/api/tasks").send().await.status, 200);

    // edwind goes away: down at once, no stale cache.
    edit.stop();
    wait_edit(&web, false).await;
    let res = web.req("GET", "/api/tasks").send().await;
    assert_eq!(
        (res.status, res.json()),
        (503, json!({"error": NOT_RUNNING}))
    );
    assert_eq!(
        web.req("GET", "/api/info").send().await.json()["notesExists"],
        false
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_edit_socket_the_stubs_stay_and_writes_are_503() {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;
    let notes = web.dir.path().join("notes");
    let res = web.req("GET", "/api/nodes").send().await;
    assert_eq!(res.json(), json!({"root": notes, "nodes": []}));
    let res = web.req("GET", "/api/cards").send().await;
    assert_eq!(
        res.json(),
        json!({"root": notes, "exists": false, "cards": []})
    );
    assert_eq!(web.req("GET", "/api/task/t1").send().await.status, 404);
    for (path, body) in [
        ("/api/journal", json!({"day": "2026-10-14"})),
        ("/api/notes/append", json!({"path": "a.md", "text": "x"})),
        ("/api/reviews", json!({"reviews": []})),
        ("/api/task/t1", json!({"kw": "DONE"})),
    ] {
        let (status, got) = post(&web, path, body).await;
        assert_eq!(
            (status, got),
            (503, json!({"error": NOT_RUNNING})),
            "{path}"
        );
    }
    assert_eq!(
        web.req("GET", "/api/status").send().await.json()["edit"],
        Value::Null
    );
    let mut ws = rpc(&web).await;
    send_json(&mut ws, json!({"t": "sample", "id": "s1", "input": "hi"})).await;
    assert_eq!(next_json(&mut ws).await["code"], "sampling_disabled");
    send_json(&mut ws, json!({"t": "limits", "id": "l1"})).await;
    assert_eq!(next_json(&mut ws).await["value"], Value::Null);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sample_streams_round_trip_through_edwind() {
    let hub = FakeHub::start();
    let edit = FakeEdit::start();
    edit.answer(
        "sample-limits",
        json!({"value": {"maxPromptBytes": 4194304, "images": true, "tools": true}}),
    );
    let web = web_with_edit(&hub, &edit.path);
    wait_edit(&web, true).await;
    let mut ws = rpc(&web).await;

    // limits is a call.
    send_json(&mut ws, json!({"t": "limits", "id": "l1"})).await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "ok", "id": "l1", "value": {"maxPromptBytes": 4194304, "images": true, "tools": true}})
    );
    assert_eq!(edit.wait_call("sample-limits").await, json!([]));

    // sample{id} becomes sample{sid, tab}; every field the browser sent goes along.
    let tools =
        json!([{"name": "read_node", "description": "d", "inputSchema": {"type": "object"}}]);
    send_json(
        &mut ws,
        json!({"t": "sample", "id": "s1", "input": "hello", "modelTier": "quick", "model": "",
               "effort": "low", "images": [], "tools": tools}),
    )
    .await;
    let (conn, fwd) = edit.wait_for(|m| m["t"] == "sample").await;
    assert_eq!(conn, 0);
    let sid = fwd["sid"].as_str().unwrap().to_owned();
    let tab = fwd["tab"].as_str().unwrap().to_owned();
    assert!(!sid.is_empty() && !tab.is_empty() && sid != tab, "{fwd}");
    assert_eq!(
        fwd,
        json!({"t": "sample", "sid": sid, "tab": tab, "input": "hello", "modelTier": "quick",
               "model": "", "effort": "low", "images": [], "tools": tools})
    );

    // The stream comes back under the tab's id.
    edit.send(0, json!({"t": "sample.text", "sid": sid, "text": "He"}));
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "text", "id": "s1", "text": "He"})
    );
    edit.send(
        0,
        json!({"t": "sample.tool", "sid": sid, "callId": "c1", "name": "read_node", "input": {"id": "x"}}),
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "tool", "id": "s1", "callId": "c1", "name": "read_node", "input": {"id": "x"}})
    );
    send_json(
        &mut ws,
        json!({"t": "tool_result", "id": "s1", "callId": "c1", "result": "the node"}),
    )
    .await;
    assert_eq!(
        edit.wait_for(|m| m["t"] == "tool_result").await.1,
        json!({"t": "tool_result", "sid": sid, "callId": "c1", "result": "the node"})
    );
    edit.send(
        0,
        json!({"t": "sample.tool", "sid": sid, "callId": "c2", "name": "write_page", "input": {}}),
    );
    assert_eq!(next_json(&mut ws).await["callId"], "c2");
    send_json(
        &mut ws,
        json!({"t": "tool_error", "id": "s1", "callId": "c2", "message": "denied"}),
    )
    .await;
    assert_eq!(
        edit.wait_for(|m| m["t"] == "tool_error").await.1,
        json!({"t": "tool_error", "sid": sid, "callId": "c2", "message": "denied"})
    );
    edit.send(
        0,
        json!({"t": "sample.done", "sid": sid, "text": "Hello", "truncated": false,
               "modelTierApplied": "quick", "modelApplied": "tier-quick"}),
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "done", "id": "s1", "text": "Hello", "truncated": false,
               "modelTierApplied": "quick", "modelApplied": "tier-quick"})
    );
    // After done the stream is forgotten: a late message is dropped, a late
    // tool_result is not forwarded.
    edit.send(0, json!({"t": "sample.text", "sid": sid, "text": "late"}));
    send_json(
        &mut ws,
        json!({"t": "tool_result", "id": "s1", "callId": "c3", "result": "late"}),
    )
    .await;

    // A second stream: the browser cancels it, and the error ends it.
    send_json(
        &mut ws,
        json!({"t": "sample", "id": "s2", "input": "again"}),
    )
    .await;
    let (_, second) = edit.wait_count(2, |m| m["t"] == "sample").await.remove(1);
    let sid2 = second["sid"].as_str().unwrap().to_owned();
    assert_ne!(sid2, sid);
    assert_eq!(second["tab"], tab);
    send_json(&mut ws, json!({"t": "cancel", "id": "s2"})).await;
    assert_eq!(
        edit.wait_for(|m| m["t"] == "cancel").await.1,
        json!({"t": "cancel", "sid": sid2})
    );
    edit.send(
        0,
        json!({"t": "sample.error", "sid": sid2, "code": "cancelled", "message": "cancelled", "text": "ag"}),
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "id": "s2", "code": "cancelled", "message": "cancelled", "text": "ag"})
    );

    // Streams still open when the tab goes are cancelled (R12.8); a second tab has its
    // own tab id.
    send_json(&mut ws, json!({"t": "sample", "id": "s3", "input": "x"})).await;
    let (_, third) = edit.wait_count(3, |m| m["t"] == "sample").await.remove(2);
    let sid3 = third["sid"].as_str().unwrap().to_owned();
    let mut other = rpc(&web).await;
    send_json(&mut other, json!({"t": "sample", "id": "s1", "input": "y"})).await;
    let (_, fourth) = edit.wait_count(4, |m| m["t"] == "sample").await.remove(3);
    assert_ne!(fourth["tab"], tab);
    let sid4 = fourth["sid"].as_str().unwrap().to_owned();
    drop(ws);
    let cancels = edit.wait_count(2, |m| m["t"] == "cancel").await;
    assert_eq!(cancels[1].1, json!({"t": "cancel", "sid": sid3}));
    // The other tab's stream is untouched and still routed.
    edit.send(0, json!({"t": "sample.text", "sid": sid4, "text": "y!"}));
    assert_eq!(
        next_json(&mut other).await,
        json!({"t": "text", "id": "s1", "text": "y!"})
    );
    // No forwarding of the late tool_result from the ended stream.
    let results: Vec<_> = edit
        .requests()
        .into_iter()
        .filter(|(_, m)| m["t"] == "tool_result")
        .collect();
    assert_eq!(results.len(), 1, "{results:?}");

    // The edwind connection ends: open streams get an error, and the tab learns of it.
    edit.close(0);
    assert_eq!(
        next_json(&mut other).await,
        json!({"t": "error", "id": "s1", "code": "unavailable", "message": NOT_RUNNING})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sample_is_disabled_when_edwind_serves_no_model() {
    let hub = FakeHub::start();
    let edit = FakeEdit::start();
    let mut status = edit_status();
    status["sample"] = json!(false);
    status["models"] = json!({});
    edit.answer("status", json!({"value": status}));
    let web = web_with_edit(&hub, &edit.path);
    wait_edit(&web, true).await;
    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["sample"], false);
    assert_eq!(info["models"], json!({}));
    assert_eq!(info["notesExists"], true);
    let mut ws = rpc(&web).await;
    send_json(&mut ws, json!({"t": "sample", "id": "s1", "input": "hi"})).await;
    assert_eq!(next_json(&mut ws).await["code"], "sampling_disabled");
    send_json(&mut ws, json!({"t": "limits", "id": "l1"})).await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "ok", "id": "l1", "value": null})
    );
    assert!(edit.requests().iter().all(|(_, m)| m["t"] != "sample"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn notes_gen_reaches_every_rpc_client() {
    let hub = FakeHub::start();
    let edit = FakeEdit::start();
    let web = web_with_edit(&hub, &edit.path);
    wait_edit(&web, true).await;
    let mut a = rpc(&web).await;
    let mut b = rpc(&web).await;
    edit.send(0, json!({"t": "notes", "gen": 8}));
    assert_eq!(next_json(&mut a).await, json!({"t": "notes", "gen": 8}));
    assert_eq!(next_json(&mut b).await, json!({"t": "notes", "gen": 8}));
    // Unknown message types from edwind are ignored (R7.4), and a ping is answered.
    edit.send(0, json!({"t": "var", "name": "x", "value": 1}));
    edit.send(0, json!({"t": "ping", "rid": "p1"}));
    assert_eq!(
        edit.wait_for(|m| m["t"] == "pong").await.1,
        json!({"t": "pong", "rid": "p1"})
    );
    edit.send(0, json!({"t": "notes", "gen": 9}));
    assert_eq!(next_json(&mut a).await, json!({"t": "notes", "gen": 9}));
    drop(b);
    web.sigterm();
    let (code, _) = read_to_close(&mut a).await;
    assert_eq!(code, 1012);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_config_with_the_old_sample_key_refuses_to_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = common::fixture(dir.path(), &dir.path().join("hub.sock"));
    cfg["sample"] = json!({"apiKeyFile": "/k", "baseUrl": "https://api.example.org"});
    let path = dir.path().join("web.json");
    std::fs::write(&path, cfg.to_string()).unwrap();
    let (status, stderr) = common::run_to_exit(&["--config", path.to_str().unwrap()]);
    assert!(!status.success());
    assert!(stderr.contains("unknown field `sample`"), "{stderr}");

    let dir = tempfile::tempdir().unwrap();
    let mut cfg = common::fixture(dir.path(), &dir.path().join("hub.sock"));
    cfg["editSocket"] = json!("relative/edit.sock");
    let path = dir.path().join("web.json");
    std::fs::write(&path, cfg.to_string()).unwrap();
    let (status, stderr) = common::run_to_exit(&["--config", path.to_str().unwrap()]);
    assert!(!status.success());
    assert!(stderr.contains("editSocket"), "{stderr}");
}
