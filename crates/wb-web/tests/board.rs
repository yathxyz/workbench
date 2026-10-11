//! `GET`/`PUT /api/board` in M0: last writer wins, with ETags (design §3.5.5).

mod common;

use std::os::unix::fs::PermissionsExt;

use common::{Web, next_json};
use serde_json::json;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn board_round_trip_with_etags_and_the_rpc_notice() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let mut rpc = web.ws("/rpc").await;
    assert_eq!(next_json(&mut rpc).await["t"], "hub");

    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, b"null");
    assert_eq!(res.header("etag"), Some("\"empty\""));
    assert_eq!(res.header("cache-control"), Some("no-store"));

    let first = br#"{"nodes":[{"id":"a1"}],"edges":[]}"#;
    let res = web.req("PUT", "/api/board").body(&first[..]).send().await;
    assert_eq!(res.status, 204);
    let tag1 = res.header("etag").unwrap().to_owned();
    assert!(is_board_etag(&tag1, first.len()), "{tag1}");
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "board", "etag": tag1})
    );

    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, first);
    assert_eq!(res.header("etag"), Some(tag1.as_str()));

    // Same size, new content: the tag still changes. If-Match is not checked in M0.
    let second = br#"{"nodes":[{"id":"b2"}],"edges":[]}"#;
    let res = web
        .req("PUT", "/api/board")
        .add("If-Match", "\"stale\"")
        .body(&second[..])
        .send()
        .await;
    assert_eq!(res.status, 204);
    let tag2 = res.header("etag").unwrap().to_owned();
    assert_ne!(tag1, tag2);
    assert_eq!(
        next_json(&mut rpc).await,
        json!({"t": "board", "etag": tag2})
    );
    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.body, second);
    assert_eq!(res.header("etag"), Some(tag2.as_str()));

    let file = web.dir.path().join("boards/testhost.json");
    assert_eq!(std::fs::read(&file).unwrap(), second);
    let mode = std::fs::metadata(&file).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    let leftovers: Vec<_> = std::fs::read_dir(web.dir.path().join("boards"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers, ["testhost.json"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bad_board_writes_change_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let res = web
        .req("PUT", "/api/board")
        .body("{\"nodes\":")
        .send()
        .await;
    assert_eq!(res.status, 400);
    assert!(
        res.json()["error"]
            .as_str()
            .unwrap()
            .starts_with("invalid JSON"),
    );
    let res = web
        .req("PUT", "/api/board")
        .without("Origin")
        .body("{}")
        .send()
        .await;
    assert_eq!(res.status, 403);
    let res = web.req("GET", "/api/board").send().await;
    assert_eq!(res.body, b"null");
    assert!(!web.dir.path().join("boards").exists());
}
