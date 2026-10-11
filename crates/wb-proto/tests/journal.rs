//! Every journal event kind round-trips unchanged, and unknown kinds, fields and enum
//! values never fail a reader.

use serde_json::{Value, json};
use wb_proto::hub::ExitReason;
use wb_proto::journal::*;
use wb_proto::line;

/// Parses `json` as a journal line, encodes it again with `line::encode`, and asserts
/// that the result is the same JSON value.
fn round_trip(json: Value) -> JournalEvent {
    let text = json.to_string();
    let parsed: JournalEvent =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}: {text}"));
    let back: Value = serde_json::from_slice(&line::encode(&parsed)).unwrap();
    assert_eq!(back, json);
    parsed
}

/// A journal line `{"seq":seq,"ts":…,"e":e,…payload}`.
fn ev(seq: u64, e: &str, payload: Value) -> Value {
    let mut line = json!({"seq": seq, "ts": 1791460000000u64 + seq, "e": e});
    line.as_object_mut()
        .unwrap()
        .extend(payload.as_object().unwrap().clone());
    line
}

fn tool_call() -> Value {
    json!({
        "toolCallId": "call_1", "title": "Run `rm -rf build`", "kind": "execute",
        "status": "pending", "rawInput": {"command": "rm -rf build"}
    })
}

