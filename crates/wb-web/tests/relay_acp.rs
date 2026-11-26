//! `/acp` against a fake hub (design §3.5.2, §3.5.4, W-3).
//!
//! The shared fake hub records `acp.*` requests without answering them; each test
//! answers by injecting the reply on the request's connection.

mod common;

use std::time::{Duration, Instant};

use common::{FakeHub, Web, Ws, next_json, read_to_close, send_json};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use wb_proto::hub::{
    AcpFacts, AcpOpenReply, AcpSessionInfo, Activity, ErrorCode, HubMessage, HubRequest, Kind,
    Pending, PendingKind, SpawnAcp, Summary,
};
use wb_proto::journal::{EventBody, JournalEvent};
use wb_proto::limits::WS_MAX_ACP;

const EPOCH: u64 = 1_700_000_000_000;

async fn up() -> (FakeHub, Web) {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;
    (hub, web)
}

/// A live ACP Summary of `sid` with nothing outstanding: state `idle`.
fn summary(sid: &str, head_seq: u64) -> Summary {
    Summary {
        sid: sid.into(),
        kind: Kind::Acp,
        host: "testhost".into(),
        created_at: EPOCH,
        updated_at: EPOCH + 1,
        alive: true,
        viewers: 1,
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
            head_seq,
            seen_seq: 0,
            title: None,
            mode_id: Some("default".into()),
            config_options: None,
            managed_worktree: None,
            worker_clone: Some(false),
            task: None,
            policy: None,
        }),
    }
}

fn session_info() -> AcpSessionInfo {
    AcpSessionInfo {
        protocol_version: Some(1),
        agent_info: Some(json!({"name": "stub", "version": "1"})),
        ..AcpSessionInfo::default()
    }
}

fn reply(sid: &str) -> AcpOpenReply {
    AcpOpenReply {
        new: false,
        summary: summary(sid, 3),
        session: session_info(),
        head: 3,
        from: 1,
        reset: false,
        config_errors: Vec::new(),
    }
}

fn is_acp(r: &HubRequest) -> bool {
    serde_json::to_value(r).unwrap()["t"]
        .as_str()
        .is_some_and(|t| t.starts_with("acp."))
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
        | HubRequest::AcpSetPolicy { rid, .. }
        | HubRequest::AcpSeen { rid, .. }
        | HubRequest::AcpRevive { rid, .. }
        | HubRequest::AcpAuthenticate { rid, .. }
        | HubRequest::AcpKill { rid, .. } => *rid,
        other => panic!("no acp rid in {other:?}"),
    }
}

/// The `acp.*` requests on one hub connection, in order.
fn on_conn(hub: &FakeHub, conn: usize) -> Vec<HubRequest> {
    hub.requests()
        .into_iter()
        .filter(|(c, r)| *c == conn && is_acp(r))
        .map(|(_, r)| r)
        .collect()
}

