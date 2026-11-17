//! The mesh API on its own listener, against a fake hub (design §3.8.1, §3.8.2,
//! §3.8.4).
//!
//! The shared fake hub records `acp.*` requests without answering them; each test
//! answers by injecting the reply on the request's connection.

mod common;

use std::net::SocketAddr;

use common::{FakeHub, Hello, Req, Resp, WAIT, Web, pty_summary};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use wb_proto::hub::{
    AcpFacts, AcpOpenReply, AcpSessionInfo, Activity, Agent, ErrorCode, Host, HubMessage,
    HubRequest, Kind, SpawnAcp, Summary,
};
use wb_proto::journal::{EventBody, JournalEvent};

const EPOCH: u64 = 1_700_000_000_000;
/// The tokens of the three clients [`Api::start`] configures.
const OWNER: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const READER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const AGENTS: &str = "3333333333333333333333333333333333333333333333333333333333333333";
/// The only address the `agents` client's token is taken from.
const AGENTS_ADDR: &str = "127.0.0.9";

/// A wb-web with an API listener, and the fake hub behind it.
struct Api {
    hub: FakeHub,
    web: Web,
    addr: SocketAddr,
    _tokens: tempfile::TempDir,
}

impl Api {
    async fn start() -> Api {
        Api::start_with(Hello::default()).await
    }

    async fn start_with(hello: Hello) -> Api {
        let hub = FakeHub::start_with(hello);
        let api = Api::without_hub(hub).await;
        api.web.wait_hub("up").await;
        api
    }

    /// Does not wait for the hub, so `hub` may be one that is already stopped.
    async fn without_hub(hub: FakeHub) -> Api {
        let tokens = tempfile::tempdir().unwrap();
        let file = |name: &str, token: &str| {
            let path = tokens.path().join(name);
            std::fs::write(&path, format!("{token}\n")).unwrap();
            path
        };
        let clients = json!({
            "owner": {"tokenFile": file("owner", OWNER), "scopes": ["read", "control"]},
            "reader": {"tokenFile": file("reader", READER), "scopes": ["read"]},
            "agents": {
                "tokenFile": file("agents", AGENTS),
                "scopes": ["events"],
                "host": "devbox",
                "address": AGENTS_ADDR,
            },
        });
        let web = Web::start_with(&hub.path, |cfg| {
            cfg["api"] = json!({"listen": "127.0.0.2:0", "clients": clients});
        });
        let addr = web.api_addr().await;
        Api {
            hub,
            web,
            addr,
            _tokens: tokens,
        }
    }

    fn req(&self, method: &str, path: &str, token: &str) -> Req {
        Req::to(self.addr, method, path).set("Authorization", &format!("Bearer {token}"))
    }

    async fn get(&self, path: &str) -> Resp {
        self.req("GET", path, OWNER).send().await
    }

    /// Sends `req`, answers the one `acp.*` request it causes with `reply(rid)`, and
    /// returns that request and the response.
    async fn answered(
        &self,
        req: Req,
        reply: impl FnOnce(u64) -> HubMessage,
    ) -> (HubRequest, Resp) {
        let before = self.hub.requests().len();
        let sent = tokio::spawn(req.send());
        let (conn, hub_req) = self.asked_after(before).await;
        self.hub.send(conn, reply(rid_of(&hub_req)));
        (hub_req, sent.await.unwrap())
    }

