//! The mesh API on its own listener, against a fake hub (design §3.8.1, §3.8.2,
//! §3.8.4).
//!
//! The shared fake hub records `acp.*` requests without answering them; each test
//! answers by injecting the reply on the request's connection.

mod common;

use std::net::SocketAddr;

use common::{FakeHub, Hello, Req, Resp, WAIT, Web, next_json, pty_summary};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use wb_proto::hub::{
    AcpFacts, AcpOpenReply, AcpSessionInfo, Activity, Agent, ErrorCode, Host, HubMessage,
    HubRequest, Kind, ManagedWorktree, Pending, PendingKind, SpawnAcp, Summary, WorktreeRequest,
};
use wb_proto::journal::{EventBody, JournalEvent};
use wb_proto::policy::Policy;

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

    /// Sends `req`, answers the one action it causes with `reply(rid)`, and
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
        | HubRequest::AcpSetConfigOption { rid, .. }
        | HubRequest::AcpSetTask { rid, .. }
        | HubRequest::AcpSetPolicy { rid, .. }
        | HubRequest::AcpRevive { rid, .. }
        | HubRequest::AcpRemoveWorktree { rid, .. }
        | HubRequest::AcpKill { rid, .. }
        | HubRequest::SessionKill { rid, .. }
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
            config_options: None,
            managed_worktree: None,
            task: None,
            policy: None,
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
        config_errors: Vec::new(),
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
        (
            "POST",
            "/v1/sessions/a/config",
            READER,
            403,
            json!("forbidden"),
        ),
        (
            "POST",
            "/v1/sessions/a/task",
            READER,
            403,
            json!("forbidden"),
        ),
        (
            "POST",
            "/v1/sessions/a/policy",
            READER,
            403,
            json!("forbidden"),
        ),
        ("DELETE", "/v1/sessions/a", READER, 403, json!("forbidden")),
        (
            "DELETE",
            "/v1/sessions/a/worktree",
            READER,
            403,
            json!("forbidden"),
        ),
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
    assert_eq!(
        from_agents("POST", "/v1/sessions/a/policy")
            .body(r#"{"policy":{"rules":[]}}"#)
            .send()
            .await
            .status,
        403
    );
    assert_eq!(
        from_agents("GET", "/v1/sessions/a").send().await.status,
        403
    );
    assert_eq!(
        from_agents("GET", "/v1/sessions/a/events")
            .send()
            .await
            .status,
        403
    );

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
    let mut agent = summary("a1", "testhost");
    agent.acp.as_mut().unwrap().task = Some("workbench#44".into());
    hub.set_sessions(vec![agent, pty_summary("p1", EPOCH, true, false)]);
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
    assert_eq!(list["sessions"][0]["acp"]["task"], "workbench#44");

    let one = api.get("/v1/sessions/a1").await;
    assert_eq!(one.status, 200);
    assert_eq!(one.json()["acp"]["agent"], "claude");
    assert_eq!(one.json()["acp"]["task"], "workbench#44");
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

/// `API_CONNS_MAX`: the connections the API holds at a time.
const CONNS_MAX: usize = 256;

#[tokio::test]
async fn idle_connections_fill_the_api_and_nothing_else() {
    let api = Api::start().await;
    let mut idle = Vec::new();
    for _ in 0..CONNS_MAX {
        idle.push(TcpStream::connect(api.addr).await.unwrap());
    }
    // The first of them does answer, so all of them are held.
    let first = &mut idle[0];
    let head = format!("GET /v1/info HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {OWNER}\r\n\r\n");
    first.write_all(head.as_bytes()).await.unwrap();
    let mut buf = [0; 12];
    timeout(WAIT, first.read_exact(&mut buf))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&buf, b"HTTP/1.1 200");

    // One more waits, and meanwhile the browser's listener answers.
    let mut waiting = tokio::spawn(api.req("GET", "/v1/info", OWNER).send());
    let early = timeout(std::time::Duration::from_millis(300), &mut waiting).await;
    assert!(early.is_err(), "a connection over the cap was served");
    assert_eq!(api.web.req("GET", "/api/info").send().await.status, 200);

    // It is served once another connection ends.
    idle.pop();
    assert_eq!(timeout(WAIT, waiting).await.unwrap().unwrap().status, 200);
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
        ("POST", "/v1/sessions/a1/epochs/7/cancel"),
        ("DELETE", "/v1/sessions/a1"),
        ("DELETE", "/v1/sessions/a1/epochs/7"),
        ("DELETE", "/v1/sessions/a1/worktree"),
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
            config: Vec::new(),
            worktree: None,
            task: None,
            policy: None,
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
        (
            json!({"agent": "claude", "cwd": "/x", "config": []}),
            "bad body",
        ),
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
async fn worktree_spawns_pass_names_and_return_the_hubs_record() {
    let api = Api::start().await;
    let branch = "feature/a";
    let main_root = "/srv/project";
    let path = "/srv/project-wt/feature-a";
    for (host, base) in [(None, None), (Some("testhost"), Some("origin/main"))] {
        let mut body = json!({
            "agent": "claude", "cwd": "/srv/project/subdir", "sid": "mine",
            "worktree": {"branch": branch}
        });
        if let Some(host) = host {
            body["host"] = json!(host);
        }
        if let Some(base) = base {
            body["worktree"]["base"] = json!(base);
        }
        let req = api
            .req("POST", "/v1/sessions", OWNER)
            .body(body.to_string());
        let (asked, res) = api
            .answered(req, |rid| {
                let mut reply = open_reply("mine", "testhost", true);
                reply.summary.cwd = path.into();
                reply.summary.acp.as_mut().unwrap().managed_worktree = Some(ManagedWorktree {
                    path: path.into(),
                    branch: branch.into(),
                    main_root: main_root.into(),
                });
                HubMessage::ok(rid, &reply)
            })
            .await;
        let HubRequest::AcpOpen {
            spawn: Some(spawn), ..
        } = asked
        else {
            panic!("{asked:?}");
        };
        assert_eq!(spawn.host, None);
        assert_eq!(spawn.cwd, "/srv/project/subdir");
        assert_eq!(
            spawn.worktree,
            Some(WorktreeRequest {
                branch: branch.into(),
                base: base.map(str::to_owned)
            })
        );
        assert_eq!(res.status, 201);
        let session = &res.json()["session"];
        assert_eq!(session["cwd"], path);
        assert_eq!(
            session["acp"]["managedWorktree"],
            json!({"path": path, "branch": branch, "mainRoot": main_root})
        );
        // The separate, derived top-level field is still present, null when uncached.
        assert_eq!(session.get("worktree"), Some(&Value::Null));
    }
    let req = api.req("POST", "/v1/sessions", OWNER).body(
        json!({"agent": "claude", "cwd": main_root, "worktree": {"branch": branch}}).to_string(),
    );
    let (_, res) = api
        .answered(
            req,
            refusal(ErrorCode::Conflict, "branch already checked out"),
        )
        .await;
    assert_eq!(res.status, 409);
    assert_eq!(
        res.json(),
        json!({"error": "branch already checked out", "code": "conflict"})
    );
}

#[tokio::test]
async fn worktree_actions_require_the_current_hubs_capability() {
    for advertised in [None, Some(false)] {
        let api = Api::start_with(Hello {
            acp_worktree: advertised,
            ..Hello::default()
        })
        .await;
        let post = |body: Value| {
            api.req("POST", "/v1/sessions", OWNER)
                .body(body.to_string())
        };
        for req in [
            post(json!({"agent": "claude", "cwd": "/x", "worktree": {"branch": "topic"}})),
            api.req("DELETE", "/v1/sessions/a/worktree", OWNER),
        ] {
            let res = req.send().await;
            assert_eq!(res.status, 400);
            assert_eq!(
                res.json()["error"],
                "hub does not support managed worktrees"
            );
        }
        assert!(
            api.hub
                .requests()
                .iter()
                .all(|(_, r)| matches!(r, HubRequest::Hello { .. } | HubRequest::Watch { .. }))
        );
        // A hub without worktrees can still start an ordinary session.
        let (asked, res) = api
            .answered(
                post(json!({"agent": "claude", "cwd": "/x", "sid": "a"})),
                |rid| HubMessage::ok(rid, &open_reply("a", "testhost", true)),
            )
            .await;
        assert!(matches!(
            asked,
            HubRequest::AcpOpen {
                spawn: Some(SpawnAcp { worktree: None, .. }),
                ..
            }
        ));
        assert_eq!(res.status, 201);
        assert!(
            res.json()["session"]["acp"]
                .get("managedWorktree")
                .is_none()
        );
    }
}

#[tokio::test]
async fn invalid_and_remote_worktree_spawns_are_not_sent() {
    let api = Api::start_with(Hello {
        hosts: vec![Host {
            name: "laptop".into(),
            agents: Vec::new(),
        }],
        ..Hello::default()
    })
    .await;
    let post = |body: Value| {
        api.req("POST", "/v1/sessions", OWNER)
            .body(body.to_string())
    };
    for worktree in [
        Value::Null,
        json!("topic"),
        json!(["topic", "main"]),
        json!({}),
        json!({"branch": 1}),
        json!({"branch": "topic", "base": null}),
        json!({"branch": "topic", "path": "/caller/path"}),
    ] {
        let res = post(json!({"agent": "claude", "cwd": "/x", "worktree": worktree}))
            .send()
            .await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "bad body"})),
            "{worktree}"
        );
    }
    for worktree in [
        json!({"branch": "-bad"}),
        json!({"branch": "topic", "base": "a..b"}),
    ] {
        let res = post(json!({"agent": "claude", "cwd": "/x", "worktree": worktree}))
            .send()
            .await;
        assert_eq!(res.status, 400, "{worktree}");
        assert_eq!(res.json()["code"], "bad_request");
    }
    let res = post(json!({
        "agent": "claude", "cwd": "/x", "host": "laptop", "worktree": {"branch": "topic"}
    }))
    .send()
    .await;
    assert_eq!(res.status, 400);
    assert_eq!(
        res.json()["error"],
        "managed worktrees require a local host"
    );
    assert!(
        api.hub
            .requests()
            .iter()
            .all(|(_, r)| matches!(r, HubRequest::Hello { .. } | HubRequest::Watch { .. }))
    );
}