/// Waits until connection `conn` has carried `n` `acp.*` requests; returns them.
async fn wait_on_conn(hub: &FakeHub, conn: usize, n: usize) -> Vec<HubRequest> {
    let started = Instant::now();
    loop {
        let reqs = on_conn(hub, conn);
        if reqs.len() >= n {
            return reqs;
        }
        assert!(started.elapsed() < common::WAIT, "{reqs:?}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Sends `open` for `id` on a new `/acp` socket and answers it with `reply`; returns
/// the socket after its `hello`, the hello, and the socket's hub connection.
async fn attached(hub: &FakeHub, web: &Web, id: &str) -> (Ws, Value, usize) {
    let mut ws = web.ws("/acp").await;
    send_json(&mut ws, json!({"t": "open", "id": id, "since": 0})).await;
    let (conn, req) = hub
        .wait_for(|r| matches!(r, HubRequest::AcpOpen { sid, .. } if sid == id))
        .await;
    hub.send(conn, HubMessage::ok(rid_of(&req), &reply(id)));
    let hello = next_json(&mut ws).await;
    assert_eq!(hello["t"], "hello", "{hello}");
    (ws, hello, conn)
}

fn ev(seq: u64, body: EventBody) -> Box<JournalEvent> {
    Box::new(JournalEvent {
        seq,
        ts: EPOCH + seq,
        body,
    })
}

/// Fails if the socket sends anything, or closes, within a short while.
async fn quiet(ws: &mut Ws) {
    if let Ok(msg) = tokio::time::timeout(Duration::from_millis(300), ws.next()).await {
        panic!("expected nothing, got {msg:?}");
    }
}

#[tokio::test]
async fn startup_configuration_is_not_forwarded_to_an_older_hub() {
    let hub = FakeHub::start_with(common::Hello {
        acp_config: None,
        ..common::Hello::default()
    });
    let web = Web::start(&hub.path);
    web.wait_hub("up").await;
    let mut ws = web.ws("/acp").await;
    send_json(
        &mut ws,
        json!({
            "t": "open", "id": "old", "since": 0, "agent": "claude", "cwd": "/x",
            "rid": 17, "config": [{"id": "model", "value": "large"}]
        }),
    )
    .await;
    let (closed, messages) = read_to_close(&mut ws).await;
    assert_eq!(
        messages,
        [json!({
            "t": "error", "code": "bad_request", "rid": 17,
            "error": "hub does not support session configuration"
        })]
    );
    assert_eq!(closed, 1008);
    assert!(!hub.requests().iter().any(|(_, r)| is_acp(r)));

    let mut ws = web.ws("/acp").await;
    send_json(
        &mut ws,
        json!({
            "t": "open", "id": "empty", "since": 0, "agent": "claude", "cwd": "/x",
            "config": []
        }),
    )
    .await;
    let (conn, req) = hub
        .wait_for(|r| {
            matches!(r,
        HubRequest::AcpOpen { sid, .. } if sid == "empty")
        })
        .await;
    hub.send(conn, HubMessage::ok(rid_of(&req), &reply("empty")));
    assert_eq!(next_json(&mut ws).await["t"], "hello");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_fields_go_only_with_agent_and_cwd() {
    let (hub, web) = up().await;
    let opens = [
        json!({}),
        json!({"agent": "claude"}),
        json!({"cwd": "/home/alice"}),
        json!({"agent": "", "cwd": "/home/alice"}),
        json!({"agent": "claude", "cwd": ""}),
        json!({"agent": null, "cwd": "/home/alice"}),
        json!({"agent": "claude", "cwd": "/home/alice"}),
    ];
    let mut sockets = Vec::new();
    for (i, fields) in opens.iter().enumerate() {
        let mut msg = json!({"t": "open", "id": format!("a{i}/x"), "since": 5 + i, "epoch": EPOCH});
        for (k, v) in fields.as_object().unwrap() {
            msg[k] = v.clone();
        }
        let mut ws = web.ws("/acp").await;
        send_json(&mut ws, msg).await;
        sockets.push(ws);
    }
    let reqs = hub
        .wait_count(opens.len(), |r| matches!(r, HubRequest::AcpOpen { .. }))
        .await;
    let mut got: Vec<(String, u64, Option<u64>, Option<SpawnAcp>)> = reqs
        .into_iter()
        .map(|(_, r)| match r {
            HubRequest::AcpOpen {
                sid,
                since,
                epoch,
                spawn,
                ..
            } => (sid, since, epoch, spawn),
            _ => unreachable!(),
        })
        .collect();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    let want: Vec<_> = (0..opens.len())
        .map(|i| {
            let spawn = (i == opens.len() - 1).then(|| SpawnAcp {
                agent: "claude".into(),
                cwd: "/home/alice".into(),
                host: None,
                config: Vec::new(),
                worktree: None,
                task: None,
                policy: None,
            });
            // The id is sanitised to the sid alphabet; since and epoch pass through.
            (format!("a{i}x"), 5 + i as u64, Some(EPOCH), spawn)
        })
        .collect();
    assert_eq!(got, want);

    // A reconnect sends no epoch when it has none; nothing is made up.
    let mut ws = web.ws("/acp").await;
    send_json(&mut ws, json!({"t": "open", "id": "b1", "since": 0})).await;
    let (_, req) = hub
        .wait_for(|r| matches!(r, HubRequest::AcpOpen { sid, .. } if sid == "b1"))
        .await;
    assert!(
        matches!(
            req,
            HubRequest::AcpOpen {
                epoch: None,
                spawn: None,
                ..
            }
        ),
        "{req:?}"
    );

    // An agent that is not a string is refused before anything reaches the hub.
    let mut ws = web.ws("/acp").await;
    send_json(
        &mut ws,
        json!({"t": "open", "id": "c1", "since": 0, "agent": 5, "cwd": "/home/alice", "rid": 9}),
    )
    .await;
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1008);
    assert_eq!(
        texts,
        [json!({"t": "error", "error": "malformed message", "code": "bad_request", "rid": 9})]
    );
    assert!(
        !hub.requests()
            .iter()
            .any(|(_, r)| matches!(r, HubRequest::AcpOpen { sid, .. } if sid == "c1"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hello_carries_state_and_session_and_info_omits_an_unchanged_session() {
    let (hub, web) = up().await;
    let mut ws = web.ws("/acp").await;
    send_json(
        &mut ws,
        json!({"t": "open", "id": "i1", "since": 0, "agent": "claude", "cwd": "/home/alice/src"}),
    )
    .await;
    let (conn, req) = hub
        .wait_for(|r| matches!(r, HubRequest::AcpOpen { .. }))
        .await;
    assert_ne!(conn, 0, "the card has a hub connection of its own");
    let mut fresh = reply("i1");
    fresh.new = true;
    fresh.summary.acp.as_mut().unwrap().activity = Activity::Setup;
    hub.send(conn, HubMessage::ok(rid_of(&req), &fresh));
    let session = json!({
        "protocolVersion": 1, "agentInfo": {"name": "stub", "version": "1"},
        "agentCapabilities": null, "promptCapabilities": null, "authMethods": null,
        "modes": null, "availableCommands": null, "plan": null, "usage": null,
        "configOptions": null,
    });
    let info = |activity: &str, head: u64, state: &str| {
        json!({
            "sid": "i1", "kind": "acp", "host": "testhost", "createdAt": EPOCH,
            "updatedAt": EPOCH + 1, "alive": true, "viewers": 1, "cwd": "/home/alice/src",
            "fault": null,
            "acp": {
                "agent": "claude", "agentSessionId": "s-1", "revivable": true,
                "activity": activity, "pending": [], "last": null, "headSeq": head,
                "seenSeq": 0, "title": null, "modeId": "default",
                "configOptions": null, "workerClone": false,
            },
            "state": state,
            "repoRoot": null, "repo": null, "worktree": null, "branch": null,
            "projectRoot": null, "project": "src",
        })
    };
    let mut want = info("setup", 3, "running");
    want["session"] = session.clone();
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "hello", "status": "new", "info": want, "head": 3, "from": 1, "reset": false})
    );

    // Same session, new facts: `session` is left out.
    let mut s = summary("i1", 4);
    s.acp.as_mut().unwrap().pending.push(Pending {
        req: 4,
        kind: PendingKind::Permission,
        title: "Run make".into(),
        ts: EPOCH + 4,
    });
    hub.send(
        conn,
        HubMessage::AcpInfo {
            sid: "i1".into(),
            summary: Box::new(s.clone()),
            session: Box::new(session_info()),
        },
    );
    let msg = next_json(&mut ws).await;
    assert_eq!(msg["t"], "info");
    assert_eq!(msg["info"]["state"], "waiting_permission");
    assert_eq!(msg["info"]["acp"]["headSeq"], 4);
    assert!(msg["info"].get("session").is_none(), "{msg}");

    // Another sid's info on this connection is not this card's.
    hub.send(
        conn,
        HubMessage::AcpInfo {
            sid: "zz".into(),
            summary: Box::new(summary("zz", 9)),
            session: Box::new(AcpSessionInfo::default()),
        },
    );
    // A changed session is sent whole, then left out again while it stays the same.
    let mut changed = session_info();
    changed.plan = Some(json!({"entries": [{"content": "test", "status": "pending"}]}));
    for (head, sess) in [(5, &changed), (6, &changed)] {
        hub.send(
            conn,
            HubMessage::AcpInfo {
                sid: "i1".into(),
                summary: Box::new(summary("i1", head)),
                session: Box::new(sess.clone()),
            },
        );
    }
    let msg = next_json(&mut ws).await;
    let mut want = info("none", 5, "idle");
    want["session"] = session;
    want["session"]["plan"] = json!({"entries": [{"content": "test", "status": "pending"}]});
    assert_eq!(msg, json!({"t": "info", "info": want}));
    let msg = next_json(&mut ws).await;
    assert_eq!(msg, json!({"t": "info", "info": info("none", 6, "idle")}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_and_the_replay_end_are_relayed_for_this_sid_only() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "e1").await;
    let update = json!({"sessionUpdate": "agent_message_chunk", "messageId": "m1",
                        "content": {"type": "text", "text": "hi"}, "future": [1, 2]});
    let events = [
        (
            "e1",
            ev(
                1,
                EventBody::Prompt {
                    prompt: vec![json!({"type": "text", "text": "go"})],
                },
            ),
        ),
        (
            "zz",
            ev(
                1,
                EventBody::TurnEnd {
                    stop_reason: "end_turn".into(),
                },
            ),
        ),
        ("e1", ev(2, EventBody::Unknown)),
        (
            "e1",
            ev(
                3,
                EventBody::Update {
                    update: update.clone(),
                    session_id: None,
                },
            ),
        ),
    ];
    for (sid, ev) in events {
        hub.send(
            conn,
            HubMessage::AcpEv {
                sid: sid.into(),
                ev,
            },
        );
    }
    hub.send(
        conn,
        HubMessage::AcpReplayed {
            sid: "e1".into(),
            head: 3,
            truncated: true,
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "ev", "ev": {"seq": 1, "ts": EPOCH + 1, "e": "prompt",
                                 "prompt": [{"type": "text", "text": "go"}]}})
    );
    // The unknown kind is skipped; the verbatim update keeps every field.
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "ev", "ev": {"seq": 3, "ts": EPOCH + 3, "e": "update", "update": update}})
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "replayed", "head": 3, "truncated": true})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commands_map_onto_acp_requests_and_errors_echo_the_rid() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "c1").await;
    let block = json!({"type": "text", "text": "fix the test"});
    let outcome = json!({"outcome": "selected", "optionId": "allow"});
    let response = json!({"action": "accept", "content": {"name": "x"}});
    for msg in [
        json!({"t": "prompt", "blocks": [block], "rid": 1}),
        json!({"t": "cancel"}),
        json!({"t": "permission", "req": 7, "epoch": EPOCH, "outcome": outcome, "rid": 2}),
        json!({"t": "elicitation", "req": 8, "epoch": EPOCH, "response": response}),
        json!({"t": "set_mode", "modeId": "plan", "rid": 3}),
        json!({"t": "seen", "seq": 9}),
        json!({"t": "revive", "rid": 4}),
        json!({"t": "authenticate", "methodId": "login"}),
        json!({"t": "kill", "forget": false}),
    ] {
        send_json(&mut ws, msg).await;
    }
    let reqs = wait_on_conn(&hub, conn, 10).await;
    let sid = || "c1".to_owned();
    let want = [
        HubRequest::AcpPrompt {
            rid: rid_of(&reqs[1]),
            sid: sid(),
            epoch: None,
            prompt: vec![block],
        },
        HubRequest::AcpCancel {
            rid: rid_of(&reqs[2]),
            sid: sid(),
            epoch: None,
        },
        HubRequest::AcpPermission {
            rid: rid_of(&reqs[3]),
            sid: sid(),
            req: 7,
            epoch: EPOCH,
            outcome,
        },
        HubRequest::AcpElicitation {
            rid: rid_of(&reqs[4]),
            sid: sid(),
            req: 8,
            epoch: EPOCH,
            response,
        },
        HubRequest::AcpSetMode {
            rid: rid_of(&reqs[5]),
            sid: sid(),
            epoch: None,
            mode_id: "plan".into(),
        },
        HubRequest::AcpSeen {
            rid: rid_of(&reqs[6]),
            sid: sid(),
            seq: 9,
        },
        HubRequest::AcpRevive {
            rid: rid_of(&reqs[7]),
            sid: sid(),
        },
        HubRequest::AcpAuthenticate {
            rid: rid_of(&reqs[8]),
            sid: sid(),
            method_id: "login".into(),
        },
        HubRequest::AcpKill {
            rid: rid_of(&reqs[9]),
            sid: sid(),
            epoch: None,
            forget: false,
        },
    ];
    assert_eq!(reqs[1..], want);
    let rids: Vec<u64> = reqs.iter().map(rid_of).collect();
    assert!(rids.windows(2).all(|w| w[0] < w[1]), "{rids:?}");

    // An ok produces nothing, not even for the kill without forget.
    for r in &reqs[1..] {
        hub.send(conn, HubMessage::ok(rid_of(r), &json!({})));
    }
    quiet(&mut ws).await;

    // An err reaches the browser with the browser's rid, or without one.
    let err = |r: &HubRequest, code, message: &str| HubMessage::Err {
        rid: Some(rid_of(r)),
        sid: None,
        code,
        message: message.into(),
    };
    send_json(&mut ws, json!({"t": "prompt", "blocks": [], "rid": "p-1"})).await;
    send_json(
        &mut ws,
        json!({"t": "permission", "req": 7, "epoch": 1, "outcome": {}}),
    )
    .await;
    let reqs = wait_on_conn(&hub, conn, 12).await;
    hub.send(conn, err(&reqs[10], ErrorCode::Busy, "a turn is running"));
    hub.send(
        conn,
        err(
            &reqs[11],
            ErrorCode::Stale,
            "this request belongs to an ended session",
        ),
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "error": "a turn is running", "code": "busy", "rid": "p-1"})
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "error": "this request belongs to an ended session", "code": "stale"})
    );

    // A malformed command is answered here and never reaches the hub; the socket
    // stays usable.
    for bad in [
        json!({"t": "prompt", "blocks": "not a list", "rid": 5}),
        json!({"t": "permission", "req": 7, "outcome": {}, "rid": 6}),
        json!({"t": "kill", "rid": 7}),
        json!({"t": "fork", "rid": 8}),
    ] {
        let rid = bad["rid"].clone();
        send_json(&mut ws, bad).await;
        assert_eq!(
            next_json(&mut ws).await,
            json!({"t": "error", "error": "malformed message", "code": "bad_request", "rid": rid})
        );
    }
    ws.send(Message::Text("not json".into())).await.unwrap();
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "error": "malformed message", "code": "bad_request"})
    );
    send_json(&mut ws, json!({"t": "seen", "seq": 10})).await;
    let reqs = wait_on_conn(&hub, conn, 13).await;
    assert_eq!(reqs.len(), 13, "{reqs:?}");
    assert!(matches!(reqs[12], HubRequest::AcpSeen { seq: 10, .. }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn config_errors_keep_the_browser_correlation_and_socket_usable() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "config1").await;
    send_json(
        &mut ws,
        json!({
            "t":"set_config_option","epoch":EPOCH - 1,"configId":"model","value":"other","rid":"old"
        }),
    )
    .await;
    let reqs = wait_on_conn(&hub, conn, 2).await;
    hub.send(
        conn,
        HubMessage::Err {
            rid: Some(rid_of(&reqs[1])),
            sid: None,
            code: ErrorCode::Stale,
            message: "session changed".into(),
        },
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({
            "t":"error","code":"stale","error":"session changed","rid":"old"
        })
    );
    send_json(
        &mut ws,
        json!({"t":"set_config_option","configId":"model","value":"other","rid":"no-epoch"}),
    )
    .await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({
            "t":"error","code":"bad_request","error":"malformed message","rid":"no-epoch"
        })
    );
    send_json(
        &mut ws,
        json!({
            "t":"set_config_option","epoch":EPOCH,"configId":"enabled","value":true
        }),
    )
    .await;
    let reqs = wait_on_conn(&hub, conn, 3).await;
    hub.send(conn, HubMessage::ok(rid_of(&reqs[2]), &json!({})));
    quiet(&mut ws).await;
    ws.close(None).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_kill_forget_closes_1000_after_its_ok() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "k1").await;
    send_json(&mut ws, json!({"t": "kill", "forget": true})).await;
    let reqs = wait_on_conn(&hub, conn, 2).await;
    assert_eq!(
        reqs[1],
        HubRequest::AcpKill {
            rid: rid_of(&reqs[1]),
            sid: "k1".into(),
            epoch: None,
            forget: true
        }
    );
    // The hub answers only after the session is deleted; until then the socket stays.
    quiet(&mut ws).await;
    hub.send(conn, HubMessage::ok(rid_of(&reqs[1]), &json!({})));
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    assert!(texts.is_empty(), "{texts:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gone_closes_1000() {
    // The hub sends `gone` to the attached connections before the kill's ok, which
    // then has no socket to reach.
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "g1").await;
    send_json(&mut ws, json!({"t": "kill", "forget": true})).await;
    wait_on_conn(&hub, conn, 2).await;
    // Independent frames on both sides of the write-batch size, followed
    // immediately by a close. Neither the tail nor the close can overtake one.
    let mut expected = Vec::new();
    for (i, n) in [20, 48_000, 20_000, 70_000, 10, 10].into_iter().enumerate() {
        let event = ev(
            i as u64 + 1,
            EventBody::Notice {
                level: wb_proto::journal::NoticeLevel::Info,
                text: "x".repeat(n),
            },
        );
        expected.push(json!({"t": "ev", "ev": event}));
        hub.send(
            conn,
            HubMessage::AcpEv {
                sid: "g1".into(),
                ev: event,
            },
        );
    }
    hub.send(
        conn,
        HubMessage::Gone {
            sid: "zz".into(),
            epoch: EPOCH,
        },
    );
    hub.send(
        conn,
        HubMessage::Gone {
            sid: "g1".into(),
            epoch: EPOCH,
        },
    );
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    expected.push(json!({"t": "gone", "epoch": EPOCH}));
    assert_eq!(texts, expected);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_open_sends_error_then_closes_1000() {
    let (hub, web) = up().await;
    let mut ws = web.ws("/acp").await;
    send_json(
        &mut ws,
        json!({"t": "open", "id": "ghost2", "since": 0, "rid": 1}),
    )
    .await;
    let (conn, req) = hub
        .wait_for(|r| matches!(r, HubRequest::AcpOpen { .. }))
        .await;
    // Without agent and cwd the open never asks for a spawn (T-S17).
    assert_eq!(
        req,
        HubRequest::AcpOpen {
            rid: rid_of(&req),
            sid: "ghost2".into(),
            since: 0,
            epoch: None,
            spawn: None
        }
    );
    hub.send(
        conn,
        HubMessage::Err {
            rid: Some(rid_of(&req)),
            sid: None,
            code: ErrorCode::NotFound,
            message: "no session ghost2".into(),
        },
    );
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    assert_eq!(
        texts,
        [json!({"t": "error", "error": "no session ghost2", "code": "not_found", "rid": 1})]
    );

    // A refused spawn ends the same way.
    let mut ws = web.ws("/acp").await;
    send_json(
        &mut ws,
        json!({"t": "open", "id": "u1", "since": 0, "agent": "nope", "cwd": "/home/alice"}),
    )
    .await;
    let (conn, req) = hub
        .wait_for(|r| matches!(r, HubRequest::AcpOpen { sid, .. } if sid == "u1"))
        .await;
    hub.send(
        conn,
        HubMessage::Err {
            rid: Some(rid_of(&req)),
            sid: None,
            code: ErrorCode::UnknownAgent,
            message: "unknown agent nope".into(),
        },
    );
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1000);
    assert_eq!(
        texts,
        [json!({"t": "error", "error": "unknown agent nope", "code": "unknown_agent"})]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_must_come_first_and_name_a_usable_id() {
    let (hub, web) = up().await;
    let cases = [
        (
            json!({"t": "prompt", "blocks": [], "rid": 2}),
            json!({"t": "error", "error": "open must come first", "code": "bad_request", "rid": 2}),
        ),
        (
            json!({"t": "open", "id": "!!/..", "since": 0}),
            json!({"t": "error", "error": "bad id", "code": "bad_request"}),
        ),
        (
            json!({"t": "open", "id": "a1", "since": -1}),
            json!({"t": "error", "error": "malformed message", "code": "bad_request"}),
        ),
        (
            json!({"t": "open", "id": "a1"}),
            json!({"t": "error", "error": "malformed message", "code": "bad_request"}),
        ),
    ];
    for (msg, want) in cases {
        let mut ws = web.ws("/acp").await;
        send_json(&mut ws, msg).await;
        let (code, texts) = read_to_close(&mut ws).await;
        assert_eq!(code, 1008);
        assert_eq!(texts, [want]);
    }
    assert!(!hub.requests().iter().any(|(_, r)| is_acp(r)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_open_is_refused_and_the_socket_stays() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "o1").await;
    send_json(
        &mut ws,
        json!({"t": "open", "id": "o2", "since": 0, "agent": "claude", "cwd": "/home/alice", "rid": 3}),
    )
    .await;
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "error": "open was already sent", "code": "bad_request", "rid": 3})
    );
    hub.send(
        conn,
        HubMessage::AcpReplayed {
            sid: "o1".into(),
            head: 3,
            truncated: false,
        },
    );
    assert_eq!(next_json(&mut ws).await["t"], "replayed");
    assert_eq!(on_conn(&hub, conn).len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_async_error_is_shown_and_a_reload_closes_1011() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "r1").await;
    let async_err = |sid: &str, code, message: &str| HubMessage::Err {
        rid: None,
        sid: Some(sid.into()),
        code,
        message: message.into(),
    };
    hub.send(
        conn,
        async_err("zz", ErrorCode::Internal, "session reloaded"),
    );
    hub.send(
        conn,
        async_err("r1", ErrorCode::Faulted, "journal write failed"),
    );
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "error": "journal write failed", "code": "faulted"})
    );
    hub.send(
        conn,
        async_err("r1", ErrorCode::Internal, "session reloaded"),
    );
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1011);
    assert!(texts.is_empty(), "{texts:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn losing_the_hub_closes_1011() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "l1").await;
    hub.close(conn);
    assert_eq!(read_to_close(&mut ws).await.0, 1011);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_down_closes_1013() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let mut ws = web.ws("/acp").await;
    let (code, texts) = read_to_close(&mut ws).await;
    assert_eq!(code, 1013);
    assert!(texts.is_empty());
}