    /// The first request recorded after the first `before` that is not part of a
    /// connection's start, with its connection.
    async fn asked_after(&self, before: usize) -> (usize, HubRequest) {
        let started = std::time::Instant::now();
        loop {
            let found =
                self.hub.requests().into_iter().skip(before).find(|(_, r)| {
                    !matches!(r, HubRequest::Hello { .. } | HubRequest::Watch { .. })
                });
            if let Some(found) = found {
                return found;
            }
            assert!(started.elapsed() < WAIT, "no hub request arrived");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

fn ok(rid: u64) -> HubMessage {
    HubMessage::ok(rid, &json!({}))
}

fn refusal(code: ErrorCode, message: &str) -> impl FnOnce(u64) -> HubMessage {
    let message = message.to_owned();
    move |rid| HubMessage::Err {
        rid: Some(rid),
        sid: None,
        code,
        message,
    }
}

fn rid_of(r: &HubRequest) -> u64 {
    match r {
        HubRequest::AcpOpen { rid, .. }
        | HubRequest::AcpPrompt { rid, .. }
        | HubRequest::AcpCancel { rid, .. }
        | HubRequest::AcpPermission { rid, .. }
        | HubRequest::AcpElicitation { rid, .. }
        | HubRequest::AcpSetMode { rid, .. }
        | HubRequest::AcpRevive { rid, .. }
        | HubRequest::AcpKill { rid, .. }
        | HubRequest::PtyKill { rid, .. } => *rid,
        other => panic!("no rid in {other:?}"),
    }
}

/// A live ACP Summary of `sid` with nothing outstanding: state `idle`.
fn summary(sid: &str, host: &str) -> Summary {
    Summary {
        sid: sid.into(),
        kind: Kind::Acp,
        host: host.into(),
        created_at: EPOCH,
        updated_at: EPOCH + 1,
        alive: true,
        viewers: 0,
        cwd: "/home/alice/src".into(),
        fault: None,
        pty: None,
        acp: Some(AcpFacts {
            agent: "claude".into(),
            agent_session_id: Some("s-1".into()),
            revivable: true,
            activity: Activity::None,
            pending: Vec::new(),
            last: None,
            head_seq: 3,
            seen_seq: 0,
            title: None,
            mode_id: Some("default".into()),
        }),
    }
}

fn open_reply(sid: &str, host: &str, new: bool) -> AcpOpenReply {
    AcpOpenReply {
        new,
        summary: summary(sid, host),
        session: AcpSessionInfo::default(),
        head: 3,
        from: 1,
        reset: false,
    }
}

#[tokio::test]
async fn a_request_needs_a_clients_token() {
    let api = Api::start().await;
    // (what, the request): each is 401, whether or not the path exists.
    let no_token = |path: &str| Req::to(api.addr, "GET", path);
    let refused = [
        ("no header", no_token("/v1/info")),
        ("no header, no such path", no_token("/v1/nothing")),
        ("no header, outside /v1", no_token("/")),
        (
            "an unknown token",
            api.req("GET", "/v1/info", &"0".repeat(64)),
        ),
        (
            "a token cut short",
            api.req("GET", "/v1/info", &OWNER[..63]),
        ),
        (
            "another scheme",
            no_token("/v1/info").set("Authorization", &format!("Basic {OWNER}")),
        ),
        (
            "two headers",
            api.req("GET", "/v1/info", OWNER)
                .add("Authorization", &format!("Bearer {OWNER}")),
        ),
        (
            "the token as a query",
            no_token(&format!("/v1/info?token={OWNER}")),
        ),
        (
            "the browser's proxy secret",
            no_token("/v1/info").set("X-Workbench-Proxy-Secret", common::SECRET),
        ),
        (
            "a pinned token from another address",
            api.req("POST", "/v1/events", AGENTS).body("{}"),
        ),
    ];
    for (what, req) in refused {
        let res = req.send().await;
        assert_eq!(res.status, 401, "{what}");
        assert_eq!(res.json(), json!({"error": "unauthorized"}), "{what}");
        assert_eq!(res.header("www-authenticate"), Some("Bearer"), "{what}");
        assert_eq!(res.header("cache-control"), Some("no-store"), "{what}");
    }
    // Refusals are logged without the token.
    let log = api.web.wait_log("api request refused", 10).await;
    assert!(!log.contains(OWNER) && !log.contains(AGENTS), "{log}");
    assert!(!log.contains("token="), "the query is not logged: {log}");
}

#[tokio::test]
async fn scopes_paths_and_methods_are_checked_after_the_token() {
    let api = Api::start().await;
    let status = |res: &Resp| (res.status, res.json()["error"].clone());

    // (method, path, token, status, error)
    let table = [
        ("GET", "/v1/info", READER, 200, Value::Null),
        ("POST", "/v1/sessions", READER, 403, json!("forbidden")),
        (
            "POST",
            "/v1/sessions/a/prompt",
            READER,
            403,
            json!("forbidden"),
        ),
        ("DELETE", "/v1/sessions/a", READER, 403, json!("forbidden")),
        ("POST", "/v1/events", READER, 403, json!("forbidden")),
        ("POST", "/v1/events", OWNER, 403, json!("forbidden")),
        // The scope comes before the body and the sid.
        (
            "POST",
            "/v1/sessions/a%20b/prompt",
            READER,
            403,
            json!("forbidden"),
        ),
        ("GET", "/v1/nothing", READER, 404, json!("not found")),
        ("GET", "/", READER, 404, json!("not found")),
        ("GET", "/api/info", OWNER, 404, json!("not found")),
        ("PUT", "/v1/info", OWNER, 405, json!("method not allowed")),
        ("GET", "/v1/events", OWNER, 405, json!("method not allowed")),
    ];
    for (method, path, token, want, error) in table {
        let res = api.req(method, path, token).body("{}").send().await;
        assert_eq!(status(&res), (want, error), "{method} {path}");
        assert_eq!(res.header("cache-control"), Some("no-store"), "{path}");
        assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(res.header("referrer-policy"), Some("no-referrer"));
        assert_eq!(res.header("access-control-allow-origin"), None);
    }

    // The events client: its own address only, and nothing but events.
    let from_agents = |method: &str, path: &str| api.req(method, path, AGENTS).from(AGENTS_ADDR);
    assert_eq!(from_agents("GET", "/v1/info").send().await.status, 403);
    assert_eq!(from_agents("GET", "/v1/observed").send().await.status, 403);

    // The browser's listener knows nothing of /v1, with or without a token.
    let res = api.web.req("GET", "/v1/info").send().await;
    assert_eq!(res.status, 404);
    let res = Req::to(api.web.addr, "GET", "/v1/info")
        .set("Authorization", &format!("Bearer {OWNER}"))
        .send()
        .await;
    assert_ne!(res.status, 200);
}

#[tokio::test]
async fn info_and_sessions_are_the_hubs() {
    let hello = Hello {
        agents: vec![Agent {
            name: "claude".into(),
            label: "Claude".into(),
        }],
        hosts: vec![Host {
            name: "laptop".into(),
            agents: vec![Agent {
                name: "pi".into(),
                label: "pi".into(),
            }],
        }],
        ..Hello::default()
    };
    let hub = FakeHub::start_with(hello);
    hub.set_sessions(vec![
        summary("a1", "testhost"),
        pty_summary("p1", EPOCH, true, false),
    ]);
    let api = Api::without_hub(hub).await;
    api.web.wait_hub("up").await;

    let info = api.get("/v1/info").await.json();
    assert_eq!(info["host"], "testhost");
    assert_eq!(info["hub"]["status"], "up");
    assert_eq!(
        info["agents"],
        json!([{"name": "claude", "label": "Claude"}])
    );
    assert_eq!(
        info["hosts"],
        json!([{"name": "laptop", "agents": [{"name": "pi", "label": "pi"}]}])
    );

    let list = api.get("/v1/sessions").await.json();
    assert_eq!(list["host"], "testhost");
    let sids: Vec<&str> = list["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sid"].as_str().unwrap())
        .collect();
    assert_eq!(sids, ["a1", "p1"]);
    assert_eq!(list["sessions"][0]["state"], "idle");

    let one = api.get("/v1/sessions/a1").await;
    assert_eq!(one.status, 200);
    assert_eq!(one.json()["acp"]["agent"], "claude");
    assert_eq!(one.json()["state"], "idle");
    let res = api.get("/v1/sessions/nope").await;
    assert_eq!(
        (res.status, res.json()),
        (404, json!({"error": "no session nope"}))
    );
    let res = api.get("/v1/sessions/a%20b").await;
    assert_eq!((res.status, res.json()), (400, json!({"error": "bad id"})));

    api.hub.reply_next_capture(Ok("$ make\nok\n"));
    let res = api.get("/v1/sessions/p1/capture?lines=5").await;
    assert_eq!(res.json(), json!({"sid": "p1", "text": "$ make\nok\n"}));
    api.hub
        .reply_next_capture(Err((ErrorCode::KindMismatch, "a1 is not a pty")));
    let res = api.get("/v1/sessions/a1/capture").await;
    assert_eq!(res.status, 409);
    assert_eq!(
        res.json(),
        json!({"error": "a1 is not a pty", "code": "kind_mismatch"})
    );
}

#[tokio::test]
async fn without_a_hub_the_hubs_endpoints_are_503() {
    let hub = FakeHub::start();
    hub.stop();
    let api = Api::without_hub(hub).await;
    let info = api.get("/v1/info").await;
    assert_eq!(info.status, 200);
    assert_eq!(info.json()["hub"]["status"], "down");
    assert_eq!(info.json()["agents"], json!([]));
    assert_eq!(info.json()["hosts"], json!([]));
    for (method, path) in [
        ("GET", "/v1/sessions"),
        ("GET", "/v1/sessions/a1"),
        ("GET", "/v1/sessions/a1/events"),
        ("GET", "/v1/sessions/a1/capture"),
        ("POST", "/v1/sessions/a1/cancel"),
        ("DELETE", "/v1/sessions/a1"),
    ] {
        let res = api.req(method, path, OWNER).send().await;
        assert_eq!(res.status, 503, "{method} {path}");
        assert_eq!(res.json(), json!({"error": "hub unavailable"}), "{path}");
    }
    let body = json!({"agent": "claude", "cwd": "/home/alice"}).to_string();
    let res = api
        .req("POST", "/v1/sessions", OWNER)
        .body(body)
        .send()
        .await;
    assert_eq!(res.status, 503);
    // The observed sessions do not need the hub.
    assert_eq!(api.get("/v1/observed").await.status, 200);
}

#[tokio::test]
async fn a_post_starts_an_agent() {
    let hello = Hello {
        hosts: vec![Host {
            name: "laptop".into(),
            agents: Vec::new(),
        }],
        ..Hello::default()
    };
    let api = Api::start_with(hello).await;
    let post = |body: Value| {
        api.req("POST", "/v1/sessions", OWNER)
            .body(body.to_string())
    };

    // A sid of the API's own, on the hub's host.
    let req = post(json!({"agent": "claude", "cwd": "/home/alice/src"}));
    let mut sid = String::new();
    let (hub_req, res) = api
        .answered(req, |rid| {
            HubMessage::ok(rid, &open_reply("api_0", "testhost", true))
        })
        .await;
    let HubRequest::AcpOpen {
        sid: asked,
        since,
        epoch,
        spawn,
        ..
    } = hub_req
    else {
        panic!("{hub_req:?}");
    };
    sid.push_str(&asked);
    assert!(sid.starts_with("api_") && sid.len() == 20, "{sid}");
    assert_eq!((since, epoch), (0, None));
    assert_eq!(
        spawn,
        Some(SpawnAcp {
            agent: "claude".into(),
            cwd: "/home/alice/src".into(),
            host: None,
        })
    );
    assert_eq!(res.status, 201);
    assert_eq!(res.json()["sid"], sid.as_str());
    assert_eq!(res.json()["session"]["state"], "idle");

    // The hub's own host is the same as none; a host of its hello is passed on.
    for (host, sent) in [("testhost", None), ("laptop", Some("laptop"))] {
        let req = post(json!({"agent": "claude", "cwd": "/srv/x", "host": host, "sid": "mine"}));
        let (hub_req, res) = api
            .answered(req, |rid| {
                HubMessage::ok(rid, &open_reply("mine", host, true))
            })
            .await;
        let HubRequest::AcpOpen { sid, spawn, .. } = hub_req else {
            panic!("{hub_req:?}");
        };
        assert_eq!(sid, "mine");
        assert_eq!(spawn.unwrap().host.as_deref(), sent, "{host}");
        assert_eq!(res.status, 201);
        assert_eq!(res.json()["session"]["host"], host);
    }

    // A session that exists is left alone.
    let req = post(json!({"agent": "claude", "cwd": "/srv/x", "sid": "mine"}));
    let (_, res) = api
        .answered(req, |rid| {
            HubMessage::ok(rid, &open_reply("mine", "testhost", false))
        })
        .await;
    assert_eq!(
        (res.status, res.json()),
        (409, json!({"error": "session exists"}))
    );

    // The hub's refusals keep their code.
    let req = post(json!({"agent": "nope", "cwd": "/srv/x"}));
    let (_, res) = api
        .answered(req, refusal(ErrorCode::UnknownAgent, "no agent nope"))
        .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json(),
        json!({"error": "no agent nope", "code": "unknown_agent"})
    );
    let req = post(json!({"agent": "claude", "cwd": "/srv/x"}));
    let (_, res) = api
        .answered(req, refusal(ErrorCode::SpawnFailed, "exec failed"))
        .await;
    assert_eq!(res.status, 502);
    assert_eq!(res.json()["code"], "spawn_failed");

    // Refused before the hub is asked.
    let asked = api.hub.requests().len();
    let bad = [
        (
            json!({"agent": "claude", "cwd": "/x", "host": "desktop"}),
            "no host desktop",
        ),
        (
            json!({"agent": "claude", "cwd": "/x", "sid": "a b"}),
            "bad id",
        ),
        (json!({"agent": "claude"}), "bad body"),
        (
            json!({"agent": "claude", "cwd": "/x", "argv": ["sh"]}),
            "bad body",
        ),
        (json!([]), "bad body"),
    ];
    for (body, error) in bad {
        let res = post(body.clone()).send().await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": error})),
            "{body}"
        );
    }
    let res = api
        .req("POST", "/v1/sessions", OWNER)
        .body("{")
        .send()
        .await;
    assert_eq!(res.status, 400);
    let acp = api.hub.requests().into_iter().skip(asked);
    assert!(
        acp.into_iter()
            .all(|(_, r)| matches!(r, HubRequest::Hello { .. })),
        "a refused request reached the hub"
    );
}