fn options() -> Value {
    json!([
        {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
        {"optionId": "always", "name": "Always allow", "kind": "allow_always"},
        {"optionId": "reject", "name": "Reject", "kind": "reject_once"}
    ])
}

fn rpc_error() -> Value {
    json!({"code": -32000, "message": "Authentication required", "data": {"methods": ["login"]}})
}

#[test]
fn spawn() {
    let e = round_trip(ev(1, "spawn", json!({"pid": 4242, "via": "new"})));
    assert_eq!((e.seq, e.ts), (1, 1791460000001));
    assert_eq!(
        e.body,
        EventBody::Spawn {
            pid: 4242,
            via: SpawnVia::New
        }
    );
    let e = round_trip(ev(9, "spawn", json!({"pid": 1, "via": "revive"})));
    assert!(matches!(
        e.body,
        EventBody::Spawn {
            via: SpawnVia::Revive,
            ..
        }
    ));
}

#[test]
fn session() {
    let e = round_trip(ev(
        2,
        "session",
        json!({
            "via": "new", "sessionId": "c0ffee",
            "modes": {"currentModeId": "default",
                      "availableModes": [{"id": "default", "name": "Default", "description": null}]},
            "configOptions": [{"id": "model", "currentValue": "opus"}]
        }),
    ));
    let EventBody::Session {
        via,
        session_id,
        modes,
        config_options,
    } = e.body
    else {
        panic!("{e:?}")
    };
    assert_eq!(via, SessionVia::New);
    assert_eq!(session_id, "c0ffee");
    assert_eq!(modes.unwrap()["currentModeId"], "default");
    assert_eq!(config_options.unwrap()[0]["id"], "model");

    for via in ["resume", "load"] {
        let e = round_trip(ev(3, "session", json!({"via": via, "sessionId": "c0ffee"})));
        let EventBody::Session {
            via,
            modes,
            config_options,
            ..
        } = e.body
        else {
            panic!("{e:?}")
        };
        assert_ne!(via, SessionVia::Unknown);
        assert_eq!((modes, config_options), (None, None));
    }
}

#[test]
fn setup_error() {
    let e = round_trip(ev(
        3,
        "setup_error",
        json!({"code": "auth_required", "message": "Authentication required", "rpc": rpc_error()}),
    ));
    let EventBody::SetupError { code, message, rpc } = e.body else {
        panic!("{e:?}")
    };
    assert_eq!(code, SetupErrorCode::AuthRequired);
    assert_eq!(message, "Authentication required");
    assert_eq!(rpc.unwrap()["code"], -32000);

    for (wire, code) in [
        ("agent_error", SetupErrorCode::AgentError),
        ("timeout", SetupErrorCode::Timeout),
        ("revive_failed", SetupErrorCode::ReviveFailed),
        ("spawn_failed", SetupErrorCode::SpawnFailed),
        ("agent_exited", SetupErrorCode::AgentExited),
        ("interrupted", SetupErrorCode::Interrupted),
    ] {
        let e = round_trip(ev(4, "setup_error", json!({"code": wire, "message": "m"})));
        assert_eq!(
            e.body,
            EventBody::SetupError {
                code,
                message: "m".into(),
                rpc: None
            }
        );
    }
}

#[test]
fn authenticate() {
    let e = round_trip(ev(4, "authenticate", json!({"methodId": "chatgpt"})));
    assert_eq!(
        e.body,
        EventBody::Authenticate {
            method_id: "chatgpt".into()
        }
    );
}

#[test]
fn prompt() {
    let blocks = json!([
        {"type": "text", "text": "Fix the flaky test"},
        {"type": "resource_link", "uri": "file:///home/alice/proj/x/a.rs", "name": "a.rs"},
        {"type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo="}
    ]);
    let e = round_trip(ev(5, "prompt", json!({"prompt": blocks})));
    let EventBody::Prompt { prompt } = e.body else {
        panic!("{e:?}")
    };
    assert_eq!(prompt.len(), 3);
    assert_eq!(prompt[1]["type"], "resource_link");
}

#[test]
fn update() {
    let chunk = json!({
        "sessionUpdate": "agent_message_chunk", "messageId": "m1",
        "content": {"type": "text", "text": "Looking at the test…"}
    });
    let e = round_trip(ev(6, "update", json!({"update": chunk})));
    assert_eq!(
        e.body,
        EventBody::Update {
            update: chunk,
            session_id: None
        }
    );

    let sub = json!({"sessionUpdate": "tool_call", "toolCallId": "t9", "title": "grep"});
    let e = round_trip(ev(
        7,
        "update",
        json!({"update": sub, "sessionId": "child-1"}),
    ));
    let EventBody::Update { session_id, .. } = e.body else {
        panic!("{e:?}")
    };
    assert_eq!(session_id.as_deref(), Some("child-1"));

    // An update variant nobody knows yet is carried verbatim.
    let future = json!({"sessionUpdate": "hologram", "frames": [1, 2, {"z": null}]});
    round_trip(ev(8, "update", json!({"update": future})));
}

#[test]
fn turn_end() {
    for reason in [
        "end_turn",
        "max_tokens",
        "max_turn_requests",
        "refusal",
        "cancelled",
        "a_future_reason",
    ] {
        let e = round_trip(ev(9, "turn_end", json!({"stopReason": reason})));
        assert_eq!(
            e.body,
            EventBody::TurnEnd {
                stop_reason: reason.into()
            }
        );
    }
}

#[test]
fn turn_error() {
    let rpc = json!({"code": -32603, "message": "Internal error"});
    let e = round_trip(ev(
        10,
        "turn_error",
        json!({"code": "agent_error", "message": "Internal error", "rpc": rpc}),
    ));
    assert_eq!(
        e.body,
        EventBody::TurnError {
            code: TurnErrorCode::AgentError,
            message: "Internal error".into(),
            rpc: Some(rpc)
        }
    );
    for (wire, code) in [
        ("agent_exited", TurnErrorCode::AgentExited),
        ("interrupted", TurnErrorCode::Interrupted),
    ] {
        let e = round_trip(ev(11, "turn_error", json!({"code": wire, "message": "m"})));
        assert!(matches!(e.body, EventBody::TurnError { code: c, rpc: None, .. } if c == code));
    }
}

#[test]
fn permission_and_resolution() {
    let e = round_trip(ev(
        12,
        "permission",
        json!({"toolCall": tool_call(), "options": options()}),
    ));
    let EventBody::Permission {
        tool_call: call,
        options,
    } = e.body
    else {
        panic!("{e:?}")
    };
    assert_eq!(call["title"], "Run `rm -rf build`");
    assert_eq!(options.len(), 3);

    let selected = json!({"outcome": "selected", "optionId": "allow"});
    let e = round_trip(ev(
        13,
        "permission_resolved",
        json!({"req": 12, "outcome": selected, "by": "user"}),
    ));
    assert_eq!(
        e.body,
        EventBody::PermissionResolved {
            req: 12,
            outcome: selected,
            by: ResolvedBy::User
        }
    );
    for (wire, by) in [
        ("cancel", ResolvedBy::Cancel),
        ("hub", ResolvedBy::Hub),
        ("agent", ResolvedBy::Agent),
    ] {
        let e = round_trip(ev(
            14,
            "permission_resolved",
            json!({"req": 12, "outcome": {"outcome": "cancelled"}, "by": wire}),
        ));
        assert!(matches!(e.body, EventBody::PermissionResolved { by: b, .. } if b == by));
    }
}

#[test]
fn elicitation_and_resolution() {
    let form = json!({
        "sessionId": "c0ffee", "mode": "form", "message": "Pick a branch",
        "requestedSchema": {"type": "object",
                            "properties": {"branch": {"type": "string", "enum": ["main", "dev"]}},
                            "required": ["branch"]}
    });
    let e = round_trip(ev(15, "elicitation", json!({"request": form})));
    assert_eq!(e.body, EventBody::Elicitation { request: form });

    let url = json!({
        "mode": "url", "message": "Sign in", "url": "https://example.org/device",
        "elicitationId": "el-1"
    });
    round_trip(ev(16, "elicitation", json!({"request": url})));

    let accept = json!({"action": "accept", "content": {"branch": "dev", "n": 3, "ok": true,
                                                       "tags": ["a", "b"]}});
    let e = round_trip(ev(
        17,
        "elicitation_resolved",
        json!({"req": 15, "response": accept, "by": "user"}),
    ));
    assert_eq!(
        e.body,
        EventBody::ElicitationResolved {
            req: 15,
            response: accept,
            by: ResolvedBy::User
        }
    );
    for response in [json!({"action": "decline"}), json!({"action": "cancel"})] {
        round_trip(ev(
            18,
            "elicitation_resolved",
            json!({"req": 16, "response": response, "by": "hub"}),
        ));
    }

    let e = round_trip(ev(
        19,
        "elicitation_complete",
        json!({"elicitationId": "el-1"}),
    ));
    assert_eq!(
        e.body,
        EventBody::ElicitationComplete {
            elicitation_id: "el-1".into()
        }
    );
}

#[test]
fn mode() {
    let e = round_trip(ev(20, "mode", json!({"modeId": "plan"})));
    assert_eq!(
        e.body,
        EventBody::Mode {
            mode_id: "plan".into()
        }
    );
}

#[test]
fn notice() {
    for (wire, level) in [
        ("info", NoticeLevel::Info),
        ("warn", NoticeLevel::Warn),
        ("error", NoticeLevel::Error),
    ] {
        let e = round_trip(ev(
            21,
            "notice",
            json!({"level": wire, "text": "revived via session/load"}),
        ));
        assert_eq!(
            e.body,
            EventBody::Notice {
                level,
                text: "revived via session/load".into()
            }
        );
    }
}

#[test]
fn exit() {
    let e = round_trip(ev(
        22,
        "exit",
        json!({"code": 0, "signal": null, "reason": "exited"}),
    ));
    assert_eq!(
        e.body,
        EventBody::Exit {
            code: Some(0),
            signal: None,
            reason: ExitReason::Exited
        }
    );
    let e = round_trip(ev(
        23,
        "exit",
        json!({"code": null, "signal": 9, "reason": "killed"}),
    ));
    assert!(matches!(
        e.body,
        EventBody::Exit {
            code: None,
            signal: Some(9),
            reason: ExitReason::Killed
        }
    ));
    let e = round_trip(ev(
        24,
        "exit",
        json!({"code": null, "signal": null, "reason": "hub_restart"}),
    ));
    assert!(matches!(
        e.body,
        EventBody::Exit {
            reason: ExitReason::HubRestart,
            ..
        }
    ));
}

/// The exact line the hub appends for an event, and no `sessionId` key on an update
/// that does not carry one.
#[test]
fn encoded_line_shape() {
    let e = JournalEvent {
        seq: 1,
        ts: 2,
        body: EventBody::Spawn {
            pid: 3,
            via: SpawnVia::New,
        },
    };
    assert_eq!(
        line::encode(&e),
        br#"{"seq":1,"ts":2,"e":"spawn","pid":3,"via":"new"}
"#
    );
    let e = JournalEvent {
        seq: 5,
        ts: 6,
        body: EventBody::Update {
            update: json!({"sessionUpdate": "plan", "entries": []}),
            session_id: None,
        },
    };
    let text = String::from_utf8(line::encode(&e)).unwrap();
    assert!(!text.contains("sessionId"), "{text}");
}

#[test]
fn unknown_e_is_unknown_and_keeps_seq_and_ts() {
    let e: JournalEvent = serde_json::from_str(
        r#"{"seq":31,"ts":1791460000031,"e":"compaction","summary":{"tokens":10},"x":[1]}"#,
    )
    .unwrap();
    assert_eq!((e.seq, e.ts), (31, 1791460000031));
    assert_eq!(e.body, EventBody::Unknown);
}

#[test]
fn missing_seq_ts_e_or_payload_fields_are_errors() {
    for line in [
        r#"{"ts":1,"e":"mode","modeId":"plan"}"#,
        r#"{"seq":1,"e":"mode","modeId":"plan"}"#,
        r#"{"seq":1,"ts":1,"modeId":"plan"}"#,
        r#"{"seq":1,"ts":1,"e":"mode"}"#,
    ] {
        assert!(
            serde_json::from_str::<JournalEvent>(line).is_err(),
            "{line}"
        );
    }
}

#[test]
fn unknown_fields_are_ignored() {
    let e: JournalEvent = serde_json::from_str(
        r#"{"seq":1,"ts":2,"e":"spawn","pid":3,"via":"new","argv":["claude"],"v":2}"#,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&e).unwrap(),
        json!({"seq": 1, "ts": 2, "e": "spawn", "pid": 3, "via": "new"})
    );
    let e: JournalEvent = serde_json::from_str(
        r#"{"seq":4,"ts":5,"e":"exit","code":1,"signal":null,"reason":"exited","core":true}"#,
    )
    .unwrap();
    assert!(matches!(e.body, EventBody::Exit { code: Some(1), .. }));
}

#[test]
fn unknown_enum_values_are_unknown() {
    let body = |line: Value| serde_json::from_value::<JournalEvent>(line).unwrap().body;
    assert!(matches!(
        body(ev(1, "spawn", json!({"pid": 1, "via": "fork"}))),
        EventBody::Spawn {
            via: SpawnVia::Unknown,
            ..
        }
    ));
    assert!(matches!(
        body(ev(2, "session", json!({"via": "fork", "sessionId": "s"}))),
        EventBody::Session {
            via: SessionVia::Unknown,
            ..
        }
    ));
    assert!(matches!(
        body(ev(
            3,
            "setup_error",
            json!({"code": "quota", "message": "m"})
        )),
        EventBody::SetupError {
            code: SetupErrorCode::Unknown,
            ..
        }
    ));
    assert!(matches!(
        body(ev(
            4,
            "turn_error",
            json!({"code": "timeout", "message": "m"})
        )),
        EventBody::TurnError {
            code: TurnErrorCode::Unknown,
            ..
        }
    ));
    assert!(matches!(
        body(ev(
            5,
            "permission_resolved",
            json!({"req": 1, "outcome": {}, "by": "policy"})
        )),
        EventBody::PermissionResolved {
            by: ResolvedBy::Unknown,
            ..
        }
    ));
    assert!(matches!(
        body(ev(
            6,
            "elicitation_resolved",
            json!({"req": 1, "response": {}, "by": "policy"})
        )),
        EventBody::ElicitationResolved {
            by: ResolvedBy::Unknown,
            ..
        }
    ));
    assert!(matches!(
        body(ev(7, "notice", json!({"level": "debug", "text": "t"}))),
        EventBody::Notice {
            level: NoticeLevel::Unknown,
            ..
        }
    ));
    assert!(matches!(
        body(ev(
            8,
            "exit",
            json!({"code": null, "signal": null, "reason": "oom"})
        )),
        EventBody::Exit {
            reason: ExitReason::Unknown,
            ..
        }
    ));
}
