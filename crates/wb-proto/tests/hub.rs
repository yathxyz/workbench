//! Every JSON example and message shape of the hub protocol round-trips unchanged.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use wb_proto::hub::*;
use wb_proto::line;

/// Parses `json` as `T`, encodes it again with `line::encode`, and asserts that the
/// result is the same JSON value.
fn round_trip<T: Serialize + DeserializeOwned>(json: Value) -> T {
    let text = json.to_string();
    let parsed: T = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}: {text}"));
    let line = line::encode(&parsed);
    assert_eq!(line.last(), Some(&b'\n'));
    let back: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(back, json);
    parsed
}

fn summary_pty_alive() -> Value {
    json!({
        "sid": "n_k3m9x2", "kind": "pty", "host": "example",
        "createdAt": 1791460000000u64, "updatedAt": 1791460123000u64,
        "alive": true, "viewers": 2, "cwd": "/home/alice/proj/x", "fault": null,
        "pty": {
            "argv": ["/bin/bash"],
            "pid": 4242,
            "fg": {"comm": "nvim", "pgid": 4301, "leader": false}
        }
    })
}

fn summary_pty_dead() -> Value {
    json!({
        "sid": "n_dead", "kind": "pty", "host": "example",
        "createdAt": 1791460000000u64, "updatedAt": 1791460123000u64,
        "alive": false, "viewers": 0, "cwd": "/home/alice",
        "fault": {"code": "load_failed", "message": "bad json"},
        "pty": {
            "argv": ["/bin/bash", "-c", "make"],
            "exit": {"code": 0, "signal": null, "reason": "exited", "at": 1791460123000u64}
        }
    })
}

fn summary_acp() -> Value {
    json!({
        "sid": "n_agent1", "kind": "acp", "host": "example",
        "createdAt": 1791460000000u64, "updatedAt": 1791460123000u64,
        "alive": true, "viewers": 1, "cwd": "/home/alice/proj/x", "fault": null,
        "acp": {
            "agent": "claude",
            "agentSessionId": "c0ffee",
            "revivable": true,
            "activity": "turn",
            "pending": [{"req": 812, "kind": "permission", "title": "Run `rm -rf build`", "ts": 1791460120000u64}],
            "last": {"seq": 790, "ts": 1791460100000u64, "outcome": "end_turn", "error": null},
            "headSeq": 815, "seenSeq": 790,
            "title": "Fix flaky test",
            "modeId": "default"
        }
    })
}

fn summary_acp_fresh_faulted() -> Value {
    json!({
        "sid": "n_agent2", "kind": "acp", "host": "example",
        "createdAt": 1791460000000u64, "updatedAt": 1791460000000u64,
        "alive": false, "viewers": 0, "cwd": "/home/alice",
        "fault": {"code": "journal_write", "message": "No space left on device"},
        "acp": {
            "agent": "codex",
            "agentSessionId": null,
            "revivable": false,
            "activity": "none",
            "pending": [{"req": 3, "kind": "elicitation", "title": "Pick a branch", "ts": 1791460000500u64}],
            "last": {"seq": 4, "ts": 1791460000600u64, "outcome": "error",
                     "error": {"code": "agent_exited", "message": "agent exited"}},
            "headSeq": 5, "seenSeq": 0,
            "title": null,
            "modeId": null
        }
    })
}

#[test]
fn server_hello() {
    let msg: HubMessage = round_trip(json!({
        "t": "hello", "proto": 1, "server": "wb-hub", "version": "0.1.0",
        "build": "0123abcd", "host": "example", "pid": 1234, "startedAt": 1791460000000u64,
        "agents": [{"name": "claude", "label": "Claude"}, {"name": "codex", "label": "Codex"}],
        "shells": ["bash", "nu", "zsh"], "defaultShell": "bash"
    }));
    let HubMessage::Hello {
        proto,
        build,
        started_at,
        agents,
        shells,
        default_shell,
        ..
    } = msg
    else {
        panic!("{msg:?}")
    };
    assert_eq!(proto, PROTO);
    assert_eq!(build.as_deref(), Some("0123abcd"));
    assert_eq!(started_at, 1791460000000);
    assert_eq!(agents[1].label, "Codex");
    assert_eq!(shells, ["bash", "nu", "zsh"]);
    assert_eq!(default_shell, "bash");
}