#[tokio::test]
async fn a_hub_that_lists_no_hosts_is_never_asked_for_one() {
    let api = Api::start().await;
    let body = json!({"agent": "claude", "cwd": "/x", "host": "laptop"}).to_string();
    let res = api
        .req("POST", "/v1/sessions", OWNER)
        .body(body)
        .send()
        .await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({"error": "no host laptop"}))
    );
}

#[tokio::test]
async fn actions_are_the_hubs_requests() {
    let hub = FakeHub::start();
    hub.set_sessions(vec![
        summary("a1", "testhost"),
        pty_summary("p1", EPOCH, true, false),
    ]);
    let api = Api::without_hub(hub).await;
    api.web.wait_hub("up").await;

    let sid = || "a1".to_owned();
    let outcome = json!({"outcome": "selected", "optionId": "allow"});
    let response = json!({"action": "accept", "content": {"name": "x"}});
    let blocks = json!([{"type": "text", "text": "a"}, {"type": "resource_link", "uri": "file:///x", "name": "x"}]);
    // (method, path, body, the hub request it becomes without its rid)
    let table: Vec<(&str, &str, Value, HubRequest)> = vec![
        (
            "POST",
            "/v1/sessions/a1/prompt",
            json!({"text": "run the tests"}),
            HubRequest::AcpPrompt {
                rid: 1,
                sid: sid(),
                prompt: vec![json!({"type": "text", "text": "run the tests"})],
            },
        ),
        (
            "POST",
            "/v1/sessions/a1/prompt",
            json!({"blocks": blocks}),
            HubRequest::AcpPrompt {
                rid: 1,
                sid: sid(),
                prompt: blocks.as_array().unwrap().clone(),
            },
        ),
        (
            "POST",
            "/v1/sessions/a1/cancel",
            Value::Null,
            HubRequest::AcpCancel { rid: 1, sid: sid() },
        ),
        (
            "POST",
            "/v1/sessions/a1/permission",
            json!({"req": 7, "epoch": EPOCH, "outcome": outcome}),
            HubRequest::AcpPermission {
                rid: 1,
                sid: sid(),
                req: 7,
                epoch: EPOCH,
                outcome: outcome.clone(),
            },
        ),
        (
            "POST",
            "/v1/sessions/a1/elicitation",
            json!({"req": 8, "epoch": EPOCH, "response": response}),
            HubRequest::AcpElicitation {
                rid: 1,
                sid: sid(),
                req: 8,
                epoch: EPOCH,
                response: response.clone(),
            },
        ),
        (
            "POST",
            "/v1/sessions/a1/mode",
            json!({"modeId": "plan"}),
            HubRequest::AcpSetMode {
                rid: 1,
                sid: sid(),
                mode_id: "plan".into(),
            },
        ),
        (
            "POST",
            "/v1/sessions/a1/revive",
            Value::Null,
            HubRequest::AcpRevive { rid: 1, sid: sid() },
        ),
        (
            "DELETE",
            "/v1/sessions/a1",
            Value::Null,
            HubRequest::AcpKill {
                rid: 1,
                sid: sid(),
                forget: false,
            },
        ),
        (
            "DELETE",
            "/v1/sessions/a1?forget=true",
            Value::Null,
            HubRequest::AcpKill {
                rid: 1,
                sid: sid(),
                forget: true,
            },
        ),
    ];
    for (method, path, body, want) in table {
        let body = match body {
            Value::Null => String::new(),
            body => body.to_string(),
        };
        let req = api.req(method, path, OWNER).body(body);
        let (hub_req, res) = api.answered(req, ok).await;
        assert_eq!(hub_req, want, "{method} {path}");
        assert_eq!(
            (res.status, res.json()),
            (200, json!({})),
            "{method} {path}"
        );
    }

    // A PTY session is ended as one. The fake hub answers `pty.kill` itself.
    let res = api
        .req("DELETE", "/v1/sessions/p1?forget=true", OWNER)
        .send()
        .await;
    assert_eq!((res.status, res.json()), (200, json!({})));
    let (_, kill) = api
        .hub
        .wait_for(|r| matches!(r, HubRequest::PtyKill { .. }))
        .await;
    assert_eq!(
        kill,
        HubRequest::PtyKill {
            rid: 1,
            sid: "p1".into(),
            forget: true
        }
    );
    let res = api.req("DELETE", "/v1/sessions/nope", OWNER).send().await;
    assert_eq!(res.status, 404);

    // The hub's refusal, with its code and the status of §3.8.1.
    let req = api
        .req("POST", "/v1/sessions/a1/prompt", OWNER)
        .body(json!({"text": "again"}).to_string());
    let (_, res) = api
        .answered(req, refusal(ErrorCode::Busy, "a turn is running"))
        .await;
    assert_eq!(res.status, 409);
    assert_eq!(
        res.json(),
        json!({"error": "a turn is running", "code": "busy"})
    );

    // Bodies that are not what the endpoint takes never reach the hub.
    let asked = api.hub.requests().len();
    let bad = [
        ("/v1/sessions/a1/prompt", json!({})),
        ("/v1/sessions/a1/prompt", json!({"text": "a", "blocks": []})),
        ("/v1/sessions/a1/prompt", json!({"text": 1})),
        (
            "/v1/sessions/a1/permission",
            json!({"req": 7, "outcome": {}}),
        ),
        (
            "/v1/sessions/a1/permission",
            json!({"req": "7", "epoch": 1, "outcome": {}}),
        ),
        ("/v1/sessions/a1/elicitation", json!({"req": 8, "epoch": 1})),
        ("/v1/sessions/a1/mode", json!({"mode_id": "plan"})),
        ("/v1/sessions/a%2Fb/cancel", json!({})),
    ];
    for (path, body) in bad {
        let res = api
            .req("POST", path, OWNER)
            .body(body.to_string())
            .send()
            .await;
        assert_eq!(res.status, 400, "{path} {body}");
    }
    let res = api
        .req("DELETE", "/v1/sessions/a1?forget=yes", OWNER)
        .send()
        .await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({"error": "bad query"}))
    );
    assert!(
        api.hub
            .requests()
            .into_iter()
            .skip(asked)
            .all(|(_, r)| matches!(r, HubRequest::Hello { .. })),
        "a refused request reached the hub"
    );
}

