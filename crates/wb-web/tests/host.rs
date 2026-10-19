//! `/api/proc`, `/api/units` and `/api/unit/{n}` (design §3.5.5, M5-W3): read only,
//! through the fixture's fake `systemctl`; unit control stays 403.

mod common;

use common::{FakeHub, Web, pty_summary};
use serde_json::json;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn processes_are_listed_and_a_shell_names_its_card() {
    let hub = FakeHub::start();
    // This test process stands in for a card's shell.
    let mut s = pty_summary("n_sh", 1, true, false);
    s.pty.as_mut().unwrap().pid = Some(std::process::id());
    hub.set_sessions(vec![s]);
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;

    let v = web.req("GET", "/api/proc").send().await.json();
    assert_eq!(v["host"], "testhost");
    let procs = v["procs"].as_array().unwrap();
    let me = procs
        .iter()
        .find(|p| p["pid"] == std::process::id())
        .expect("the test process is listed");
    assert_eq!(me["node"], "n_sh");
    for key in ["ppid", "start", "rss"] {
        assert!(me[key].is_u64(), "{key}");
    }
    assert!(me["comm"].is_string() && me["cmd"].is_string() && me["state"].is_string());
    // wb-web itself, not a card.
    let web_proc = procs.iter().find(|p| p["pid"] == web.pid()).unwrap();
    assert!(web_proc.get("node").is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn units_come_from_systemctl_and_control_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let bin = web.dir.path().join("bin");
    std::fs::write(
        bin.join("units.json"),
        json!([
            {"unit": "a.service", "load": "loaded", "active": "active", "sub": "running", "description": "A", "extra": 1},
            {"unit": "b.service", "load": "loaded", "active": "failed", "sub": "failed", "description": "B"}
        ])
        .to_string(),
    )
    .unwrap();

    let v = web.req("GET", "/api/units").send().await.json();
    assert_eq!(v["error"], json!(null));
    assert_eq!(
        v["units"],
        json!([
            {"unit": "a.service", "load": "loaded", "active": "active", "sub": "running", "description": "A"},
            {"unit": "b.service", "load": "loaded", "active": "failed", "sub": "failed", "description": "B"}
        ])
    );
    let status = web.req("GET", "/api/status").send().await.json();
    assert_eq!(
        status["units"],
        json!({"total": 2, "active": 1, "failed": 1, "failedNames": ["b.service"]})
    );

    let u = web.req("GET", "/api/unit/a.service").send().await.json();
    assert_eq!(u["unit"], "a.service");
    assert_eq!(u["status"], "* a.service - fake unit\n");
    assert_eq!(u["props"]["Id"], "a.service");
    assert_eq!(u["error"], json!(null));
    assert!(u["procs"].is_array());

    // A name that looks like an option never reaches systemctl.
    let bad = web.req("GET", "/api/unit/--host=evil").send().await.json();
    assert_eq!(bad["error"], "bad unit name");
    let argv = std::fs::read_to_string(bin.join("argv")).unwrap();
    assert!(!argv.contains("evil"), "{argv}");
    assert!(
        argv.lines()
            .any(|l| l.starts_with("status ") && l.ends_with("-- a.service")),
        "{argv}"
    );

    for verb in ["start", "stop", "restart"] {
        let res = web
            .req("POST", &format!("/api/unit/a.service/{verb}"))
            .send()
            .await;
        assert_eq!(res.status, 403);
        assert_eq!(
            res.json()["error"],
            "unit control is disabled in Workbench; use ssh"
        );
    }
    assert!(
        !std::fs::read_to_string(bin.join("argv"))
            .unwrap()
            .contains("restart")
    );
}