#[test]
fn server_hello_without_build() {
    let msg: HubMessage = round_trip(json!({
        "t": "hello", "proto": 1, "server": "wb-hub", "version": "0.1.0",
        "host": "example", "pid": 1234, "startedAt": 1791460000000u64, "agents": [],
        "shells": [], "defaultShell": "bash"
    }));
    assert!(matches!(msg, HubMessage::Hello { build: None, .. }));
}

#[test]
fn server_hello_from_an_older_hub_without_shells() {
    let msg: HubMessage = serde_json::from_str(
        r#"{"t":"hello","proto":1,"server":"wb-hub","version":"0.1.0","host":"example",
            "pid":1234,"startedAt":1791460000000,"agents":[]}"#,
    )
    .unwrap();
    let HubMessage::Hello {
        shells,
        default_shell,
        ..
    } = &msg
    else {
        panic!("{msg:?}")
    };
    assert!(shells.is_empty());
    assert_eq!(default_shell, "");
    // A newer hub always sends both fields.
    let back: Value = serde_json::from_slice(&line::encode(&msg)).unwrap();
    assert_eq!(back["shells"], json!([]));
    assert_eq!(back["defaultShell"], "");
}

#[test]
fn client_hello() {
    let req: HubRequest = round_trip(json!({"t": "hello", "proto": 1, "client": "wb-web/0.1.0"}));
    assert_eq!(
        req,
        HubRequest::Hello {
            proto: 1,
            client: "wb-web/0.1.0".into()
        }
    );
}

#[test]
fn ok_envelope_keeps_reply_fields() {
    let msg: HubMessage = round_trip(json!({"t": "ok", "rid": 7}));
    assert_eq!(
        msg,
        HubMessage::Ok {
            rid: 7,
            result: Default::default()
        }
    );

    let msg: HubMessage = round_trip(json!({"t": "ok", "rid": 8, "text": "$ ls", "later": true}));
    let HubMessage::Ok { rid, result } = msg else {
        panic!("{msg:?}")
    };
    assert_eq!(rid, 8);
    assert_eq!(
        Value::Object(result),
        json!({"text": "$ ls", "later": true})
    );
}

#[test]
fn err_reply_async_and_handshake_forms() {
    let msg: HubMessage =
        round_trip(json!({"t": "err", "rid": 3, "code": "not_found", "message": "no session n_1"}));
    assert_eq!(
        msg,
        HubMessage::Err {
            rid: Some(3),
            sid: None,
            code: ErrorCode::NotFound,
            message: "no session n_1".into()
        }
    );

    let msg: HubMessage = round_trip(
        json!({"t": "err", "sid": "n_1", "code": "input_overflow", "message": "input queue full"}),
    );
    assert!(matches!(
        msg,
        HubMessage::Err {
            rid: None,
            sid: Some(_),
            code: ErrorCode::InputOverflow,
            ..
        }
    ));

    let msg: HubMessage =
        round_trip(json!({"t": "err", "code": "proto", "message": "wb-hub speaks proto 1"}));
    assert!(matches!(
        msg,
        HubMessage::Err {
            rid: None,
            sid: None,
            code: ErrorCode::Proto,
            ..
        }
    ));

    let msg: HubMessage = round_trip(
        json!({"t": "err", "sid": "n_1", "code": "internal", "message": "session reloaded"}),
    );
    assert!(matches!(
        msg,
        HubMessage::Err {
            code: ErrorCode::Internal,
            ..
        }
    ));
}