#[tokio::test]
async fn events_are_the_journal_after_a_seq() {
    let api = Api::start().await;
    let event = |seq: u64, text: &str| JournalEvent {
        seq,
        ts: EPOCH + seq,
        body: EventBody::Prompt {
            prompt: vec![json!({"type": "text", "text": text})],
        },
    };
    let before = api.hub.requests().len();
    let sent = tokio::spawn(
        api.req("GET", "/v1/sessions/a1/events?since=1", OWNER)
            .send(),
    );
    let (conn, hub_req) = api.asked_after(before).await;
    assert_eq!(
        hub_req,
        HubRequest::AcpOpen {
            rid: 1,
            sid: "a1".into(),
            since: 1,
            epoch: None,
            spawn: None,
        }
    );
    let mut reply = open_reply("a1", "testhost", false);
    reply.from = 2;
    api.hub.send(conn, HubMessage::ok(1, &reply));
    for (seq, text) in [(2, "two"), (3, "three")] {
        let ev = Box::new(event(seq, text));
        api.hub.send(
            conn,
            HubMessage::AcpEv {
                sid: "a1".into(),
                ev,
            },
        );
    }
    api.hub.send(
        conn,
        HubMessage::AcpReplayed {
            sid: "a1".into(),
            head: 3,
            truncated: false,
        },
    );
    let res = sent.await.unwrap();
    assert_eq!(res.status, 200);
    let body = res.json();
    assert_eq!(body["sid"], "a1");
    assert_eq!(body["epoch"], EPOCH);
    assert_eq!((&body["head"], &body["from"]), (&json!(3), &json!(2)));
    assert_eq!(
        (&body["reset"], &body["truncated"]),
        (&json!(false), &json!(false))
    );
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], serde_json::to_value(event(2, "two")).unwrap());
    assert_eq!(events[1]["seq"], 3);

    // An unknown sid is the hub's 404; a bad cursor never reaches it.
    let req = api.req("GET", "/v1/sessions/nope/events", OWNER);
    let (_, res) = api
        .answered(req, refusal(ErrorCode::NotFound, "no session nope"))
        .await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json()["code"], "not_found");
    let res = api.get("/v1/sessions/a1/events?since=x").await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({"error": "bad query"}))
    );
}

