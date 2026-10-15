//! `GET`/`PUT /api/board`: ETags, `If-Match`, atomic writes and the `/rpc` notice
//! (design §3.5.5).

mod common;

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;

use common::{Web, Ws, next_json};
use futures_util::future::join_all;
use serde_json::{Value, json};

const EMPTY: &str = "\"empty\"";

fn is_board_etag(tag: &str, size: usize) -> bool {
    let Some(inner) = tag.strip_prefix('"').and_then(|t| t.strip_suffix('"')) else {
        return false;
    };
    let parts: Vec<&str> = inner.split('-').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts[0] == size.to_string()
}

fn board_file(web: &Web) -> PathBuf {
    web.dir.path().join("boards/testhost.json")
}

/// The next `board` notice on `/rpc`, skipping hub and session traffic.
async fn next_board(rpc: &mut Ws) -> Value {
    loop {
        let msg = next_json(rpc).await;
        if msg["t"] == "board" {
            return msg;
        }
    }
}

/// Opens `/rpc` and reads past its connect snapshot, whose `board` notice names `tag`.
async fn rpc_at(web: &Web, tag: &str) -> Ws {
    let mut rpc = web.ws("/rpc").await;
    assert_eq!(next_board(&mut rpc).await["etag"], tag);
    rpc
}