#[test]
fn every_error_code() {
    let codes = [
        ("bad_request", ErrorCode::BadRequest),
        ("not_found", ErrorCode::NotFound),
        ("kind_mismatch", ErrorCode::KindMismatch),
        ("not_alive", ErrorCode::NotAlive),
        ("busy", ErrorCode::Busy),
        ("already_resolved", ErrorCode::AlreadyResolved),
        ("bad_option", ErrorCode::BadOption),
        ("not_revivable", ErrorCode::NotRevivable),
        ("spawn_failed", ErrorCode::SpawnFailed),
        ("agent_error", ErrorCode::AgentError),
        ("timeout", ErrorCode::Timeout),
        ("unknown_agent", ErrorCode::UnknownAgent),
        ("input_overflow", ErrorCode::InputOverflow),
        ("stale", ErrorCode::Stale),
        ("faulted", ErrorCode::Faulted),
        ("proto", ErrorCode::Proto),
        ("unknown_type", ErrorCode::UnknownType),
        ("internal", ErrorCode::Internal),
    ];
    for (text, code) in codes {
        assert_eq!(round_trip::<ErrorCode>(json!(text)), code);
    }
}

#[test]
fn summaries() {
    let s: Summary = round_trip(summary_pty_alive());
    assert_eq!(s.kind, Kind::Pty);
    assert_eq!(s.fault, None);
    let pty = s.pty.unwrap();
    assert_eq!(pty.pid, Some(4242));
    assert!(!pty.fg.unwrap().leader);
    assert_eq!(pty.exit, None);
    assert!(s.acp.is_none());

    let s: Summary = round_trip(summary_pty_dead());
    assert_eq!(s.fault.unwrap().code, FaultCode::LoadFailed);
    let pty = s.pty.unwrap();
    assert_eq!((pty.pid, pty.fg), (None, None));
    let exit = pty.exit.unwrap();
    assert_eq!((exit.code, exit.signal), (Some(0), None));
    assert_eq!(exit.reason, ExitReason::Exited);

    let s: Summary = round_trip(summary_acp());
    assert_eq!(s.kind, Kind::Acp);
    assert!(s.pty.is_none());
    let acp = s.acp.unwrap();
    assert_eq!(acp.activity, Activity::Turn);
    assert_eq!(acp.pending[0].kind, PendingKind::Permission);
    assert_eq!(acp.last.unwrap().outcome, "end_turn");
    assert_eq!((acp.head_seq, acp.seen_seq), (815, 790));
    assert_eq!(acp.mode_id.as_deref(), Some("default"));

    let s: Summary = round_trip(summary_acp_fresh_faulted());
    assert_eq!(s.fault.unwrap().code, FaultCode::JournalWrite);
    let acp = s.acp.unwrap();
    assert_eq!(acp.agent_session_id, None);
    assert_eq!(acp.activity, Activity::None);
    assert_eq!(acp.pending[0].kind, PendingKind::Elicitation);
    assert_eq!(acp.last.unwrap().error.unwrap().code, "agent_exited");
    assert_eq!((acp.title, acp.mode_id), (None, None));
}

#[test]
fn exit_reasons() {
    for (text, reason) in [
        ("exited", ExitReason::Exited),
        ("killed", ExitReason::Killed),
        ("hub_restart", ExitReason::HubRestart),
        ("spawn_failed", ExitReason::SpawnFailed),
    ] {
        assert_eq!(round_trip::<ExitReason>(json!(text)), reason);
    }
}

#[test]
fn list_and_watch() {
    let req: HubRequest = round_trip(json!({"t": "list", "rid": 1}));
    assert_eq!(req, HubRequest::List { rid: 1 });
    let req: HubRequest = round_trip(json!({"t": "watch", "rid": 2}));
    assert_eq!(req, HubRequest::Watch { rid: 2 });

    let msg: HubMessage = round_trip(json!({
        "t": "ok", "rid": 2,
        "sessions": [summary_pty_alive(), summary_pty_dead(), summary_acp()]
    }));
    let HubMessage::Ok { rid, result } = msg else {
        panic!("{msg:?}")
    };
    assert_eq!(rid, 2);
    let reply: SessionsReply = serde_json::from_value(Value::Object(result)).unwrap();
    assert_eq!(reply.sessions.len(), 3);
    assert_eq!(reply.sessions[2].kind, Kind::Acp);
}