fn prompt(text: &str) -> String {
    json!({"t": "prompt", "blocks": [{"type": "text", "text": text}]}).to_string()
}

/// A prompt message of exactly `len` bytes.
fn prompt_of(len: usize) -> String {
    let msg = prompt(&"x".repeat(len - prompt("").len()));
    assert_eq!(msg.len(), len);
    msg
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_nine_mib_prompt_is_relayed_and_a_larger_message_closes_1009() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "p1").await;
    ws.send(Message::Text(prompt_of(WS_MAX_ACP).into()))
        .await
        .unwrap();
    let reqs = wait_on_conn(&hub, conn, 2).await;
    let HubRequest::AcpPrompt { prompt: blocks, .. } = &reqs[1] else {
        panic!("{:?}", reqs[1]);
    };
    let text = blocks[0]["text"].as_str().unwrap();
    assert_eq!(text.len(), WS_MAX_ACP - prompt("").len());

    let (mut tx, mut rx) = ws.split();
    let msg = prompt_of(WS_MAX_ACP + 1);
    // The web stops reading at the header, so the write may never finish.
    let writer = tokio::spawn(async move {
        let _ = tx.send(Message::Text(msg.into())).await;
    });
    let (code, _) = read_to_close(&mut rx).await;
    assert_eq!(code, 1009);
    writer.abort();
    assert_eq!(on_conn(&hub, conn).len(), 2, "nothing more reached the hub");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_that_grows_past_a_hub_line_gets_bad_request_and_the_socket_stays() {
    let (hub, web) = up().await;
    let (mut ws, _, conn) = attached(&hub, &web, "p2").await;
    // `1e15` comes out as `1000000000000000.0`: 7 MiB in, about 27 MiB out.
    let blocks = vec!["1e15"; (7 << 20) / 5].join(",");
    let msg = format!(r#"{{"t":"prompt","rid":"big","blocks":[{blocks}]}}"#);
    assert!(msg.len() < WS_MAX_ACP);
    ws.send(Message::Text(msg.into())).await.unwrap();
    assert_eq!(
        next_json(&mut ws).await,
        json!({"t": "error", "error": "message too large", "code": "bad_request", "rid": "big"})
    );
    send_json(&mut ws, json!({"t": "cancel"})).await;
    let reqs = wait_on_conn(&hub, conn, 2).await;
    assert!(
        matches!(reqs[1], HubRequest::AcpCancel { .. }),
        "only the cancel reached the hub: {reqs:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigterm_closes_1012() {
    let (hub, mut web) = up().await;
    let (mut ws, _, _) = attached(&hub, &web, "s1").await;
    web.sigterm();
    assert_eq!(read_to_close(&mut ws).await.0, 1012);
    assert!(web.wait_exit().await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policy_reaches_a_spawn_but_never_turns_a_page_load_into_one() {
    let (hub, web) = up().await;
    let policy = json!({"rules": [{
        "action": "allow",
        "kinds": ["read", "edit", "execute"],
        "roots": ["$cwd", "/nix/store", "/tmp"],
        "programs": ["git", "/usr/bin/git", "./tools/git"],
        "command": {"notMatches": ["danger"]}
    }]});
    let mut ws = web.ws("/acp").await;
    send_json(
        &mut ws,
        json!({
            "t": "open", "id": "policy-spawn", "since": 0,
            "agent": "claude", "cwd": "/home/alice/src", "policy": policy
        }),
    )
    .await;
    let (conn, req) = hub
        .wait_for(|r| matches!(r, HubRequest::AcpOpen { sid, .. } if sid == "policy-spawn"))
        .await;
    let HubRequest::AcpOpen {
        spawn: Some(spawn), ..
    } = &req
    else {
        panic!("{req:?}");
    };
    assert_eq!(serde_json::to_value(&spawn.policy).unwrap(), policy);
    let mut opened = reply("policy-spawn");
    opened.new = true;
    hub.send(conn, HubMessage::ok(rid_of(&req), &opened));
    let hello = next_json(&mut ws).await;
    assert_eq!(hello["t"], "hello");
    assert_eq!(hello["status"], "new");
    ws.close(None).await.unwrap();

    // Merely opening a card, reconnecting, or sending just one spawn field must
    // not start anything, even if a valid policy is included.
    for (i, fields) in [
        json!({}),
        json!({"agent": "claude"}),
        json!({"cwd": "/home/alice/src"}),
        json!({"agent": "", "cwd": "/home/alice/src"}),
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("policy-page-{i}");
        let mut msg = json!({
            "t": "open", "id": id, "since": 4, "epoch": EPOCH, "policy": policy
        });
        for (key, value) in fields.as_object().unwrap() {
            msg[key] = value.clone();
        }
        let mut page = web.ws("/acp").await;
        send_json(&mut page, msg).await;
        let (page_conn, open) = hub
            .wait_for(|r| matches!(r, HubRequest::AcpOpen { sid, .. } if sid == &id))
            .await;
        assert!(
            matches!(open, HubRequest::AcpOpen { spawn: None, .. }),
            "{open:?}"
        );
        hub.send(page_conn, HubMessage::ok(rid_of(&open), &reply(&id)));
        let hello = next_json(&mut page).await;
        assert_eq!(hello["status"], "attached");
        page.close(None).await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_spawn_and_attach_policies_are_rejected_before_open() {
    let (hub, web) = up().await;
    let invalid = [
        Value::Null,
        json!({}),
        json!([]),
        json!({"rules": [{"action": "allow", "roots": null}]}),
        json!({"rules": [{"action": "allow", "kinds": null}]}),
        json!({"rules": [{"action": "allow", "command": null}]}),
        json!({"rules": [{"action": "allow", "programs": null}]}),
        json!({"rules": [{"action": "allow", "programs": "git"}]}),
        json!({"rules": [{"action": "allow", "programs": [1]}]}),
        json!({"rules": [{"action": "allow", "programs": [""]}]}),
        json!({"rules": [{"action": "allow", "programs": ["git status"]}]}),
        json!({"rules": [{"action": "allow", "programs": ["git\tstatus"]}]}),
        json!({"rules": [{"action": "allow", "programs": ["git\nstatus"]}]}),
        json!({"rules": [{"action": "allow", "programs": ["git\u{a0}status"]}]}),
        json!({"rules": [{"action": "allow", "programs": ["git\u{2003}status"]}]}),
        json!({"rules": [{"action": "allow", "programs": ["a\u{0}b"]}]}),
        json!({"rules": [{"action": "allow", "programs": ["x".repeat(257)]}]}),
        json!({"rules": [{"action": "allow", "programs": ["é".repeat(129)]}]}),
        json!({"rules": [{"action": "allow", "programs": vec!["git"; 65]}]}),
        json!({"rules": [], "extra": true}),
        json!({"rules": [{"action": "allow", "extra": true}]}),
        json!({"rules": [{"action": "deny"}]}),
        json!({"rules": [{"action": "allow", "roots": ["relative"]}]}),
        json!({"rules": [{"action": "allow", "roots": ["$cwd/child"]}]}),
        json!({"rules": [{"action": "allow", "roots": [""]}]}),
        json!({"rules": [{"action": "allow", "kinds": ["x".repeat(65)]}]}),
        json!({"rules": vec![json!({"action": "ask"}); 65]}),
        json!({"rules": [{
            "action": "allow", "command": {"matches": ["["]}
        }]}),
        json!({"rules": [{
            "action": "allow", "command": {"notMatches": ["("]}
        }]}),
        json!({"rules": [{
            "action": "allow", "command": {"matches": ["x".repeat(4097)]}
        }]}),
        json!({"rules": [{"action":"allow", "roots":[format!("/{}", "r".repeat(4096))]}]}),
        json!({"rules": [{"action":"allow", "roots":vec![format!("/{}", "r".repeat(4095));64]}]}),
        json!({"rules": [{"action":"allow", "command":{"notMatches":["a[a-z]{3637}0"]}}]}),
        json!({"rules": [{"action":"allow", "command":{"notMatches":["[ab]*a[ab]{3635}c"]}}]}),
        json!({"rules": [{
            "action": "allow", "command": {"matches": vec!["x"; 129]}
        }]}),
        json!({"rules": [{
            "action": "allow", "command": {"not_matches": ["danger"]}
        }]}),
    ];
    for policy in invalid {
        for spawning in [false, true] {
            let mut open = json!({
                "t": "open", "id": "invalid-policy", "since": 0,
                "policy": policy, "rid": "bad-policy"
            });
            if spawning {
                open["agent"] = json!("claude");
                open["cwd"] = json!("/home/alice/src");
            }
            let mut ws = web.ws("/acp").await;
            send_json(&mut ws, open).await;
            let (code, texts) = read_to_close(&mut ws).await;
            assert_eq!(code, 1008);
            assert_eq!(
                texts,
                [json!({
                    "t": "error", "error": "malformed message",
                    "code": "bad_request", "rid": "bad-policy"
                })]
            );
        }
    }
    assert!(!hub.requests().iter().any(|(_, r)| is_acp(r)));
}