async fn put(web: &Web, if_match: Option<&str>, body: &[u8]) -> common::Resp {
    let req = web.req("PUT", "/api/board").body(body);
    match if_match {
        Some(tag) => req.add("If-Match", tag),
        None => req,
    }
    .send()
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_put_must_name_the_current_board() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let mut rpc = rpc_at(&web, EMPTY).await;

    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, b"null");
    assert_eq!(res.header("etag"), Some(EMPTY));
    assert_eq!(res.header("cache-control"), Some("no-store"));

    let first = br#"{"nodes":[{"id":"a1"}],"edges":[]}"#;
    let res = put(&web, None, first).await;
    assert_eq!(res.status, 428);
    assert_eq!(res.json(), json!({"error": "If-Match required"}));
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert!(!board_file(&web).exists());

    // "empty" with no file is the first save of a fresh install.
    let res = put(&web, Some(EMPTY), first).await;
    assert_eq!(res.status, 204);
    let tag1 = res.header("etag").unwrap().to_owned();
    assert!(is_board_etag(&tag1, first.len()), "{tag1}");
    assert_eq!(
        next_board(&mut rpc).await,
        json!({"t": "board", "etag": tag1})
    );

    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, first);
    assert_eq!(res.header("etag"), Some(tag1.as_str()));

    // Anything but the exact current tag is refused, and the 412 names the current one.
    let second = br#"{"nodes":[{"id":"b2"}],"edges":[]}"#;
    let weak = format!("W/{tag1}");
    let list = format!("{EMPTY}, {tag1}");
    let unquoted = tag1.trim_matches('"').to_owned();
    for stale in [EMPTY, "\"1-2-3\"", "*", &weak, &list, &unquoted] {
        let res = put(&web, Some(stale), second).await;
        assert_eq!(res.status, 412, "If-Match {stale}");
        assert_eq!(
            res.json(),
            json!({"error": "board changed elsewhere", "etag": tag1}),
            "If-Match {stale}"
        );
        assert_eq!(res.header("cache-control"), Some("no-store"));
    }
    let res = web
        .req("PUT", "/api/board")
        .add("If-Match", &tag1)
        .add("If-Match", &tag1)
        .body(&second[..])
        .send()
        .await;
    assert_eq!(res.status, 412, "two If-Match headers");
    assert_eq!(std::fs::read(board_file(&web)).unwrap(), first);

    // Same size, new content: the tag still changes. The refusals above sent no notice,
    // so the next one is this write's.
    let res = put(&web, Some(&tag1), second).await;
    assert_eq!(res.status, 204);
    let tag2 = res.header("etag").unwrap().to_owned();
    assert_ne!(tag1, tag2);
    assert_eq!(
        next_board(&mut rpc).await,
        json!({"t": "board", "etag": tag2})
    );
    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.body, second);
    assert_eq!(res.header("etag"), Some(tag2.as_str()));

    let file = board_file(&web);
    assert_eq!(std::fs::read(&file).unwrap(), second);
    let mode = std::fs::metadata(&file).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    let leftovers: Vec<_> = std::fs::read_dir(web.dir.path().join("boards"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, ["testhost.json"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn of_ten_concurrent_puts_with_one_tag_exactly_one_wins() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let mut rpc = rpc_at(&web, EMPTY).await;
    let mut tag = EMPTY.to_owned();
    // First from a fresh install ("empty"), then from an existing board.
    for round in 0..2 {
        let bodies: Vec<String> = (0..10)
            .map(|i| format!(r#"{{"round":{round},"writer":{i}}}"#))
            .collect();
        let results = join_all(
            bodies
                .iter()
                .map(|body| put(&web, Some(&tag), body.as_bytes())),
        )
        .await;
        let winners: Vec<usize> = (0..10).filter(|&i| results[i].status == 204).collect();
        assert_eq!(winners.len(), 1, "round {round}: {:?}", statuses(&results));
        let won = winners[0];
        let new_tag = results[won].header("etag").unwrap().to_owned();
        for (i, res) in results.iter().enumerate().filter(|(i, _)| *i != won) {
            assert_eq!(res.status, 412, "round {round} writer {i}");
            // The losers were checked after the winner's write, under the same lock.
            assert_eq!(
                res.json()["etag"],
                new_tag.as_str(),
                "round {round} writer {i}"
            );
        }
        assert_eq!(
            std::fs::read_to_string(board_file(&web)).unwrap(),
            bodies[won]
        );
        assert_eq!(next_board(&mut rpc).await["etag"], new_tag.as_str());
        tag = new_tag;
    }
}

fn statuses(results: &[common::Resp]) -> Vec<u16> {
    results.iter().map(|r| r.status).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_board_replaced_outside_wb_web_is_412_until_fetched_again() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let res = put(&web, Some(EMPTY), b"{\"v\":1}").await;
    assert_eq!(res.status, 204);
    let tag = res.header("etag").unwrap().to_owned();

    // As Syncthing does: a new file renamed over the board.
    let file = board_file(&web);
    let tmp = file.with_file_name(".syncthing.testhost.json.tmp");
    std::fs::write(&tmp, b"{\"v\":\"remote\"}").unwrap();
    std::fs::rename(&tmp, &file).unwrap();
    let res = put(&web, Some(&tag), b"{\"v\":2}").await;
    assert_eq!(res.status, 412);
    let current = web.req("GET", "/api/board").send().await;
    assert_eq!(current.body, b"{\"v\":\"remote\"}");
    let remote_tag = current.header("etag").unwrap().to_owned();
    assert_eq!(res.json()["etag"], remote_tag.as_str());

    // An in-place rewrite keeps the inode but changes size and mtime.
    let ino = std::fs::metadata(&file).unwrap().ino();
    std::fs::write(&file, b"{\"v\":\"edited in place\"}").unwrap();
    assert_eq!(std::fs::metadata(&file).unwrap().ino(), ino);
    let res = put(&web, Some(&remote_tag), b"{\"v\":3}").await;
    assert_eq!(res.status, 412);

    let fresh = web.req("GET", "/api/board").send().await;
    let res = put(&web, fresh.header("etag"), b"{\"v\":4}").await;
    assert_eq!(res.status, 204);
    assert_eq!(std::fs::read(&file).unwrap(), b"{\"v\":4}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bad_board_writes_change_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    for if_match in [None, Some(EMPTY)] {
        let res = put(&web, if_match, b"{\"nodes\":").await;
        assert_eq!(res.status, 400, "If-Match {if_match:?}");
        assert!(
            res.json()["error"]
                .as_str()
                .unwrap()
                .starts_with("invalid JSON"),
        );
    }
    let res = web
        .req("PUT", "/api/board")
        .without("Origin")
        .add("If-Match", EMPTY)
        .body("{}")
        .send()
        .await;
    assert_eq!(res.status, 403);
    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.body, b"null");
    assert!(!web.dir.path().join("boards").exists());
}

// ---------------------------------------------------------------- edwind migration

/// `<boardsDir>/<host>.pre-edwind.json`, the one-time copy of R8.19.
fn backup_file(web: &Web) -> PathBuf {
    web.dir.path().join("boards/testhost.pre-edwind.json")
}

/// A board whose pages have been migrated to edwind buffers (R8.16).
fn migrated() -> Value {
    json!({
        "v": 1,
        "nodes": {
            "p1": {"id": "p1", "kind": "buffer", "buf": "notes/alpha.md", "x": 10, "y": 20},
            "p2": {"id": "p2", "kind": "buffer", "buf": "notes/beta.md", "x": 30, "y": 40},
            "t1": {"id": "t1", "kind": "terminal", "sid": "s1"},
        },
        "edges": [],
    })
}

/// The same board as an app.js that knows no `buf` would save it: `text` and
/// `anchors` on every page, a page of its own added.
fn pre_buf() -> Value {
    json!({
        "v": 1,
        "nodes": {
            "p1": {"id": "p1", "kind": "buffer", "text": "stale alpha", "anchors": [{"id": "a1", "pos": 3}], "x": 11, "y": 20},
            "p2": {"id": "p2", "kind": "buffer", "text": "stale beta", "x": 30, "y": 40},
            "p3": {"id": "p3", "kind": "buffer", "text": "a new page", "anchors": []},
            "t1": {"id": "t1", "kind": "terminal", "sid": "s1"},
        },
        "edges": [],
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pre_buf_put_over_a_migrated_board_keeps_every_buf_and_brings_back_no_text() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let mut rpc = rpc_at(&web, EMPTY).await;

    let res = put(&web, Some(EMPTY), migrated().to_string().as_bytes()).await;
    assert_eq!(res.status, 204);
    let tag1 = res.header("etag").unwrap().to_owned();
    assert_eq!(next_board(&mut rpc).await["etag"], tag1.as_str());
    // A first board that already carries buf has nothing to copy.
    assert!(!backup_file(&web).exists());

    let res = put(&web, Some(&tag1), pre_buf().to_string().as_bytes()).await;
    assert_eq!(res.status, 204);
    let tag2 = res.header("etag").unwrap().to_owned();
    assert_ne!(tag2, tag1);
    assert_eq!(next_board(&mut rpc).await["etag"], tag2.as_str());

    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("etag"), Some(tag2.as_str()));
    let board = res.json();
    let nodes = board["nodes"].as_object().unwrap();
    // R8.20: every buf survives and no text comes back on a node that has one.
    for (id, buf) in [("p1", "notes/alpha.md"), ("p2", "notes/beta.md")] {
        assert_eq!(nodes[id]["buf"], buf, "{id}");
        assert!(nodes[id].get("text").is_none(), "{id}: {}", nodes[id]);
        assert!(nodes[id].get("anchors").is_none(), "{id}: {}", nodes[id]);
    }
    // The rest of the PUT is honoured: moved card, new page, terminal, version.
    assert_eq!(nodes["p1"]["x"], 11);
    assert_eq!(nodes["p3"], pre_buf()["nodes"]["p3"]);
    assert_eq!(nodes["t1"], migrated()["nodes"]["t1"]);
    assert_eq!(nodes.len(), 4);
    assert_eq!(board["v"], 1);
    assert_eq!(board["edges"], json!([]));
    // What GET returns is what was written.
    let on_disk: Value = serde_json::from_slice(&std::fs::read(board_file(&web)).unwrap()).unwrap();
    assert_eq!(on_disk, board);
    assert!(is_board_etag(
        &tag2,
        std::fs::metadata(board_file(&web)).unwrap().len() as usize
    ));
    assert!(!backup_file(&web).exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_pre_edwind_copy_is_made_once_when_buf_first_arrives() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));

    // The board before edwind: pages with text, no buf anywhere.
    let before = pre_buf().to_string();
    let res = put(&web, Some(EMPTY), before.as_bytes()).await;
    assert_eq!(res.status, 204);
    let tag1 = res.header("etag").unwrap().to_owned();
    assert!(!backup_file(&web).exists());
    // A PUT without buf changes nothing about the copy.
    let mut moved = pre_buf();
    moved["nodes"]["p1"]["x"] = json!(99);
    let res = put(&web, Some(&tag1), moved.to_string().as_bytes()).await;
    assert_eq!(res.status, 204);
    let tag2 = res.header("etag").unwrap().to_owned();
    assert!(!backup_file(&web).exists());

    // The migration (R8.17) brings the first buf: the stored board is copied first.
    let mut step1 = moved.clone();
    step1["nodes"]["p1"] = json!({"id": "p1", "kind": "buffer", "buf": "notes/alpha.md", "x": 99});
    let res = put(&web, Some(&tag2), step1.to_string().as_bytes()).await;
    assert_eq!(res.status, 204);
    let tag3 = res.header("etag").unwrap().to_owned();
    let backup = backup_file(&web);
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        moved.to_string().as_bytes()
    );
    assert_eq!(
        std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::read(board_file(&web)).unwrap(),
        step1.to_string().as_bytes()
    );

    // More pages migrate, and a new page arrives with buf: the copy is never touched.
    let mut step2 = step1.clone();
    step2["nodes"]["p2"] = json!({"id": "p2", "kind": "buffer", "buf": "notes/beta.md"});
    step2["nodes"]["p4"] = json!({"id": "p4", "kind": "buffer", "buf": "notes/delta.md"});
    let res = put(&web, Some(&tag3), step2.to_string().as_bytes()).await;
    assert_eq!(res.status, 204);
    let tag4 = res.header("etag").unwrap().to_owned();
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        moved.to_string().as_bytes()
    );

    // A pre-buf tab saving over it afterwards: bufs kept, copy still the original.
    let res = put(&web, Some(&tag4), pre_buf().to_string().as_bytes()).await;
    assert_eq!(res.status, 204);
    let board = web.req("GET", "/api/board").send().await.json();
    assert_eq!(board["nodes"]["p1"]["buf"], "notes/alpha.md");
    assert_eq!(board["nodes"]["p2"]["buf"], "notes/beta.md");
    // A node the PUT does not carry is deleted, as any delete is: the guard protects
    // only the nodes the PUT names.
    assert!(board["nodes"].get("p4").is_none());
    assert!(board["nodes"]["p3"]["buf"].is_null());
    assert_eq!(board["nodes"]["p3"]["text"], "a new page");
    assert_eq!(
        std::fs::read(&backup).unwrap(),
        moved.to_string().as_bytes()
    );
    let mut files: Vec<_> = std::fs::read_dir(web.dir.path().join("boards"))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(files, ["testhost.json", "testhost.pre-edwind.json"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bodies_without_a_nodes_object_are_written_as_sent() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let res = put(&web, Some(EMPTY), migrated().to_string().as_bytes()).await;
    assert_eq!(res.status, 204);
    let mut tag = res.header("etag").unwrap().to_owned();
    // The full wipe, null, and the array shape go through byte for byte.
    for body in [
        &b"{\"v\":0}"[..],
        b"null",
        b"{\"nodes\":[{\"id\":\"a1\",\"text\":\"t\"}],\"edges\":[]}",
        b"{ \"v\" : 0 , \"nodes\" : { } }",
    ] {
        let res = put(&web, Some(&tag), body).await;
        assert_eq!(res.status, 204, "{}", String::from_utf8_lossy(body));
        tag = res.header("etag").unwrap().to_owned();
        assert!(is_board_etag(&tag, body.len()), "{tag}");
        let res = web.req("GET", "/api/board").send().await;
        assert_eq!(res.body, body);
        assert_eq!(res.header("etag"), Some(tag.as_str()));
    }
    assert!(!backup_file(&web).exists());
}