#[test]
fn pty_open_requests() {
    let req: HubRequest = round_trip(json!({
        "t": "pty.open", "rid": 4, "sid": "n_k3m9x2", "cols": 120, "rows": 40,
        "spawn": {
            "argv": ["/bin/bash", "-c", "make test"],
            "cwd": "/home/alice/proj/x",
            "cwdFrom": "n_parent",
            "env": {"CANVAS_NODE": "n_k3m9x2", "FOO": "bar"}
        },
        "resume": {"stream": 1791460000000u64, "out": 5120}
    }));
    let HubRequest::PtyOpen {
        spawn: Some(spawn),
        resume: Some(resume),
        ..
    } = req
    else {
        panic!("{req:?}")
    };
    assert_eq!(spawn.cwd_from.as_deref(), Some("n_parent"));
    assert_eq!(spawn.env.unwrap()["FOO"], "bar");
    assert_eq!(
        resume,
        Resume {
            stream: 1791460000000,
            out: 5120
        }
    );

    let req: HubRequest = round_trip(json!({
        "t": "pty.open", "rid": 5, "sid": "n_k3m9x2", "cols": 80, "rows": 24,
        "spawn": {"argv": ["/bin/bash"]}
    }));
    assert!(matches!(
        req,
        HubRequest::PtyOpen {
            spawn: Some(SpawnPty {
                shell: None,
                cwd: None,
                cwd_from: None,
                env: None,
                ..
            }),
            resume: None,
            ..
        }
    ));

    let req: HubRequest = round_trip(json!({
        "t": "pty.open", "rid": 7, "sid": "n_k3m9x2", "cols": 80, "rows": 24,
        "spawn": {"argv": ["nu", "-c", "ls"], "shell": "nu"}
    }));
    let HubRequest::PtyOpen {
        spawn: Some(spawn), ..
    } = req
    else {
        panic!("{req:?}")
    };
    assert_eq!(spawn.shell.as_deref(), Some("nu"));
    assert_eq!(spawn.argv, ["nu", "-c", "ls"]);

    let req: HubRequest =
        round_trip(json!({"t": "pty.open", "rid": 6, "sid": "ghost", "cols": 80, "rows": 24}));
    assert_eq!(
        req,
        HubRequest::PtyOpen {
            rid: 6,
            sid: "ghost".into(),
            cols: 80,
            rows: 24,
            spawn: None,
            resume: None
        }
    );
}

#[test]
fn pty_open_replies() {
    let resumed = PtyOpenReply {
        new: false,
        pid: Some(4242),
        cwd: "/home/alice/proj/x".into(),
        exit: None,
        epoch: 1791460000000,
        stream: 1791460050000,
        out: 9000,
        resumed: true,
        replay: Some("tail\r\n".into()),
    };
    let fresh = PtyOpenReply {
        new: true,
        replay: None,
        resumed: false,
        out: 0,
        ..resumed.clone()
    };
    let corpse = PtyOpenReply {
        new: false,
        pid: None,
        exit: Some(Exit {
            code: None,
            signal: None,
            reason: ExitReason::HubRestart,
            at: 1791460123000,
        }),
        resumed: false,
        replay: Some(String::new()),
        ..resumed.clone()
    };
    let cases = [
        (
            resumed,
            json!({"t": "ok", "rid": 4, "new": false, "pid": 4242, "cwd": "/home/alice/proj/x",
                   "epoch": 1791460000000u64, "stream": 1791460050000u64, "out": 9000,
                   "resumed": true, "replay": "tail\r\n"}),
        ),
        (
            fresh,
            json!({"t": "ok", "rid": 4, "new": true, "pid": 4242, "cwd": "/home/alice/proj/x",
                   "epoch": 1791460000000u64, "stream": 1791460050000u64, "out": 0,
                   "resumed": false}),
        ),
        (
            corpse,
            json!({"t": "ok", "rid": 4, "new": false, "cwd": "/home/alice/proj/x",
                   "exit": {"code": null, "signal": null, "reason": "hub_restart", "at": 1791460123000u64},
                   "epoch": 1791460000000u64, "stream": 1791460050000u64, "out": 9000,
                   "resumed": false, "replay": ""}),
        ),
    ];
    for (reply, expected) in cases {
        let msg = HubMessage::ok(4, &reply);
        assert_eq!(serde_json::to_value(&msg).unwrap(), expected);
        let HubMessage::Ok { result, .. } = round_trip::<HubMessage>(expected) else {
            panic!()
        };
        let back: PtyOpenReply = serde_json::from_value(Value::Object(result)).unwrap();
        assert_eq!(back, reply);
    }
}

