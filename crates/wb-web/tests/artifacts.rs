//! `/api/artifact/{node}` and `/api/db/{node}` (design §3.5.5, M5-W3): srcdoc versions,
//! the 409 shape and the per-node db.

mod common;

use common::Web;
use serde_json::{Value, json};

async fn put(web: &Web, node: &str, body: Value) -> (u16, Value) {
    let res = web
        .req("PUT", &format!("/api/artifact/{node}"))
        .set("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await;
    (res.status, res.json())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn versions_publish_conflict_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));

    // No artifact yet: the empty shape.
    let res = web.req("GET", "/api/artifact/n_a1").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(
        res.json(),
        json!({"meta": {"head": null, "versions": [], "capabilities": {}}, "content": null, "url": null})
    );

    let (status, v1) = put(
        &web,
        "n_a1",
        json!({"html": "<p>one</p>", "capabilities": {"db": {}}, "ifMatch": null}),
    )
    .await;
    assert_eq!(status, 200, "{v1}");
    let h1 = v1["version"].as_str().unwrap().to_owned();
    assert_eq!(v1["url"], Value::Null);
    assert_eq!(v1["changed"], true);
    assert_eq!(v1["meta"]["head"], h1.as_str());
    assert_eq!(v1["meta"]["versions"][0]["sha"], h1.as_str());
    assert_eq!(v1["meta"]["capabilities"], json!({"db": {}}));

    // A second writer holding no head, or an old one, loses with the 409 shape.
    for stale in [Value::Null, json!("0000000000000000")] {
        let (status, err) = put(
            &web,
            "n_a1",
            json!({"html": "<p>two</p>", "ifMatch": stale}),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(err["error"]["code"], "conflict");
        assert_eq!(err["error"]["head"], h1.as_str());
        assert!(err["error"]["message"].is_string());
    }

    let (status, v2) = put(&web, "n_a1", json!({"html": "<p>two</p>", "ifMatch": h1})).await;
    assert_eq!(status, 200);
    let h2 = v2["version"].as_str().unwrap().to_owned();
    assert_ne!(h1, h2);

    let head = web.req("GET", "/api/artifact/n_a1").send().await.json();
    assert_eq!(
        head["content"],
        json!({"kind": "page", "html": "<p>two</p>"})
    );
    assert_eq!(head["meta"]["versions"].as_array().unwrap().len(), 2);
    let old = web
        .req("GET", &format!("/api/artifact/n_a1?v={h1}"))
        .send()
        .await
        .json();
    assert_eq!(
        old["content"],
        json!({"kind": "page", "html": "<p>one</p>"})
    );

    // Files patch the head.
    let (status, v3) = put(
        &web,
        "n_a1",
        json!({"files": {"app.js": "x()"}, "ifMatch": h2}),
    )
    .await;
    assert_eq!(status, 200);
    let files = web.req("GET", "/api/artifact/n_a1").send().await.json();
    assert_eq!(files["meta"]["head"], v3["version"]);
    assert_eq!(files["content"]["kind"], "files");
    assert_eq!(
        files["content"]["files"]["index.html"]["text"],
        "<p>two</p>"
    );
    assert_eq!(files["content"]["files"]["app.js"]["text"], "x()");

    // Unknown versions, bad ids and bad bodies.
    assert_eq!(
        web.req("GET", "/api/artifact/n_a1?v=ffffffffffffffff")
            .send()
            .await
            .status,
        404
    );
    assert_eq!(
        web.req("GET", "/api/artifact/n_a1?v=../x")
            .send()
            .await
            .status,
        400
    );
    assert_eq!(web.req("GET", "/api/artifact/a.b").send().await.status, 400);
    assert_eq!(put(&web, "n_a2", json!({"ifMatch": null})).await.0, 400);
    let res = web
        .req("PUT", "/api/artifact/n_a2")
        .body("not json")
        .send()
        .await;
    assert_eq!(res.status, 400);
    // Deleting stays a removed feature.
    assert_eq!(
        web.req("DELETE", "/api/artifact/n_a1").send().await.status,
        404
    );

    // On disk under stateDir, 0600.
    use std::os::unix::fs::PermissionsExt;
    let meta = web.dir.path().join("state/artifacts/n_a1/meta.json");
    assert_eq!(
        std::fs::metadata(&meta).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        web.dir
            .path()
            .join(format!("state/artifacts/n_a1/v/{h1}.json"))
            .exists()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_large_page_fits_under_the_board_cap() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let html = "x".repeat(4 << 20);
    let (status, _) = put(&web, "n_big", json!({"html": html})).await;
    assert_eq!(status, 200);
    let res = web
        .req("PUT", "/api/artifact/n_big")
        .body(vec![b'x'; (32 << 20) + 1])
        .send()
        .await;
    assert_eq!(res.status, 413);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_db_is_kept_per_node() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));

    assert_eq!(
        web.req("GET", "/api/db/n_d1").send().await.json(),
        json!({})
    );
    let db = json!({"docs": {"data/counter": {"n": 3}}});
    let res = web
        .req("PUT", "/api/db/n_d1")
        .set("Content-Type", "application/json")
        .body(db.to_string())
        .send()
        .await;
    assert_eq!(res.status, 204);
    assert_eq!(web.req("GET", "/api/db/n_d1").send().await.json(), db);
    assert_eq!(
        web.req("GET", "/api/db/n_d2").send().await.json(),
        json!({})
    );

    for bad in ["[1]", "\"x\"", "{"] {
        assert_eq!(
            web.req("PUT", "/api/db/n_d1").body(bad).send().await.status,
            400,
            "{bad}"
        );
    }
    assert_eq!(web.req("GET", "/api/db/n_d1").send().await.json(), db);
    assert_eq!(
        web.req("PUT", "/api/db/..").body("{}").send().await.status,
        400
    );
}
