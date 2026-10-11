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
    let mut rpc = web.ws("/rpc").await;

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
    let mut rpc = web.ws("/rpc").await;
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