#[test]
fn pty_requests_without_reply_and_kill_detach_capture() {
    let req: HubRequest = round_trip(json!({"t": "pty.input", "sid": "n_1", "d": "ls\r"}));
    assert_eq!(
        req,
        HubRequest::PtyInput {
            sid: "n_1".into(),
            d: "ls\r".into()
        }
    );
    let req: HubRequest =
        round_trip(json!({"t": "pty.resize", "sid": "n_1", "cols": 100, "rows": 30}));
    assert_eq!(
        req,
        HubRequest::PtyResize {
            sid: "n_1".into(),
            cols: 100,
            rows: 30
        }
    );
    let req: HubRequest = round_trip(json!({"t": "pty.detach", "rid": 9, "sid": "n_1"}));
    assert_eq!(
        req,
        HubRequest::PtyDetach {
            rid: 9,
            sid: "n_1".into()
        }
    );
    let req: HubRequest =
        round_trip(json!({"t": "pty.kill", "rid": 10, "sid": "n_1", "forget": true}));
    assert_eq!(
        req,
        HubRequest::PtyKill {
            rid: 10,
            sid: "n_1".into(),
            forget: true
        }
    );
    let req: HubRequest =
        round_trip(json!({"t": "pty.capture", "rid": 11, "sid": "n_1", "lines": 50}));
    assert_eq!(
        req,
        HubRequest::PtyCapture {
            rid: 11,
            sid: "n_1".into(),
            lines: Some(50)
        }
    );
    let req: HubRequest = round_trip(json!({"t": "pty.capture", "rid": 12, "sid": "n_1"}));
    assert!(matches!(req, HubRequest::PtyCapture { lines: None, .. }));

    let msg = HubMessage::ok(
        11,
        &CaptureReply {
            text: "$ ls\nfile".into(),
        },
    );
    assert_eq!(
        round_trip::<HubMessage>(json!({"t": "ok", "rid": 11, "text": "$ ls\nfile"})),
        msg
    );
}

#[test]
fn pty_and_watch_events() {
    let msg: HubMessage =
        round_trip(json!({"t": "pty.out", "sid": "n_1", "d": "hi\u{fffd}", "out": 6}));
    assert_eq!(
        msg,
        HubMessage::PtyOut {
            sid: "n_1".into(),
            d: "hi\u{fffd}".into(),
            out: 6
        }
    );
    let msg: HubMessage = round_trip(
        json!({"t": "pty.fg", "sid": "n_1", "comm": "nvim", "cwd": "/home/alice/proj/x"}),
    );
    assert!(matches!(msg, HubMessage::PtyFg { .. }));
    let msg: HubMessage = round_trip(
        json!({"t": "pty.exit", "sid": "n_1", "code": null, "signal": 9, "reason": "killed"}),
    );
    assert_eq!(
        msg,
        HubMessage::PtyExit {
            sid: "n_1".into(),
            code: None,
            signal: Some(9),
            reason: ExitReason::Killed
        }
    );
    let msg: HubMessage = round_trip(json!({"t": "session", "session": summary_acp()}));
    let HubMessage::Session { session } = msg else {
        panic!("{msg:?}")
    };
    assert_eq!(session.sid, "n_agent1");
    let msg: HubMessage = round_trip(json!({"t": "gone", "sid": "n_1", "epoch": 1791460000000u64}));
    assert_eq!(
        msg,
        HubMessage::Gone {
            sid: "n_1".into(),
            epoch: 1791460000000
        }
    );
}