/// A `GET /v1/stream` read event by event.
struct Stream {
    tcp: TcpStream,
    /// Bytes read and not yet taken out of their chunks.
    raw: Vec<u8>,
    /// The body so far, without what `next` returned.
    body: String,
    ended: bool,
}

impl Stream {
    async fn open(api: &Api, token: &str) -> Stream {
        let mut tcp = TcpStream::connect(api.addr).await.unwrap();
        let head = format!(
            "GET /v1/stream HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\n\r\n",
            api.addr
        );
        tcp.write_all(head.as_bytes()).await.unwrap();
        let mut stream = Stream {
            tcp,
            raw: Vec::new(),
            body: String::new(),
            ended: false,
        };
        let end = loop {
            if let Some(i) = stream.raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            assert!(stream.fill().await, "the stream closed in its head");
        };
        let head = String::from_utf8(stream.raw.drain(..end + 4).collect()).unwrap();
        let head = head.to_ascii_lowercase();
        assert!(head.starts_with("http/1.1 200"), "{head}");
        assert!(head.contains("content-type: text/event-stream"), "{head}");
        assert!(head.contains("cache-control: no-store"), "{head}");
        assert!(head.contains("transfer-encoding: chunked"), "{head}");
        stream
    }

    /// Reads more bytes; false at the end of the connection.
    async fn fill(&mut self) -> bool {
        let mut buf = [0u8; 4096];
        let n = timeout(WAIT, self.tcp.read(&mut buf))
            .await
            .expect("the stream went silent")
            .unwrap();
        self.raw.extend_from_slice(&buf[..n]);
        n > 0
    }

