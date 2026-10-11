//! The auth floor, static files and the `/api` surface of M0, through the real binary
//! (design §3.5.5, §3.6, 20-web §11.3).

mod common;

use common::{FakeHub, HOST, INDEX, ORIGIN, Req, SECRET, Web, fixture, run_to_exit};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use wb_proto::hub::HubRequest;

const SECRET_HEADER: &str = "X-Workbench-Proxy-Secret";

/// A WebSocket handshake as a raw request, for the cases that must never reach 101.
fn upgrade(web: &Web, path: &str) -> Req {
    web.req("GET", path)
        .set("Origin", ORIGIN)
        .add("Upgrade", "websocket")
        .add("Connection", "Upgrade")
        .add("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .add("Sec-WebSocket-Version", "13")
}

fn no_pty_open(hub: &FakeHub) -> bool {
    !hub.requests()
        .iter()
        .any(|(_, r)| matches!(r, HubRequest::PtyOpen { .. }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_floor_refuses_before_anything_else() {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    let wrong = "f".repeat(64);
    let targets = [
        ("GET", "/"),
        ("GET", "/api/info"),
        ("PUT", "/api/board"),
        ("GET", "/no/such/path"),
        ("GET", "/api/tmux"),
        ("OPTIONS", "/api/info"),
    ];
    for (method, path) in targets {
        let cases = [
            ("no secret", web.req(method, path).without(SECRET_HEADER)),
            (
                "wrong secret",
                web.req(method, path).set(SECRET_HEADER, &wrong),
            ),
            (
                "short secret",
                web.req(method, path).set(SECRET_HEADER, &SECRET[..63]),
            ),
            (
                "duplicated secret",
                web.req(method, path).add(SECRET_HEADER, &wrong),
            ),
            (
                "wrong host",
                web.req(method, path).set("Host", "other.example.org"),
            ),
            (
                "host with port",
                web.req(method, path).set("Host", "wb.example.org:8080"),
            ),
            (
                "foreign origin",
                web.req(method, path)
                    .set("Origin", "http://evil.example.org"),
            ),
            ("two hosts", web.req(method, path).add("Host", HOST)),
            ("null origin", web.req(method, path).set("Origin", "null")),
            (
                "two origins",
                web.req(method, path)
                    .set("Origin", ORIGIN)
                    .add("Origin", ORIGIN),
            ),
            ("non-proxy source", web.req(method, path).from("127.0.0.2")),
        ];
        for (what, req) in cases {
            let res = req.send().await;
            assert_eq!(res.status, 403, "{what}: {method} {path}");
            assert_eq!(res.json(), json!({"error": "forbidden"}), "{what}");
        }
    }

    let absolute = web
        .req("GET", "http://wb.example.org/api/info")
        .send()
        .await;
    assert_eq!(absolute.status, 403, "absolute-form target");
    let res = web
        .req("PUT", "/api/board")
        .without("Origin")
        .body("{}")
        .send()
        .await;
    assert_eq!(res.status, 403, "mutation without Origin");

    for path in ["/pty", "/acp", "/rpc"] {
        let res = upgrade(&web, path).without("Origin").send().await;
        assert_eq!(res.status, 403, "upgrade {path} without Origin");
    }
    let refused = [
        upgrade(&web, "/pty").without(SECRET_HEADER),
        upgrade(&web, "/pty").set(SECRET_HEADER, &wrong),
        upgrade(&web, "/pty").set("Origin", "http://evil.example.org"),
        upgrade(&web, "/pty").set("Origin", "null"),
        upgrade(&web, "/pty").from("127.0.0.2"),
        // The prototype's RCE handshake: no secret, no Origin.
        upgrade(&web, "/pty?token=")
            .without(SECRET_HEADER)
            .without("Origin"),
    ];
    for req in refused {
        assert_eq!(req.send().await.status, 403);
    }
    assert!(no_pty_open(&hub));
    assert!(!web.dir.path().join("boards").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_authenticated_upgrade_to_an_unknown_path_is_404() {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    for path in ["/", "/index.html", "/api/info", "/ptyx", "/pty/", "/mcp"] {
        let res = upgrade(&web, path).send().await;
        assert_eq!(res.status, 404, "{path}");
    }
    assert!(no_pty_open(&hub));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tokens_are_ignored_and_never_logged() {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    let res = web
        .req("GET", "/api/info?token=MARK1")
        .add("X-Token", "MARK3")
        .send()
        .await;
    assert_eq!(res.status, 200);
    web.ws_with("/pty?token=MARK1", &[("x-token", Some("MARK3"))])
        .await
        .expect("101 with a token");
    let res = web
        .req("GET", "/api/info")
        .without(SECRET_HEADER)
        .add("X-Token", SECRET)
        .send()
        .await;
    assert_eq!(res.status, 403, "a token never stands in for the secret");

    let mark2 = format!("MARK2{}", "0".repeat(59));
    let res = web
        .req("GET", "/api/info?token=MARK1")
        .set(SECRET_HEADER, &mark2)
        .add("X-Token", "MARK3")
        .send()
        .await;
    assert_eq!(res.status, 403);
    let res = upgrade(&web, "/pty?token=MARK1")
        .set(SECRET_HEADER, &mark2)
        .add("X-Token", "MARK3")
        .send()
        .await;
    assert_eq!(res.status, 403);
    let log = web.wait_log("request refused", 3).await;
    assert!(!log.contains("MARK"), "{log}");
    assert!(!log.contains(SECRET), "{log}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn security_headers_on_every_response_and_csp_on_html() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let responses = [
        ("/", web.req("GET", "/").send().await, true),
        ("/app.js", web.req("GET", "/app.js").send().await, false),
        ("/api/info", web.req("GET", "/api/info").send().await, false),
        ("/missing", web.req("GET", "/missing").send().await, false),
        (
            "refused",
            web.req("GET", "/").without(SECRET_HEADER).send().await,
            false,
        ),
    ];
    for (what, res, html) in responses {
        assert_eq!(
            res.header("x-content-type-options"),
            Some("nosniff"),
            "{what}"
        );
        assert_eq!(res.header("referrer-policy"), Some("no-referrer"), "{what}");
        assert_eq!(res.header("x-frame-options"), Some("DENY"), "{what}");
        let csp = res.header("content-security-policy");
        if html {
            assert_eq!(csp, Some("object-src 'none'; base-uri 'none'"), "{what}");
        } else {
            assert_eq!(csp, None, "{what}");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn static_files_have_content_etags() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let digest = Sha256::digest(INDEX.as_bytes());
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    let tag = format!("\"{hex}\"");

    for path in ["/", "/index.html"] {
        let res = web.req("GET", path).send().await;
        assert_eq!(res.status, 200, "{path}");
        assert_eq!(res.body, INDEX.as_bytes());
        assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
        assert_eq!(res.header("cache-control"), Some("no-cache"));
        assert_eq!(res.header("etag"), Some(tag.as_str()));
    }
    let res = web.req("GET", "/").set("If-None-Match", &tag).send().await;
    assert_eq!(res.status, 304);
    assert!(res.body.is_empty());
    assert_eq!(res.header("etag"), Some(tag.as_str()));
    assert_eq!(res.header("cache-control"), Some("no-cache"));

    let res = web.req("HEAD", "/").send().await;
    assert_eq!(res.status, 200);
    assert!(res.body.is_empty());
    assert_eq!(res.header("etag"), Some(tag.as_str()));

    let res = web.req("GET", "/app.js").send().await;
    assert_eq!(
        res.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_ne!(res.header("etag"), Some(tag.as_str()));

    assert_eq!(web.req("POST", "/").send().await.status, 405);
    for path in [
        "/missing.js",
        "/../web.json",
        "/secret",
        "/web/index.html",
        "/%2e%2e/secret",
    ] {
        let res = web.req("GET", path).send().await;
        assert_eq!(res.status, 404, "{path}");
        assert_eq!(res.json(), json!({"error": "not found"}));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_api_surface_of_m0() {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;

    let res = web.req("GET", "/api/info").send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(res.header("content-type"), Some("application/json"));
    let info = res.json();
    let dir = web.dir.path();
    assert_eq!(info["host"], "testhost");
    assert_eq!(info["notes"], json!(dir.join("notes")));
    assert_eq!(info["state"], json!(dir.join("state")));
    for (key, want) in [
        ("sample", json!(false)),
        ("notesExists", json!(false)),
        ("tmux", json!(false)),
        ("artifactOrigin", Value::Null),
        ("agents", json!([])),
    ] {
        assert_eq!(info[key], want, "{key}");
    }
    assert_eq!(
        info["hub"],
        json!({"status": "up", "version": "0.1.0", "build": null, "proto": 1,
               "startedAt": 1_700_000_000_000u64, "stale": false})
    );

    let sessions = web.req("GET", "/api/sessions").send().await;
    assert_eq!(sessions.status, 200);
    assert_eq!(sessions.json(), json!({"host": "testhost", "sessions": []}));

    for path in [
        "/api/nodes",
        "/api/links",
        "/api/cards",
        "/api/tasks",
        "/api/proc",
    ] {
        let res = web.req("GET", path).send().await;
        assert_eq!(res.status, 200, "{path}");
        assert_eq!(res.header("cache-control"), Some("no-store"), "{path}");
    }
    assert_eq!(
        web.req("GET", "/api/units").send().await.json()["units"],
        json!([])
    );

    for verb in ["start", "stop", "restart"] {
        let res = web
            .req("POST", &format!("/api/unit/example.service/{verb}"))
            .send()
            .await;
        assert_eq!(res.status, 403, "{verb}");
        assert_eq!(
            res.json(),
            json!({"error": "unit control is disabled in Workbench; use ssh"})
        );
    }

    let gone = [
        ("GET", "/api/tmux"),
        ("GET", "/api/tmux/sessions"),
        ("GET", "/api/hosts"),
        ("POST", "/api/cmd"),
        ("GET", "/api/backlinks"),
        ("POST", "/api/index/rescan"),
        ("POST", "/api/tasks"),
        ("POST", "/api/task/t1/dispatch"),
        ("DELETE", "/api/artifact/n1"),
        ("GET", "/api/journal"),
        ("GET", "/mcp"),
        ("POST", "/mcp"),
    ];
    for (method, path) in gone {
        let res = web.req(method, path).send().await;
        assert_eq!(res.status, 404, "{method} {path}");
        assert_eq!(res.json(), json!({"error": "not found"}), "{method} {path}");
        if path.starts_with("/api/") {
            assert_eq!(res.header("cache-control"), Some("no-store"), "{path}");
        }
    }

    for (method, path) in [
        ("OPTIONS", "/api/info"),
        ("OPTIONS", "/api/board"),
        ("OPTIONS", "/"),
        ("DELETE", "/api/board"),
        ("POST", "/api/info"),
    ] {
        let res = web.req(method, path).send().await;
        assert_eq!(res.status, 405, "{method} {path}");
        assert!(
            !res.headers
                .iter()
                .any(|(n, _)| n.starts_with("access-control-")),
            "{method} {path}"
        );
    }

    // A plain GET on a socket route.
    assert_eq!(web.req("GET", "/pty").send().await.status, 400);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn startup_refusals() {
    type Edit = fn(&std::path::Path, &mut Value);
    let cases: [(&str, Edit); 6] = [
        ("missing secret file", |dir, _| {
            std::fs::remove_file(dir.join("secret")).unwrap();
        }),
        ("63-char secret", |dir, _| {
            std::fs::write(dir.join("secret"), &SECRET[..63]).unwrap();
        }),
        ("uppercase secret", |dir, _| {
            std::fs::write(dir.join("secret"), SECRET.to_uppercase()).unwrap();
        }),
        ("unknown key", |_, cfg| {
            cfg["origins"] = json!("*");
        }),
        ("misspelt key", |_, cfg| {
            let proxy = cfg.as_object_mut().unwrap().remove("trustedProxy").unwrap();
            cfg["trustedProxies"] = proxy;
        }),
        ("missing trustedProxy", |_, cfg| {
            cfg.as_object_mut().unwrap().remove("trustedProxy");
        }),
    ];
    for (what, edit) in cases {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fixture(dir.path(), &dir.path().join("hub.sock"));
        edit(dir.path(), &mut cfg);
        let path = dir.path().join("web.json");
        std::fs::write(&path, cfg.to_string()).unwrap();
        let (status, stderr) = run_to_exit(&["--config", path.to_str().unwrap()]);
        assert_eq!(status.code(), Some(1), "{what}: {stderr}");
        assert!(!stderr.contains("listening on"), "{what}: {stderr}");
        assert!(
            !stderr.to_lowercase().contains(&SECRET[..32]),
            "{what}: {stderr}"
        );
    }

    let dir = tempfile::tempdir().unwrap();
    let cfg = fixture(dir.path(), &dir.path().join("hub.sock"));
    let path = dir.path().join("web.json");
    std::fs::write(&path, cfg.to_string()).unwrap();
    let path = path.to_str().unwrap();
    for args in [
        &["--origins", "*", "--config", path][..],
        &["--config", path, "--origins", "*"],
        &[],
        &["--config"],
    ] {
        let (status, stderr) = run_to_exit(args);
        assert_eq!(status.code(), Some(2), "{args:?}: {stderr}");
        assert!(stderr.contains("usage: wb-web --config PATH"));
    }
}