#[test]
fn unknown_t_is_unknown() {
    let req: HubRequest = serde_json::from_str(
        r#"{"t":"acp.open","rid":5,"sid":"n_1","since":0,"spawn":{"agent":"claude","cwd":"/"}}"#,
    )
    .unwrap();
    assert_eq!(req, HubRequest::Unknown);
    let msg: HubMessage =
        serde_json::from_str(r#"{"t":"acp.ev","sid":"n_1","ev":{"seq":1,"ts":2,"e":"spawn"}}"#)
            .unwrap();
    assert_eq!(msg, HubMessage::Unknown);
}

#[test]
fn unknown_fields_are_ignored() {
    let req: HubRequest =
        serde_json::from_str(r#"{"t":"pty.input","sid":"n_1","d":"x","prio":3}"#).unwrap();
    assert_eq!(
        req,
        HubRequest::PtyInput {
            sid: "n_1".into(),
            d: "x".into()
        }
    );
    let req: HubRequest = serde_json::from_str(
        r#"{"t":"pty.open","rid":1,"sid":"a","cols":80,"rows":24,"respawn":true,
            "spawn":{"argv":["sh"],"nice":5},"resume":{"stream":1,"out":2,"crc":0}}"#,
    )
    .unwrap();
    assert!(matches!(
        req,
        HubRequest::PtyOpen {
            spawn: Some(_),
            resume: Some(_),
            ..
        }
    ));

    let mut summary = summary_acp();
    summary["state"] = json!("running");
    summary["acp"]["usage"] = json!({"used": 1});
    summary["acp"]["pending"][0]["extra"] = json!(true);
    summary["acp"]["last"]["tokens"] = json!(10);
    let parsed: Summary = serde_json::from_value(summary).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), summary_acp());

    let mut summary = summary_pty_alive();
    summary["pty"]["fg"]["tty"] = json!("pts/3");
    let parsed: Summary = serde_json::from_value(summary).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), summary_pty_alive());

    let msg: HubMessage = serde_json::from_str(
        r#"{"t":"hello","proto":1,"server":"wb-hub","version":"0.1.0","host":"example",
            "pid":1,"startedAt":2,"agents":[{"name":"a","label":"A","icon":"x"}],"tz":"UTC"}"#,
    )
    .unwrap();
    assert!(matches!(msg, HubMessage::Hello { .. }));
    let msg: HubMessage =
        serde_json::from_str(r#"{"t":"gone","sid":"n_1","epoch":3,"why":"forget"}"#).unwrap();
    assert!(matches!(msg, HubMessage::Gone { epoch: 3, .. }));
}

#[test]
fn unknown_enum_values_are_unknown() {
    assert_eq!(
        serde_json::from_value::<ErrorCode>(json!("rate_limited")).unwrap(),
        ErrorCode::Unknown
    );
    assert_eq!(
        serde_json::from_value::<ExitReason>(json!("oom")).unwrap(),
        ExitReason::Unknown
    );
    let mut summary = summary_acp_fresh_faulted();
    summary["kind"] = json!("board");
    summary["fault"]["code"] = json!("disk_gone");
    summary["acp"]["activity"] = json!("compacting");
    summary["acp"]["pending"][0]["kind"] = json!("question");
    let parsed: Summary = serde_json::from_value(summary).unwrap();
    assert_eq!(parsed.kind, Kind::Unknown);
    assert_eq!(parsed.fault.unwrap().code, FaultCode::Unknown);
    let acp = parsed.acp.unwrap();
    assert_eq!(acp.activity, Activity::Unknown);
    assert_eq!(acp.pending[0].kind, PendingKind::Unknown);
}

#[test]
fn missing_rid_is_an_error() {
    assert!(serde_json::from_str::<HubRequest>(r#"{"t":"list"}"#).is_err());
    assert!(serde_json::from_str::<HubRequest>(r#"{"rid":1}"#).is_err());
}