#[tokio::test]
async fn startup_configuration_requires_the_hubs_advertised_support() {
    let api = Api::start_with(Hello {
        acp_config: None,
        ..Hello::default()
    })
    .await;
    let before = api.hub.requests().len();
    let res = api
        .req("POST", "/v1/sessions", OWNER)
        .body(
            json!({"agent": "claude", "cwd": "/x", "sid": "old",
                     "config": {"model": "large"}})
            .to_string(),
        )
        .send()
        .await;
    assert_eq!(
        (res.status, res.json()),
        (
            400,
            json!({
                "error": "hub does not support session configuration"
            })
        )
    );
    assert!(
        api.hub
            .requests()
            .into_iter()
            .skip(before)
            .all(|(_, r)| matches!(r, HubRequest::Hello { .. }))
    );

    for config in [None, Some(json!({}))] {
        let mut body = json!({"agent": "claude", "cwd": "/x", "sid": "old"});
        if let Some(config) = config {
            body["config"] = config;
        }
        let (_, res) = api
            .answered(
                api.req("POST", "/v1/sessions", OWNER)
                    .body(body.to_string()),
                |rid| HubMessage::ok(rid, &open_reply("old", "testhost", true)),
            )
            .await;
        assert_eq!(res.status, 201);
        assert_eq!(res.json()["configErrors"], json!([]));
    }
}