    /// Moves every complete chunk of `raw` to `body`.
    fn dechunk(&mut self) {
        while let Some(line) = self.raw.windows(2).position(|w| w == b"\r\n") {
            let size = std::str::from_utf8(&self.raw[..line]).unwrap();
            let size = usize::from_str_radix(size.trim(), 16).unwrap();
            let end = line + 2 + size + 2;
            if self.raw.len() < end {
                return;
            }
            let chunk: Vec<u8> = self.raw.drain(..end).collect();
            self.body
                .push_str(std::str::from_utf8(&chunk[line + 2..end - 2]).unwrap());
            if size == 0 {
                self.ended = true;
                return;
            }
        }
    }

    /// The next event as its name and data; `None` once the stream has ended.
    /// Comment lines are skipped.
    async fn next(&mut self) -> Option<(String, Value)> {
        loop {
            self.dechunk();
            if let Some(end) = self.body.find("\n\n") {
                let block: String = self.body.drain(..end + 2).collect();
                let field = |name: &str| {
                    block
                        .lines()
                        .find_map(|l| l.strip_prefix(name))
                        .map(|v| v.trim_start().to_owned())
                };
                match (field("event:"), field("data:")) {
                    (Some(name), Some(data)) => {
                        return Some((name, serde_json::from_str(&data).unwrap()));
                    }
                    _ => continue,
                }
            }
            if self.ended || !self.fill().await {
                return None;
            }
        }
    }

    /// The events up to and including the next `name`.
    async fn until(&mut self, name: &str) -> Vec<(String, Value)> {
        let mut events = Vec::new();
        loop {
            let event = self.next().await.expect("the stream ended");
            let done = event.0 == name;
            events.push(event);
            if done {
                return events;
            }
        }
    }
}

#[tokio::test]
async fn the_stream_is_a_snapshot_and_then_every_change() {
    let hub = FakeHub::start();
    hub.set_sessions(vec![summary("a1", "testhost")]);
    let api = Api::without_hub(hub).await;
    api.web.wait_hub("up").await;

    let mut stream = Stream::open(&api, READER).await;
    let snapshot = stream.until("ready").await;
    let names: Vec<&str> = snapshot.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["hub", "session", "ready"]);
    assert_eq!(snapshot[0].1, json!({"status": "up"}));
    assert_eq!(snapshot[1].1["sid"], "a1");
    assert_eq!(snapshot[1].1["state"], "idle");
    assert_eq!(snapshot[2].1, json!({}));

    // A change, a new session and a forgotten one, as the hub tells its watchers.
    let mut busy = summary("a1", "testhost");
    busy.acp.as_mut().unwrap().activity = Activity::Turn;
    let session = Box::new(busy);
    api.hub.send(0, HubMessage::Session { session });
    let (name, data) = stream.next().await.unwrap();
    assert_eq!(
        (name.as_str(), &data["state"]),
        ("session", &json!("running"))
    );
    let session = Box::new(summary("a2", "laptop"));
    api.hub.send(0, HubMessage::Session { session });
    let (name, data) = stream.next().await.unwrap();
    assert_eq!(
        (name.as_str(), &data["host"]),
        ("session", &json!("laptop"))
    );
    api.hub.send(
        0,
        HubMessage::Gone {
            sid: "a2".into(),
            epoch: EPOCH,
        },
    );
    assert_eq!(
        stream.next().await.unwrap(),
        ("gone".to_owned(), json!({"sid": "a2", "epoch": EPOCH}))
    );

    // The hub goes away and comes back: `hub` each time, then its sessions again.
    api.hub.close(0);
    assert_eq!(
        stream.next().await.unwrap(),
        ("hub".to_owned(), json!({"status": "down"}))
    );
    let back = stream.until("session").await;
    assert_eq!(back[0], ("hub".to_owned(), json!({"status": "up"})));
    assert_eq!(back[1].1["sid"], "a1");

    // The stream needs the read scope, and ends when wb-web stops.
    let res = api
        .req("GET", "/v1/stream", AGENTS)
        .from(AGENTS_ADDR)
        .send()
        .await;
    assert_eq!(res.status, 403);
    let mut api = api;
    api.web.sigterm();
    assert_eq!(stream.next().await, None);
    assert!(api.web.wait_exit().await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_become_observed_sessions() {
    let mut api = Api::start().await;
    let mut stream = Stream::open(&api, READER).await;
    stream.until("ready").await;
    let post = |body: Value| {
        api.req("POST", "/v1/events", AGENTS)
            .from(AGENTS_ADDR)
            .body(body.to_string())
    };
    // A Claude Code hook's stdin, wrapped as the reporter wraps it. The host it names
    // is ignored: the client's is used.
    let claude = |name: &str, more: Value| {
        let mut payload = json!({
            "session_id": "s-1",
            "hook_event_name": name,
            "cwd": "/home/alice/proj/x",
            "transcript_path": "/home/alice/.claude/projects/x/s-1.jsonl",
        });
        payload
            .as_object_mut()
            .unwrap()
            .extend(more.as_object().unwrap().clone());
        json!({"harness": "claude", "host": "elsewhere", "wbSession": "n_1", "payload": payload})
    };
    let res = post(claude("SessionStart", json!({"source": "startup"})))
        .send()
        .await;
    assert_eq!((res.status, res.body.len()), (204, 0));
    let res = post(claude(
        "UserPromptSubmit",
        json!({"prompt": "fix the build"}),
    ))
    .send()
    .await;
    assert_eq!(res.status, 204);

    // The stream carries the record, at its latest state.
    let observed = loop {
        let (name, data) = stream.next().await.expect("the stream ended");
        if name == "observed" && data["state"] == "running" {
            break data;
        }
    };
    assert_eq!(observed["host"], "devbox");
    assert_eq!(observed["key"], "devbox/claude/s-1");
    assert_eq!(observed["wbSession"], "n_1");
    assert_eq!(observed["lastPrompt"], "fix the build");
    assert_eq!(observed["project"], "x");
    let id = observed["id"].as_str().unwrap();
    assert!(id.starts_with("o_") && id.len() == 18, "{id}");

    // Any other harness sends neutral events.
    let neutral = |kind: &str| json!({"harness": "omp", "payload": {"session_id": "p-1", "kind": kind, "text": "done"}});
    assert_eq!(post(neutral("turn_end")).send().await.status, 204);

    let list = api.req("GET", "/v1/observed", READER).send().await.json();
    let sessions = list["sessions"].as_array().unwrap();
    let mut keys: Vec<&str> = sessions
        .iter()
        .map(|s| s["key"].as_str().unwrap())
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["devbox/claude/s-1", "devbox/omp/p-1"]);
    let one = api.get(&format!("/v1/observed/{id}")).await;
    assert_eq!(one.status, 200);
    assert_eq!(one.json()["sessionId"], "s-1");
    let res = api.get("/v1/observed/o_0000000000000000").await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json(), json!({"error": "no such observed session"}));

    // Refused, and the registry is as it was.
    let bad = [
        neutral("nope"),
        json!({"harness": "Omp", "payload": {"session_id": "p-2", "kind": "start"}}),
        json!({"harness": "omp", "payload": {"session_id": "a b", "kind": "start"}}),
        json!({"harness": "omp"}),
        json!([]),
    ];
    for body in bad {
        let res = post(body.clone()).send().await;
        assert_eq!(res.status, 400, "{body}");
        assert!(res.json()["error"].is_string(), "{body}");
    }
    let res = post(json!({})).body("{").send().await;
    assert_eq!(
        (res.status, res.json()),
        (400, json!({"error": "bad body"}))
    );
    // One byte over `API_BODY_MAX`.
    let res = post(json!({})).body(vec![b' '; (1 << 20) + 1]).send().await;
    assert_eq!(res.status, 413);
    assert_eq!(res.json(), json!({"error": "request body too large"}));
    let list = api.get("/v1/observed").await.json();
    assert_eq!(list["sessions"].as_array().unwrap().len(), 2);

    // The records are on disk once wb-web has stopped.
    api.web.sigterm();
    assert!(api.web.wait_exit().await.success());
    let saved = std::fs::read(api.web.dir.path().join("state/observed.json")).unwrap();
    let saved: Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(saved["v"], 1);
    assert_eq!(saved["sessions"].as_array().unwrap().len(), 2);
}