#[tokio::test]
async fn task_references_are_normalized_on_create_set_and_clear() {
    let api = Api::start().await;
    let req = api.req("POST", "/v1/sessions", OWNER).body(
        json!({"agent": "claude", "cwd": "/x", "sid": "mine", "task": "  workbench#44  "})
            .to_string(),
    );
    let (request, res) = api
        .answered(req, |rid| {
            let mut reply = open_reply("mine", "testhost", true);
            reply.summary.acp.as_mut().unwrap().task = Some("workbench#44".into());
            HubMessage::ok(rid, &reply)
        })
        .await;
    let HubRequest::AcpOpen {
        spawn: Some(spawn), ..
    } = request
    else {
        panic!("{request:?}");
    };
    assert_eq!(spawn.task.as_deref(), Some("workbench#44"));
    assert_eq!(res.status, 201);
    assert_eq!(res.json()["session"]["acp"]["task"], "workbench#44");

    for (task, expected) in [
        (json!("  issue 45  "), Some("issue 45")),
        (json!("   "), None),
        (json!(""), None),
        (Value::Null, None),
    ] {
        let req = api
            .req("POST", "/v1/sessions/mine/task", OWNER)
            .body(json!({"task": task}).to_string());
        let (request, res) = api.answered(req, ok).await;
        assert_eq!(
            request,
            HubRequest::AcpSetTask {
                rid: 1,
                sid: "mine".into(),
                task: expected.map(str::to_owned),
            }
        );
        assert_eq!((res.status, res.json()), (200, json!({})));
    }

    for (sid, code, status) in [
        ("gone", ErrorCode::NotFound, 404),
        ("pty", ErrorCode::KindMismatch, 409),
    ] {
        let req = api
            .req("POST", &format!("/v1/sessions/{sid}/task"), OWNER)
            .body(r#"{"task":"issue 45"}"#);
        let (_, res) = api.answered(req, refusal(code, "refused")).await;
        assert_eq!(res.status, status);
        assert_eq!(res.json(), json!({"error": "refused", "code": code}));
    }
}

#[tokio::test]
async fn invalid_task_references_do_not_reach_the_hub() {
    let api = Api::start().await;
    let before = api.hub.requests().len();
    for task in [
        json!(false),
        json!(["issue 44"]),
        json!("é".repeat(257)),
        json!("\nissue 44"),
        json!("issue\u{7f}44"),
        json!("https://example.test/\u{202e}44"),
    ] {
        for (path, body) in [
            (
                "/v1/sessions",
                json!({"agent": "claude", "cwd": "/x", "task": task}),
            ),
            ("/v1/sessions/mine/task", json!({"task": task})),
        ] {
            let req = api.req("POST", path, OWNER).body(body.to_string());
            assert_eq!(req.send().await.status, 400, "{path} {body}");
        }
    }
    for body in [json!({}), json!([null]), json!({"task": null, "extra": 1})] {
        let req = api
            .req("POST", "/v1/sessions/mine/task", OWNER)
            .body(body.to_string());
        assert_eq!(req.send().await.status, 400, "{body}");
    }
    assert_eq!(api.hub.requests().len(), before);
}

#[tokio::test]
async fn tasks_require_support_on_the_connection_used_for_the_request() {
    let api = Api::start().await; // Control's hello advertised acpTask.
    for acp_task in [None, Some(false)] {
        api.hub.set_hello(Hello {
            acp_task,
            ..Hello::default()
        });
        let before = api.hub.requests().len();
        for (path, body) in [
            (
                "/v1/sessions",
                json!({"agent": "claude", "cwd": "/x", "task": "issue 44"}),
            ),
            ("/v1/sessions/mine/task", json!({"task": "issue 44"})),
            ("/v1/sessions/mine/task", json!({"task": null})),
            ("/v1/sessions/mine/task", json!({"task": "   "})),
        ] {
            let res = api
                .req("POST", path, OWNER)
                .body(body.to_string())
                .send()
                .await;
            assert_eq!(
                (res.status, res.json()),
                (400, json!({"error": "hub does not support session tasks"}))
            );
        }
        assert!(
            api.hub
                .requests()
                .into_iter()
                .skip(before)
                .all(|(_, r)| matches!(r, HubRequest::Hello { .. }))
        );
    }

    // With no initial reference there is no feature to require.
    for task in [None, Some(Value::Null), Some(json!("  "))] {
        let mut body = json!({"agent": "claude", "cwd": "/x", "sid": "mine"});
        if let Some(task) = task {
            body["task"] = task;
        }
        let (request, res) = api
            .answered(
                api.req("POST", "/v1/sessions", OWNER)
                    .body(body.to_string()),
                |rid| HubMessage::ok(rid, &open_reply("mine", "testhost", true)),
            )
            .await;
        assert!(matches!(request, HubRequest::AcpOpen { spawn: Some(s), .. } if s.task.is_none()));
        assert_eq!(res.status, 201);
        assert!(res.json()["session"]["acp"].get("task").is_none());
    }
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
    let hub = FakeHub::start_with(Hello {
        session_action_epoch: None,
        ..Hello::default()
    });
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
                epoch: None,
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
                epoch: None,
                prompt: blocks.as_array().unwrap().clone(),
            },
        ),
        (
            "POST",
            "/v1/sessions/a1/cancel",
            Value::Null,
            HubRequest::AcpCancel {
                rid: 1,
                sid: sid(),
                epoch: None,
            },
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
                epoch: None,
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
            "/v1/sessions/a1/worktree",
            Value::Null,
            HubRequest::AcpRemoveWorktree { rid: 1, sid: sid() },
        ),
        (
            "DELETE",
            "/v1/sessions/a1",
            Value::Null,
            HubRequest::AcpKill {
                rid: 1,
                sid: sid(),
                epoch: None,
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
                epoch: None,
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
            epoch: None,
            forget: true
        }
    );
    // An unpublished sid can be an in-flight worktree creation: ask its actor.
    let req = api.req("DELETE", "/v1/sessions/nope", OWNER);
    let (kill, res) = api
        .answered(req, refusal(ErrorCode::NotFound, "no session nope"))
        .await;
    assert!(matches!(kill, HubRequest::AcpKill { sid, .. } if sid == "nope"));
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
    for (code, status, message) in [
        (ErrorCode::Conflict, 409, "worktree is not clean"),
        (ErrorCode::NotFound, 404, "no managed worktree"),
    ] {
        let req = api.req("DELETE", "/v1/sessions/a1/worktree", OWNER);
        let (_, res) = api.answered(req, refusal(code, message)).await;
        assert_eq!(res.status, status);
        assert_eq!(res.json(), json!({"code": code, "error": message}));
    }

    // Bodies that are not what the endpoint takes never reach the hub.
    let asked = api.hub.requests().len();
    let bad = [
        ("/v1/sessions/a1/prompt", json!({})),
        ("/v1/sessions/a1/prompt", json!({"text": "a", "blocks": []})),
        ("/v1/sessions/a1/prompt", json!({"text": 1})),
        (
            "/v1/sessions/a1/prompt",
            json!({"text": "a", "epoch": null}),
        ),
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
        (
            "/v1/sessions/a1/mode",
            json!({"modeId": "plan", "epoch": null}),
        ),
        ("/v1/sessions/a1/config", json!({"value": "other"})),
        (
            "/v1/sessions/a1/config",
            json!({"id": "model", "value": "other", "extra": 1}),
        ),
        (
            "/v1/sessions/a1/config",
            json!({"id": "model", "value": "other", "epoch": null}),
        ),
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
    for (method, path) in [
        ("DELETE", "/v1/sessions/a1?forget=yes"),
        ("DELETE", "/v1/sessions/a1?epoch="),
        ("POST", "/v1/sessions/a1/cancel?epoch=-1"),
    ] {
        let res = api.req(method, path, OWNER).send().await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "bad query"}))
        );
    }
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
async fn start_config_refuses_duplicate_ids_and_more_than_sixteen_members() {
    let api = Api::start().await;
    let before = api.hub.requests().len();
    let too_many = (0..17)
        .map(|i| format!(r#""option{i}":"value""#))
        .collect::<Vec<_>>()
        .join(",");
    let bad_configs = [
        format!("{{{too_many}}}"),
        r#"{"model":"small","model":"large"}"#.into(),
        r#"{"model":"small","effort":"low","model":"large"}"#.into(),
        "null".into(),
        "[]".into(),
    ];
    for config in bad_configs {
        let res = api
            .req("POST", "/v1/sessions", OWNER)
            .body(format!(
                r#"{{"agent":"claude","cwd":"/x","sid":"mine","config":{config}}}"#
            ))
            .send()
            .await;
        assert_eq!((res.status, res.json()), (400, json!({"error":"bad body"})));
    }
    assert!(
        api.hub
            .requests()
            .into_iter()
            .skip(before)
            .all(|(_, request)| matches!(request, HubRequest::Hello { .. })),
        "an invalid config reached the hub"
    );

    let sixteen = (0..16)
        .map(|i| format!(r#""option{i}":true"#))
        .collect::<Vec<_>>()
        .join(",");
    let req = api.req("POST", "/v1/sessions", OWNER).body(format!(
        r#"{{"agent":"claude","cwd":"/x","sid":"mine","config":{{{sixteen}}}}}"#
    ));
    let (_, res) = api
        .answered(req, |rid| {
            HubMessage::ok(rid, &open_reply("mine", "testhost", true))
        })
        .await;
    assert_eq!(res.status, 201);
}

#[tokio::test]
async fn config_values_must_be_strings_or_booleans_before_reaching_the_hub() {
    let api = Api::start().await;
    let before = api.hub.requests().len();
    for value in ["123", "1.5", "null", "[]", r#"{"nested":"value"}"#] {
        for (path, body) in [
            (
                "/v1/sessions",
                format!(
                    r#"{{"agent":"claude","cwd":"/x","sid":"mine","config":{{"model":{value}}}}}"#
                ),
            ),
            (
                "/v1/sessions/a1/config",
                format!(r#"{{"id":"model","value":{value}}}"#),
            ),
        ] {
            let res = api.req("POST", path, OWNER).body(body).send().await;
            assert_eq!((res.status, res.json()), (400, json!({"error":"bad body"})));
        }
    }
    assert!(
        api.hub
            .requests()
            .into_iter()
            .skip(before)
            .all(|(_, request)| matches!(request, HubRequest::Hello { .. })),
        "an invalid value reached the hub"
    );
}

#[tokio::test]
async fn live_config_preserves_agent_errors_and_exposes_current_options() {
    let hub = FakeHub::start();
    let mut current = summary("a1", "testhost");
    current.acp.as_mut().unwrap().config_options = Some(json!([
        {"id":"model","currentValue":"default"}
    ]));
    hub.set_sessions(vec![current]);
    let api = Api::without_hub(hub).await;
    api.web.wait_hub("up").await;
    assert_eq!(
        api.get("/v1/sessions/a1").await.json()["acp"]["configOptions"],
        json!([
            {"id":"model","currentValue":"default"}
        ])
    );
    for (code, status) in [
        (ErrorCode::BadOption, 400),
        (ErrorCode::AgentError, 502),
        (ErrorCode::Stale, 409),
        (ErrorCode::Timeout, 504),
    ] {
        let req = api
            .req("POST", "/v1/sessions/a1/config", OWNER)
            .body(json!({"id":"model","value":"other"}).to_string());
        let (_, res) = api.answered(req, refusal(code, "refused")).await;
        assert_eq!(res.status, status);
        assert_eq!(res.json(), json!({"error":"refused","code":code}));
    }
}

// Method, path, body, and wire operation for a caller that observed epoch 7.
const GUARDED_ACTIONS: &[(&str, &str, &str, &str)] = &[
    (
        "DELETE",
        "/v1/sessions/p1/epochs/7?forget=true",
        "",
        "session.kill",
    ),
    (
        "POST",
        "/v1/sessions/a1/epochs/7/cancel",
        "ignored body",
        "acp.cancel",
    ),
    (
        "POST",
        "/v1/sessions/a1/prompt",
        r#"{"text":"go","epoch":7}"#,
        "acp.prompt",
    ),
    (
        "POST",
        "/v1/sessions/a1/mode",
        r#"{"modeId":"plan","epoch":7}"#,
        "acp.set_mode",
    ),
    (
        "POST",
        "/v1/sessions/a1/config",
        r#"{"id":"model","value":"other","epoch":7}"#,
        "acp.set_config_option",
    ),
    (
        "DELETE",
        "/v1/sessions/a1/epochs/7?forget=true",
        "",
        "session.kill",
    ),
];

async fn action_epoch_api() -> Api {
    let hub = FakeHub::start();
    hub.set_sessions(vec![
        summary("a1", "testhost"),
        pty_summary("p1", EPOCH, true, false),
    ]);
    let api = Api::without_hub(hub).await;
    api.web.wait_hub("up").await;
    api
}

#[tokio::test]
async fn incarnation_paths_require_control_before_reaching_the_hub() {
    let api = action_epoch_api().await;
    let before = api.hub.requests().len();
    for (method, path) in [
        ("POST", "/v1/sessions/a1/epochs/7/cancel"),
        ("DELETE", "/v1/sessions/a1/epochs/7"),
    ] {
        let res = api.req(method, path, READER).send().await;
        assert_eq!(res.status, 403, "{path}");
    }
    assert_eq!(api.hub.requests().len(), before);
}

#[tokio::test]
async fn session_action_epoch_paths_reject_bad_parameters_before_connecting() {
    let api = action_epoch_api().await;
    let before = api.hub.requests().len();
    for (method, path) in [
        // The old query spelling must never degrade to an unguarded action.
        ("DELETE", "/v1/sessions/p1?forget=true&epoch=7"),
        ("POST", "/v1/sessions/a1/cancel?epoch=7"),
        ("DELETE", "/v1/sessions/a1/epochs/18446744073709551616"),
        ("DELETE", "/v1/sessions/a1/epochs/0?forget=yes"),
        ("POST", "/v1/sessions/a1/epochs/-1/cancel"),
        ("POST", "/v1/sessions/a1/epochs/1.5/cancel"),
        ("DELETE", "/v1/sessions/a%2Fb/epochs/7"),
        ("POST", "/v1/sessions/a%2Fb/epochs/7/cancel"),
    ] {
        let res = api.req(method, path, OWNER).send().await;
        assert_eq!(res.status, 400, "{path}");
    }
    assert_eq!(api.hub.requests().len(), before);
}

#[tokio::test]
async fn guarded_delete_ignores_a_stale_or_absent_watch_entry() {
    let api = action_epoch_api().await;
    // The fake hub now has an ACP at p1, but has not pushed the change to the watch.
    let mut replacement = summary("p1", "testhost");
    replacement.created_at = u64::MAX;
    replacement.updated_at = u64::MAX;
    api.hub.set_sessions(vec![replacement]);
    let watched = api.get("/v1/sessions/p1").await.json();
    assert_eq!(watched["kind"], "pty");
    assert_eq!(watched["createdAt"], EPOCH);
    let req = api.req(
        "DELETE",
        "/v1/sessions/p1/epochs/18446744073709551615",
        OWNER,
    );
    let (kill, res) = api.answered(req, ok).await;
    assert_eq!((res.status, res.json()), (200, json!({})));
    assert_eq!(
        kill,
        HubRequest::SessionKill {
            rid: 1,
            sid: "p1".into(),
            epoch: u64::MAX,
            forget: false,
        }
    );

    let req = api.req("DELETE", "/v1/sessions/unseen/epochs/0", OWNER);
    let (kill, res) = api
        .answered(req, refusal(ErrorCode::NotFound, "no session unseen"))
        .await;
    assert_eq!(res.status, 404);
    assert_eq!(res.json()["code"], "not_found");
    assert!(matches!(kill, HubRequest::SessionKill { sid, epoch: 0, .. } if sid == "unseen"));
}

/// Each guarded HTTP action names the epoch the caller saw, not a newer one
/// that happens to be in the session list.
#[tokio::test]
async fn session_action_epoch_reaches_the_hub_and_preserves_stale() {
    let api = action_epoch_api().await;
    for &(method, path, body, tag) in GUARDED_ACTIONS {
        let call = api.req(method, path, OWNER).body(body);
        let (req, res) = api
            .answered(call, refusal(ErrorCode::Stale, "replaced"))
            .await;
        assert_eq!(res.status, 409);
        assert_eq!(res.json(), json!({"error":"replaced","code":"stale"}));
        let wire = serde_json::to_value(req).unwrap();
        assert_eq!(wire["t"], tag);
        assert_eq!(wire["epoch"], 7, "{path}");
        if tag == "acp.set_config_option" {
            assert_eq!(wire["checkEpochFirst"], true);
        }
        if tag.ends_with(".kill") {
            assert_eq!(wire["forget"], true);
        }
    }

    // A caller-supplied config epoch does not require a watch entry at all.
    let (req, res) = api
        .answered(
            api.req("POST", "/v1/sessions/unseen/config", OWNER)
                .body(r#"{"id":"model","value":"other","epoch":7}"#),
            ok,
        )
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(serde_json::to_value(req).unwrap()["epoch"], 7);
}

#[tokio::test]
async fn session_action_epoch_requires_support_on_the_request_connection() {
    let api = action_epoch_api().await;
    for session_action_epoch in [None, Some(false)] {
        // The watch connection advertised support; the per-request hub does not.
        api.hub.set_hello(Hello {
            session_action_epoch,
            ..Hello::default()
        });
        let before = api.hub.requests().len();
        for &(method, path, body, _) in GUARDED_ACTIONS {
            let res = api.req(method, path, OWNER).body(body).send().await;
            assert_eq!(res.status, 400, "{path}");
            assert_eq!(
                res.json(),
                json!({"error":"hub does not support session action epochs"})
            );
        }
        assert!(
            api.hub
                .requests()
                .into_iter()
                .skip(before)
                .all(|(_, r)| matches!(r, HubRequest::Hello { .. }))
        );
    }

    // A legacy cancel ignores even a body containing an epoch. Legacy config
    // still snapshots createdAt and uses the hub's normal validation order.
    let (cancel, res) = api
        .answered(
            api.req("POST", "/v1/sessions/a1/cancel", OWNER)
                .body(r#"{"epoch":7}"#),
            ok,
        )
        .await;
    assert_eq!(res.status, 200);
    assert!(serde_json::to_value(cancel).unwrap().get("epoch").is_none());
    let (config, res) = api
        .answered(
            api.req("POST", "/v1/sessions/a1/config", OWNER)
                .body(r#"{"id":"model","value":"other"}"#),
            ok,
        )
        .await;
    assert_eq!(res.status, 200);
    let wire = serde_json::to_value(config).unwrap();
    assert_eq!(wire["epoch"], EPOCH);
    assert!(wire.get("checkEpochFirst").is_none());
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
        api.req("GET", "/v1/sessions/a1/events?since=1", READER)
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

/// Reads `ws` until a message with `t == want` arrives; the others are skipped.
async fn rpc_until(ws: &mut common::Ws, want: &str) -> Value {
    loop {
        let msg = next_json(ws).await;
        if msg["t"] == want {
            return msg;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rpc_carries_the_observed_sessions() {
    let api = Api::start().await;
    let mut rpc = api.web.ws("/rpc").await;
    assert_eq!(rpc_until(&mut rpc, "observed").await["sessions"], json!([]));

    let event = json!({"harness": "pi", "payload": {"session_id": "s1", "kind": "prompt", "text": "hello"}});
    let res = api
        .req("POST", "/v1/events", AGENTS)
        .from(AGENTS_ADDR)
        .body(event.to_string())
        .send()
        .await;
    assert_eq!(res.status, 204);
    let put = rpc_until(&mut rpc, "observed_put").await;
    assert_eq!(put["session"]["key"], "devbox/pi/s1");
    assert_eq!(put["session"]["host"], "devbox");

    let mut late = api.web.ws("/rpc").await;
    let snapshot = rpc_until(&mut late, "observed").await;
    assert_eq!(snapshot["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["sessions"][0]["key"], "devbox/pi/s1");

    let info = api.web.req("GET", "/api/info").send().await.json();
    assert_eq!(info["mesh"], true);
}

fn session_policy() -> Value {
    json!({"rules": [
        {"action": "allow", "kinds": ["read"], "roots": ["$cwd", "/srv/shared"]},
        {
            "action": "reject",
            "kinds": ["execute"],
            "roots": ["$cwd"],
            "programs": ["git", "/usr/bin/git", "./tools/git"],
            "command": {"matches": ["^git\\s"], "notMatches": ["--force"]}
        },
        {"action": "ask"}
    ]})
}

#[tokio::test]
async fn invalid_policies_are_bad_bodies_before_any_hub_connection() {
    let api = Api::start().await;
    let before = api.hub.requests().len();
    let mut invalid = vec![
        Value::Null,
        json!([]),
        json!({}),
        json!({"rules": null}),
        json!({"rules": [], "extra": true}),
        json!({"rules": [{"action": "allow", "extra": true}]}),
        json!({"rules": [{"action": "ALLOW"}]}),
        json!({"rules": [{"action": "deny"}]}),
        json!({"rules": [{"action": "allow", "roots": null}]}),
        json!({"rules": [{"action": "allow", "kinds": null}]}),
        json!({"rules": [{"action": "allow", "command": null}]}),
        json!({"rules": [{"action": "allow", "roots": "relative"}]}),
        json!({"rules": [{"action": "allow", "roots": ["relative"]}]}),
        json!({"rules": [{"action": "allow", "roots": ["$cwd/child"]}]}),
        json!({"rules": [{"action": "allow", "roots": [""]}]}),
        json!({"rules": [{"action": "allow", "roots": ["/a\u{0}b"]}]}),
        json!({"rules": [{"action": "allow", "roots": [1]}]}),
        json!({"rules": [{"action": "allow", "kinds": [""]}]}),
        json!({"rules": [{"action": "allow", "kinds": ["a\u{0}b"]}]}),
        json!({"rules": [{"action": "allow", "kinds": ["a".repeat(65)]}]}),
        json!({"rules": [{"action": "allow", "kinds": "read"}]}),
        json!({"rules": [{"action": "allow", "programs": null}]}),
        json!({"rules": [{"action": "allow", "programs": "git"}]}),
        json!({"rules": [{"action": "allow", "programs": [1]}]}),
        json!({"rules": [{"action": "allow", "programs": [""]}]}),
        json!({"rules": [{"action": "allow", "programs": ["a\u{0}b"]}]}),
        json!({"rules": [{"action": "allow", "programs": ["x".repeat(257)]}]}),
        json!({"rules": [{"action": "allow", "programs": ["é".repeat(129)]}]}),
        json!({"rules": [{"action": "allow", "programs": vec!["git"; 65]}]}),
        json!({"rules": [{
            "action": "allow", "kinds": ["execute"], "command": {"unknown": []}
        }]}),
        json!({"rules": [{
            "action": "allow", "command": {"not_matches": ["danger"]}
        }]}),
        json!({"rules": [{
            "action": "allow", "command": {"matches": null}
        }]}),
        json!({"rules": [{
            "action": "allow", "command": {"notMatches": ["é".repeat(2049)]}
        }]}),
        json!({"rules": [{
            "action": "allow", "kinds": ["execute"], "command": {"matches": ["["]}
        }]}),
        json!({"rules": [{
            "action": "allow", "kinds": ["execute"], "command": {"notMatches": ["("]}
        }]}),
        json!({"rules": [{
            "action": "allow", "kinds": ["execute"], "command": {"matches": ["x".repeat(4097)]}
        }]}),
        json!({"rules": [{"action":"allow", "roots":[format!("/{}", "r".repeat(4096))]}]}),
        json!({"rules": [{"action":"allow", "roots":vec![format!("/{}", "r".repeat(4095));64]}]}),
        json!({"rules": [{"action":"allow", "command":{"notMatches":["a[a-z]{3637}0"]}}]}),
        json!({"rules": [{"action":"allow", "command":{"notMatches":["[ab]*a[ab]{3635}c"]}}]}),
        json!({"rules": vec![json!({"action": "ask"}); 65]}),
        json!({"rules": [{
            "action": "allow",
            "roots": (0..65).map(|i| format!("/root{i}")).collect::<Vec<_>>()
        }]}),
        json!({"rules": [{
            "action": "allow",
            "kinds": (0..65).map(|i| format!("kind{i}")).collect::<Vec<_>>()
        }]}),
        json!({"rules": [{
            "action": "allow", "kinds": ["execute"],
            "command": {"matches": vec!["x"; 65], "notMatches": vec!["y"; 64]}
        }]}),
    ];
    for program in [
        " git",
        "git ",
        "git\tstatus",
        "git\nstatus",
        "git\u{a0}status",
        "git\u{2003}status",
    ] {
        invalid.push(json!({"rules": [{"action": "allow", "programs": [program]}]}));
    }
    invalid.push(json!({"rules": [
        {"action": "allow", "kinds": ["execute"], "command": {"matches": vec!["x"; 64]}},
        {"action": "reject", "kinds": ["execute"], "command": {"notMatches": vec!["y"; 65]}}
    ]}));
    for policy in invalid {
        let endpoints = [
            ("/v1/sessions/a1/policy", json!({"policy": policy})),
            (
                "/v1/sessions",
                json!({"agent": "claude", "cwd": "/srv/x", "sid": "mine", "policy": policy}),
            ),
        ];
        for (path, body) in endpoints {
            let res = api
                .req("POST", path, OWNER)
                .body(body.to_string())
                .send()
                .await;
            assert_eq!(
                (res.status, res.json()),
                (400, json!({"error": "bad body"})),
                "{path}: {body}"
            );
        }
    }
    for body in [
        json!({}),
        json!({"policy": {"rules": []}, "epoch": EPOCH}),
        json!({"policy": {"rules": []}, "extra": true}),
    ] {
        let res = api
            .req("POST", "/v1/sessions/a1/policy", OWNER)
            .body(body.to_string())
            .send()
            .await;
        assert_eq!(
            (res.status, res.json()),
            (400, json!({"error": "bad body"}))
        );
    }
    assert_eq!(
        api.hub.requests().len(),
        before,
        "an invalid policy opened a hub connection"
    );
}

#[tokio::test]
async fn spawn_policy_bodies_accept_valid_conditions_and_boundary_values() {
    let api = Api::start().await;
    let policies = [
        session_policy(),
        json!({"rules": []}),
        json!({"rules": [{"action": "allow", "command": {"matches": ["^safe"]}}]}),
        json!({"rules": [{"action": "allow", "programs": []}]}),
        json!({"rules": [{"action": "allow", "programs": ["x", "é".repeat(128)]}]}),
        json!({"rules": [{
            "action": "allow",
            "programs": (0..64).map(|i| format!("program{i}")).collect::<Vec<_>>()
        }]}),
        json!({"rules": [{
            "action": "allow", "kinds": ["read", "edit", "execute"],
            "command": {"notMatches": ["danger"]}
        }]}),
        json!({"rules": vec![json!({"action": "ask"}); 64]}),
        json!({"rules": [{
            "action": "allow",
            "roots": (0..64).map(|i| format!("/root{i}")).collect::<Vec<_>>(),
            "kinds": (0..64).map(|i| format!("kind{i}")).collect::<Vec<_>>()
        }]}),
        json!({"rules": [{
            "action": "allow", "kinds": ["execute"],
            "command": {"matches": vec!["x"; 64], "notMatches": vec!["y"; 64]}
        }]}),
    ];
    for policy in policies {
        let req = api.req("POST", "/v1/sessions", OWNER).body(
            json!({
                "agent": "claude", "cwd": "/srv/x", "sid": "mine", "policy": policy
            })
            .to_string(),
        );
        let (hub_req, res) = api
            .answered(req, |rid| {
                HubMessage::ok(rid, &open_reply("mine", "testhost", true))
            })
            .await;
        assert_eq!(res.status, 201);
        let HubRequest::AcpOpen {
            spawn: Some(spawn), ..
        } = hub_req
        else {
            panic!("{hub_req:?}");
        };
        assert_eq!(serde_json::to_value(spawn.policy).unwrap(), policy);
    }
}

#[tokio::test]
async fn replacing_policy_uses_the_current_epoch_and_preserves_hub_errors() {
    let hub = FakeHub::start();
    let mut current = summary("a1", "testhost");
    current.created_at = EPOCH + 100;
    let pending = Pending {
        req: 2,
        kind: PendingKind::Permission,
        title: "Already waiting".into(),
        ts: EPOCH + 1,
    };
    current.acp.as_mut().unwrap().pending.push(pending.clone());
    hub.set_sessions(vec![current]);
    let api = Api::without_hub(hub).await;
    api.web.wait_hub("up").await;

    for policy in [session_policy(), json!({"rules": []})] {
        let req = api
            .req("POST", "/v1/sessions/a1/policy", OWNER)
            .body(json!({"policy": policy}).to_string());
        let (hub_req, res) = api.answered(req, ok).await;
        assert_eq!(
            hub_req,
            HubRequest::AcpSetPolicy {
                rid: 1,
                sid: "a1".into(),
                epoch: EPOCH + 100,
                policy: serde_json::from_value::<Policy>(policy).unwrap(),
            }
        );
        assert_eq!((res.status, res.json()), (200, json!({})));
        let session = api
            .req("GET", "/v1/sessions/a1", READER)
            .send()
            .await
            .json();
        assert_eq!(session["state"], "waiting_permission");
        assert_eq!(session["acp"]["pending"], json!([pending]));
    }
    for (code, status) in [
        (ErrorCode::Stale, 409),
        (ErrorCode::KindMismatch, 409),
        (ErrorCode::NotFound, 404),
    ] {
        let req = api
            .req("POST", "/v1/sessions/a1/policy", OWNER)
            .body(json!({"policy": session_policy()}).to_string());
        let (_, res) = api.answered(req, refusal(code, "refused")).await;
        assert_eq!(
            (res.status, res.json()),
            (status, json!({"error": "refused", "code": code}))
        );
    }
    let before = api.hub.requests().len();
    let res = api
        .req("POST", "/v1/sessions/nope/policy", OWNER)
        .body(r#"{"policy":{"rules":[]}}"#)
        .send()
        .await;
    assert_eq!(
        (res.status, res.json()),
        (404, json!({"error": "no session nope"}))
    );
    assert_eq!(api.hub.requests().len(), before);
}

#[tokio::test]
async fn readers_see_current_session_policy() {
    let policy = session_policy();
    let hub = FakeHub::start();
    let mut current = summary("a1", "testhost");
    current.acp.as_mut().unwrap().policy = Some(serde_json::from_value(policy.clone()).unwrap());
    hub.set_sessions(vec![current]);
    let api = Api::without_hub(hub).await;
    api.web.wait_hub("up").await;
    for (path, list) in [("/v1/sessions", true), ("/v1/sessions/a1", false)] {
        let res = api.req("GET", path, READER).send().await;
        assert_eq!(res.status, 200);
        let body = res.json();
        let session = if list { &body["sessions"][0] } else { &body };
        assert_eq!(session["acp"]["policy"], policy);
        assert_eq!(session["state"], "idle");
    }
}
