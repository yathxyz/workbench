//! ACP: `wb-fake-acp` on its own (every scenario and keyword over stdio, every message
//! checked against the ACP schema), and the hub's ACP sessions against it (DESIGN §9.2,
//! 10-hub §11.3).

mod common;

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use common::acp::stub;
use common::acp::{fold_equals_live, group_members};
use common::fake::{Agent, text_of, updates};
use common::{Client, Hub, PATIENCE, eventually, running, wait_gone};

/// A cwd for the fake's sessions; it never touches it.
const CWD: &str = "/srv/example";

/// The fake after `initialize` and `session/new`, and its session id.
fn opened(args: &[&str]) -> (Agent, String) {
    let mut a = Agent::start(args);
    let new = a.open(CWD);
    let session = new["sessionId"].as_str().unwrap().to_owned();
    (a, session)
}

fn keywords() -> (Agent, String) {
    opened(&[])
}

fn scenario(name: &str) -> (Agent, String) {
    opened(&["--scenario", name])
}

/// Prompts `text` and collects the turn, answering nothing: the messages and the
/// `session/prompt` result.
fn turn(a: &mut Agent, session: &str, text: &str) -> (Vec<Value>, Value) {
    let id = a.prompt(session, text);
    let (msgs, response) = a.until_response(&id);
    assert!(response.get("error").is_none(), "{response}");
    (msgs, response["result"].clone())
}

fn selected(option: &str) -> Value {
    json!({"outcome": {"outcome": "selected", "optionId": option}})
}

fn cancelled() -> Value {
    json!({"outcome": {"outcome": "cancelled"}})
}

/// The content the `form` keyword quoted back after an `accept`.
fn form_content(updates: &[Value]) -> Value {
    let text = text_of(updates, "agent_message_chunk");
    let quoted = text
        .strip_prefix("form accept: ")
        .unwrap_or_else(|| panic!("{text}"));
    serde_json::from_str(quoted).unwrap()
}

// ---- the fake on its own ----

#[test]
fn schema_check_catches_what_the_schema_would_drop() {
    use agent_client_protocol_schema::v1::SessionNotification;
    use common::schema::conforms;
    let chunk = json!({"sessionId": "s", "update": {"sessionUpdate": "agent_message_chunk",
                       "messageId": "m", "content": {"type": "text", "text": "hi"}}});
    conforms::<SessionNotification>("chunk", &chunk);
    let mut unknown_key = chunk.clone();
    unknown_key["update"]["colour"] = "red".into();
    let bad_value = json!({"sessionId": "s", "update": {"sessionUpdate": "tool_call",
                           "toolCallId": "t", "title": "x", "status": "maybe"}});
    let mut missing = chunk.clone();
    missing["update"]["content"] = json!({"type": "text"});
    for (what, v) in [
        ("an unknown key", unknown_key),
        ("a bad value", bad_value),
        ("a missing field", missing),
    ] {
        let caught = std::panic::catch_unwind(|| conforms::<SessionNotification>(what, &v));
        assert!(caught.is_err(), "{what} passed: {v}");
    }
}

#[test]
fn fake_rejects_bad_arguments() {
    for args in [
        &["--scenario", "nope"][..],
        &["--scenario"],
        &["--record"],
        &["--bogus"],
    ] {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_wb-fake-acp"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("usage: wb-fake-acp"),
            "{args:?}"
        );
    }
}

#[test]
fn fake_speaks_only_when_spoken_to_and_records_names_not_values() {
    let mut a = Agent::start(&[]);
    assert!(a.quiet_for(Duration::from_millis(300)));
    a.close_stdin();
    let status = a.exit_within(PATIENCE).expect("exit at end of stdin");
    assert!(status.success(), "{status}");

    let record = a.record();
    let env = &record[0];
    assert_eq!(env["note"], "env", "{env}");
    assert_eq!(env["pid"], a.pid());
    assert_eq!(env["SHELL"], "/bin/sh");
    assert_eq!(env["WB_SESSION"], "fake-test");
    let names: Vec<&str> = env["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    assert_eq!(names, ["PATH", "SHELL", "WB_CANARY_SECRET", "WB_SESSION"]);
    assert_eq!(record.last().unwrap()["note"], "stdin_eof");
    let text = serde_json::to_string(&record).unwrap();
    assert!(
        !text.contains("canary-value"),
        "a value leaked into the record"
    );
}

#[test]
fn fake_defaults_advertise_load_resume_and_two_modes() {
    let mut a = Agent::start(&[]);
    let init = a.init();
    assert_eq!(init["protocolVersion"], 1);
    let caps = &init["agentCapabilities"];
    assert_eq!(caps["loadSession"], true);
    assert_eq!(caps["sessionCapabilities"], json!({"resume": {}}));
    assert_eq!(init["authMethods"], json!([]));
    assert_eq!(init["agentInfo"]["name"], "wb-fake-acp");

    let (_, new) = a.call("session/new", json!({"cwd": CWD, "mcpServers": []}));
    assert!(
        new["sessionId"]
            .as_str()
            .unwrap()
            .starts_with("fake-session-")
    );
    assert_eq!(new["modes"]["currentModeId"], "default");
    let modes: Vec<&Value> = new["modes"]["availableModes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| &m["id"])
        .collect();
    assert_eq!(modes, ["default", "plan"]);

    // The record holds what the fake received, verbatim.
    let received: Vec<Value> = a
        .record()
        .iter()
        .filter_map(|e| e.get("recv").cloned())
        .collect();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0]["params"], common::fake::initialize_params());
    assert_eq!(received[1]["params"], json!({"cwd": CWD, "mcpServers": []}));
}

#[test]
fn keyword_stream_titles_the_session_once_and_echo_answers_the_rest() {
    let (mut a, session) = keywords();
    let (msgs, result) = turn(&mut a, &session, "Please stream something");
    assert_eq!(result["stopReason"], "end_turn");
    let ups = updates(&msgs);
    assert_eq!(ups.len(), 4, "{ups:?}");
    assert_eq!(ups[0]["sessionUpdate"], "session_info_update");
    assert_eq!(ups[0]["title"], "Please stream something");
    assert_eq!(
        text_of(&ups, "agent_message_chunk"),
        "Streaming three chunks."
    );
    assert!(
        ups[1..]
            .iter()
            .all(|u| u["messageId"] == ups[1]["messageId"])
    );
    assert!(msgs.iter().all(|m| m["params"]["sessionId"] == session));

    let (msgs, result) = turn(&mut a, &session, "hello there");
    assert_eq!(result["stopReason"], "end_turn");
    let ups = updates(&msgs);
    assert_eq!(ups.len(), 1, "{ups:?}");
    assert_eq!(text_of(&ups, "agent_message_chunk"), "echo: hello there");
    assert_ne!(ups[0]["messageId"], "msg-1");
}

#[test]
fn keyword_tool_runs_a_tool_call_to_a_diff() {
    let (mut a, session) = keywords();
    let (msgs, result) = turn(&mut a, &session, "use a tool");
    assert_eq!(result["stopReason"], "end_turn");
    let ups = updates(&msgs);
    let tool: Vec<&Value> = ups
        .iter()
        .filter(|u| {
            u["sessionUpdate"]
                .as_str()
                .unwrap()
                .starts_with("tool_call")
        })
        .collect();
    assert_eq!(tool.len(), 3, "{ups:?}");
    assert_eq!(tool[0]["sessionUpdate"], "tool_call");
    assert_eq!(tool[0]["status"], "pending");
    assert_eq!(tool[0]["kind"], "edit");
    assert_eq!(tool[0]["locations"][0]["path"], format!("{CWD}/notes.txt"));
    assert_eq!(tool[1]["status"], "in_progress");
    assert_eq!(tool[2]["status"], "completed");
    let diff = &tool[2]["content"][0];
    assert_eq!(diff["type"], "diff");
    assert_eq!(diff["oldText"], "alpha\nbeta\ngamma\n");
    assert_eq!(diff["newText"], "alpha\nBETA\ngamma\ndelta\n");
    assert!(
        tool.iter()
            .all(|t| t["toolCallId"] == tool[0]["toolCallId"])
    );
}

#[test]
fn keyword_perm_follows_the_answer() {
    let (mut a, session) = keywords();
    for (answer, status, stop) in [
        (selected("allow-once"), "completed", "end_turn"),
        (selected("allow-always"), "completed", "end_turn"),
        (selected("reject-once"), "failed", "end_turn"),
        (cancelled(), "failed", "cancelled"),
    ] {
        let id = a.prompt(&session, "perm");
        let (before, req) = a.until_request();
        assert_eq!(req["method"], "session/request_permission");
        let params = &req["params"];
        assert_eq!(params["sessionId"], session);
        assert_eq!(params["toolCall"]["title"], "Run `rm -rf build`");
        let kinds: Vec<&Value> = params["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| &o["kind"])
            .collect();
        assert_eq!(kinds, ["allow_once", "allow_always", "reject_once"]);
        let announced = updates(&before);
        assert!(
            announced.iter().any(|u| u["sessionUpdate"] == "tool_call"
                && u["toolCallId"] == params["toolCall"]["toolCallId"]),
            "{announced:?}"
        );
        if answer == cancelled() {
            a.notify("session/cancel", json!({"sessionId": session}));
        }
        a.respond(&req["id"], answer);
        let (msgs, response) = a.until_response(&id);
        assert_eq!(response["result"]["stopReason"], stop);
        assert_eq!(updates(&msgs)[0]["status"], status);
    }
}

#[test]
fn keyword_ask_permission_answers_pong() {
    let (mut a, session) = keywords();
    let id = a.prompt(&session, "ask-permission, then reply");
    let (_, req) = a.until_request();
    assert_eq!(req["method"], "session/request_permission");
    a.respond(&req["id"], selected("reject-once"));
    let (msgs, response) = a.until_response(&id);
    assert_eq!(response["result"]["stopReason"], "end_turn");
    assert_eq!(text_of(&updates(&msgs), "agent_message_chunk"), "PONG");
}

#[test]
fn keyword_form_echoes_the_content() {
    let (mut a, session) = keywords();
    let id = a.prompt(&session, "fill a form");
    let (_, req) = a.until_request();
    assert_eq!(req["method"], "elicitation/create");
    let params = &req["params"];
    assert_eq!(params["mode"], "form");
    assert_eq!(params["sessionId"], session);
    let props = &params["requestedSchema"]["properties"];
    assert_eq!(props["colour"]["enum"], json!(["red", "green", "blue"]));
    assert_eq!(props["count"]["type"], "integer");
    assert_eq!(props["verbose"]["type"], "boolean");
    assert_eq!(props["targets"]["type"], "array");
    assert_eq!(params["requestedSchema"]["required"], json!(["colour"]));
    let content = json!({"colour": "green", "count": 3, "verbose": true, "targets": ["aarch64"]});
    a.respond(&req["id"], json!({"action": "accept", "content": content}));
    let (msgs, _) = a.until_response(&id);
    assert_eq!(form_content(&updates(&msgs)), content);

    let id = a.prompt(&session, "form");
    let (_, req) = a.until_request();
    a.respond(&req["id"], json!({"action": "decline"}));
    let (msgs, _) = a.until_response(&id);
    assert_eq!(
        text_of(&updates(&msgs), "agent_message_chunk"),
        "form decline"
    );
}

#[test]
fn keyword_url_completes_after_accept() {
    let (mut a, session) = keywords();
    let id = a.prompt(&session, "open a url");
    let (_, req) = a.until_request();
    let params = &req["params"];
    assert_eq!(params["mode"], "url");
    assert_eq!(params["url"], "https://example.org/wb-fake-acp/consent");
    let elicitation = params["elicitationId"].clone();
    a.respond(&req["id"], json!({"action": "accept"}));
    let accepted = Instant::now();
    let (msgs, _) = a.until_response(&id);
    assert!(accepted.elapsed() >= Duration::from_secs(1));
    assert_eq!(msgs[0]["method"], "elicitation/complete");
    assert_eq!(msgs[0]["params"]["elicitationId"], elicitation);
    assert_eq!(
        text_of(&updates(&msgs), "agent_message_chunk"),
        "url accept"
    );

    let id = a.prompt(&session, "url, javascript please");
    let (_, req) = a.until_request();
    assert_eq!(req["params"]["url"], "javascript:alert(1)");
    a.respond(&req["id"], json!({"action": "cancel"}));
    let (msgs, _) = a.until_response(&id);
    assert!(msgs.iter().all(|m| m["method"] != "elicitation/complete"));
    assert_eq!(
        text_of(&updates(&msgs), "agent_message_chunk"),
        "url cancel"
    );
}

#[test]
fn keyword_slow_stops_on_cancel() {
    let (mut a, session) = keywords();
    let id = a.prompt(&session, "slow");
    for _ in 0..3 {
        assert_eq!(a.next()["method"], "session/update");
    }
    a.notify("session/cancel", json!({"sessionId": session}));
    let cancelled_at = Instant::now();
    let (_, response) = a.until_response(&id);
    assert_eq!(response["result"]["stopReason"], "cancelled");
    assert!(cancelled_at.elapsed() < Duration::from_secs(1));
}

#[test]
fn keyword_set_mode_reports_the_mode_and_set_mode_scenario_does_not() {
    let (mut a, session) = keywords();
    let (_, result) = a.call(
        "session/set_mode",
        json!({"sessionId": session, "modeId": "plan"}),
    );
    assert_eq!(result, json!({}));
    let update = a.next();
    assert_eq!(
        update["params"]["update"],
        json!({"sessionUpdate": "current_mode_update", "currentModeId": "plan"})
    );
    let id = a.request(
        "session/set_mode",
        json!({"sessionId": session, "modeId": "nope"}),
    );
    let (_, response) = a.until_response(&id);
    assert_eq!(response["error"]["code"], -32602);

    let (mut a, session) = scenario("set-mode");
    a.call(
        "session/set_mode",
        json!({"sessionId": session, "modeId": "plan"}),
    );
    assert!(a.quiet_for(Duration::from_millis(300)));
}

#[test]
fn fake_config_options_conform_for_initial_grouped_boolean_and_runtime_changes() {
    let mut a = Agent::start(&["--scenario", "config"]);
    let opened = a.open(CWD);
    let session = opened["sessionId"].as_str().unwrap();
    let options = &opened["configOptions"];
    assert_eq!(options[0]["options"][1]["options"][0]["value"], "large");
    assert_eq!(options[2]["currentValue"], false);
    let (messages, result) = a.call(
        "session/set_config_option",
        json!({"sessionId": session, "configId": "model", "value": "large"}),
    );
    assert_eq!(
        updates(&messages)[0]["sessionUpdate"],
        "config_option_update"
    );
    assert_eq!(result["configOptions"][0]["currentValue"], "large");
    assert_eq!(result["configOptions"][1]["options"][2]["value"], "max");
    let (_, result) = a.call(
        "session/set_config_option",
        json!({"sessionId": session, "configId": "thinking", "type": "boolean", "value": true}),
    );
    assert_eq!(result["configOptions"][2]["currentValue"], true);
}

#[test]
fn scenario_basic_streams_three_chunks() {
    let (mut a, session) = scenario("basic");
    let (msgs, result) = turn(&mut a, &session, "perm form url");
    assert_eq!(result["stopReason"], "end_turn");
    let ups = updates(&msgs);
    assert_eq!(ups.len(), 3);
    assert_eq!(
        text_of(&ups, "agent_message_chunk"),
        "Streaming three chunks."
    );
}

#[test]
fn scenario_noise_writes_junk_before_a_crlf_response() {
    let mut a = Agent::scenario("noise");
    let id = a.request("initialize", common::fake::initialize_params());
    let tracing = a.next_raw().unwrap();
    assert!(tracing.starts_with(b"\x1b["));
    assert!(String::from_utf8_lossy(&tracing).contains("wb_fake_acp: starting up"));
    assert!(std::str::from_utf8(&a.next_raw().unwrap()).is_err());
    let huge = a.next_raw().unwrap();
    assert_eq!(huge.len(), wb_proto::limits::MAX_LINE + (1 << 20) + 1);
    let array: Value = serde_json::from_slice(&a.next_raw().unwrap()).unwrap();
    assert!(array.is_array());
    let line = a.next_raw().unwrap();
    assert!(line.ends_with(b"}\r\n"));
    let response = a.parse(&line);
    assert_eq!(response["id"], id);
    assert_eq!(response["result"]["protocolVersion"], 1);
    a.call("session/new", json!({"cwd": CWD, "mcpServers": []}));
}

#[test]
fn scenario_permission_asks_with_three_options() {
    let (mut a, session) = scenario("permission");
    let id = a.prompt(&session, "anything");
    let (_, req) = a.until_request();
    assert_eq!(req["params"]["options"].as_array().unwrap().len(), 3);
    a.respond(&req["id"], selected("allow-once"));
    let (_, response) = a.until_response(&id);
    assert_eq!(response["result"]["stopReason"], "end_turn");
    // The record holds the fake's request and exactly one answer, and passes the check
    // the hub tests run on it.
    let received = common::acp::received(&a.record());
    let answers: Vec<&Value> = received
        .iter()
        .filter(|m| m["id"] == req["id"] && m.get("result").is_some())
        .collect();
    assert_eq!(answers.len(), 1);
    let sent: Vec<Value> = a
        .record()
        .iter()
        .filter_map(|e| e.get("sent").cloned())
        .collect();
    assert_eq!(sent, [req]);
}

#[test]
fn scenario_permission_reconnect_asks_at_120_of_200() {
    let (mut a, session) = scenario("permission-reconnect");
    let id = a.prompt(&session, "go");
    let (before, req) = a.until_request();
    let ids: Vec<String> = updates(&before)
        .iter()
        .map(|u| u["messageId"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids.len(), 116);
    assert_eq!(ids[0], "m1");
    assert_eq!(ids[115], "m116");
    for i in 117..=196 {
        let m = a.next();
        assert_eq!(m["params"]["update"]["messageId"], format!("m{i}"));
    }
    // A fresh session journals spawn, session and prompt first: the request is seq 120
    // and the last chunk seq 200.
    assert!(a.quiet_for(Duration::from_millis(200)));
    a.respond(&req["id"], selected("allow-always"));
    let (msgs, response) = a.until_response(&id);
    assert!(msgs.is_empty(), "{msgs:?}");
    assert_eq!(response["result"]["stopReason"], "end_turn");
}

#[test]
fn scenario_agent_cancels_withdraws_its_request() {
    let (mut a, session) = scenario("agent-cancels");
    let id = a.prompt(&session, "go");
    let (_, req) = a.until_request();
    assert_eq!(req["id"], "perm-1");
    let withdraw = a.next();
    assert_eq!(withdraw["method"], "$/cancel_request");
    assert_eq!(withdraw["params"], json!({"requestId": "perm-1"}));
    a.respond(&req["id"], cancelled());
    let (msgs, response) = a.until_response(&id);
    assert_eq!(response["result"]["stopReason"], "end_turn");
    assert_eq!(updates(&msgs).len(), 1);
    let received = common::acp::received(&a.record());
    assert_eq!(received.last().unwrap()["id"], "perm-1");
}

#[test]
fn scenario_elicitation_authenticates_through_a_request_scoped_form() {
    let mut a = Agent::scenario("elicitation");
    let init = a.init();
    assert_eq!(init["authMethods"][0]["id"], "fake-login");
    let new = json!({"cwd": CWD, "mcpServers": []});
    let id = a.request("session/new", new.clone());
    assert_eq!(a.until_response(&id).1["error"]["code"], -32000);

    let auth = a.request("authenticate", json!({"methodId": "fake-login"}));
    let (_, req) = a.until_request();
    assert_eq!(req["method"], "elicitation/create");
    assert_eq!(req["params"]["requestId"], auth);
    assert!(req["params"].get("sessionId").is_none());
    a.respond(&req["id"], json!({"action": "decline"}));
    assert_eq!(a.until_response(&auth).1["error"]["code"], -32000);

    let auth = a.request("authenticate", json!({"methodId": "fake-login"}));
    let (_, req) = a.until_request();
    a.respond(
        &req["id"],
        json!({"action": "accept", "content": {"token": "t"}}),
    );
    assert_eq!(a.until_response(&auth).1["result"], json!({}));
    let (_, new) = a.call("session/new", new);
    let session = new["sessionId"].as_str().unwrap().to_owned();

    // Prompts use the keywords.
    let id = a.prompt(&session, "form");
    let (_, req) = a.until_request();
    assert_eq!(req["params"]["sessionId"], session);
    a.respond(&req["id"], json!({"action": "cancel"}));
    a.until_response(&id);
    common::acp::received(&a.record());
}

#[test]
fn scenario_cancel_ends_cancelled() {
    let (mut a, session) = scenario("cancel");
    let id = a.prompt(&session, "go");
    let (_, req) = a.until_request();
    a.notify("session/cancel", json!({"sessionId": session}));
    a.respond(&req["id"], cancelled());
    let (_, response) = a.until_response(&id);
    assert_eq!(response["result"]["stopReason"], "cancelled");
    let received: Vec<Value> = a
        .record()
        .iter()
        .filter_map(|e| e.get("recv").cloned())
        .collect();
    let n = received.len();
    assert_eq!(received[n - 2]["method"], "session/cancel");
    assert_eq!(received[n - 1]["result"], cancelled());
}

#[test]
fn scenario_crash_midturn_exits_1_after_boom() {
    let (mut a, session) = scenario("crash-midturn");
    a.prompt(&session, "go");
    let (_, req) = a.until_request();
    assert_eq!(req["method"], "session/request_permission");
    assert_eq!(a.next_raw(), None);
    let status = a.exit_within(PATIENCE).unwrap();
    assert_eq!(status.code(), Some(1));
    assert_eq!(a.stderr(), "boom\n");
}

#[test]
fn scenario_auth_needs_fake_login_first() {
    let mut a = Agent::scenario("auth");
    let init = a.init();
    assert_eq!(init["authMethods"].as_array().unwrap().len(), 1);
    assert!(init["authMethods"][0].get("type").is_none());
    let new = json!({"cwd": CWD, "mcpServers": []});
    let id = a.request("session/new", new.clone());
    let refused = a.until_response(&id).1;
    assert_eq!(refused["error"]["code"], -32000);
    let id = a.request("authenticate", json!({"methodId": "other"}));
    assert_eq!(a.until_response(&id).1["error"]["code"], -32602);
    assert_eq!(
        a.call("authenticate", json!({"methodId": "fake-login"})).1,
        json!({})
    );
    a.call("session/new", new);
}

#[test]
fn scenario_auth_terminal_offers_only_a_terminal_method() {
    let mut a = Agent::scenario("auth-terminal");
    let init = a.init();
    assert_eq!(init["authMethods"][0]["type"], "terminal");
    assert_eq!(init["authMethods"].as_array().unwrap().len(), 1);
    let id = a.request("session/new", json!({"cwd": CWD, "mcpServers": []}));
    assert_eq!(a.until_response(&id).1["error"]["code"], -32000);
    let id = a.request("authenticate", json!({"methodId": "fake-terminal"}));
    assert_eq!(a.until_response(&id).1["error"]["code"], -32602);
}

#[test]
fn scenario_revive_resume_adopts_the_session() {
    let mut a = Agent::scenario("revive-resume");
    a.init();
    let (msgs, result) = a.call(
        "session/resume",
        json!({"sessionId": "earlier-session", "cwd": CWD}),
    );
    assert!(msgs.is_empty());
    assert_eq!(result["modes"]["currentModeId"], "default");
    let (msgs, _) = turn(&mut a, "earlier-session", "go");
    assert!(
        msgs.iter()
            .all(|m| m["params"]["sessionId"] == "earlier-session")
    );
}

#[test]
fn scenario_revive_load_replays_history_without_resume() {
    let mut a = Agent::scenario("revive-load");
    let init = a.init();
    assert_eq!(init["agentCapabilities"]["loadSession"], true);
    assert!(
        init["agentCapabilities"]["sessionCapabilities"]
            .get("resume")
            .is_none()
    );
    let (msgs, result) = a.call(
        "session/load",
        json!({"sessionId": "earlier-session", "cwd": CWD, "mcpServers": []}),
    );
    let ups = updates(&msgs);
    assert_eq!(ups.len(), 51);
    let count = |kind: &str| ups.iter().filter(|u| u["sessionUpdate"] == kind).count();
    assert_eq!(count("user_message_chunk"), 25);
    assert_eq!(count("agent_message_chunk"), 25);
    assert_eq!(ups[50]["sessionUpdate"], "available_commands_update");
    assert!(
        msgs.iter()
            .all(|m| m["params"]["sessionId"] == "earlier-session")
    );
    assert_eq!(result["modes"]["currentModeId"], "default");
}

#[test]
fn scenario_revive_fail_fails_resume_and_load() {
    let mut a = Agent::scenario("revive-fail");
    a.init();
    for method in ["session/resume", "session/load"] {
        let id = a.request(
            method,
            json!({"sessionId": "earlier-session", "cwd": CWD, "mcpServers": []}),
        );
        let (msgs, response) = a.until_response(&id);
        assert!(msgs.is_empty());
        assert_eq!(response["error"]["code"], -32002, "{method}");
    }
}

#[test]
fn scenario_unknown_sends_what_no_client_knows() {
    let (mut a, session) = scenario("unknown");
    let id = a.prompt(&session, "go");
    let (before, req) = a.until_request();
    assert_eq!(updates(&before)[0]["sessionUpdate"], "fake_future_update");
    assert_eq!(req["method"], "fs/read_text_file");
    assert_eq!(req["params"]["path"], format!("{CWD}/README.md"));
    a.respond_error(&req["id"], -32601, "Method not found");
    let (msgs, response) = a.until_response(&id);
    assert_eq!(msgs[0]["method"], "_fake/unknown_notice");
    assert_eq!(
        text_of(&updates(&msgs), "agent_message_chunk"),
        "fs/read_text_file: -32601"
    );
    assert_eq!(response["result"]["stopReason"], "end_turn");
    common::acp::received(&a.record());
}

#[test]
fn scenario_version_answers_protocol_2() {
    let mut a = Agent::scenario("version");
    assert_eq!(a.init()["protocolVersion"], 2);
}

#[test]
fn scenario_hang_never_answers_initialize() {
    let mut a = Agent::scenario("hang");
    a.request("initialize", common::fake::initialize_params());
    assert!(a.quiet_for(Duration::from_millis(500)));
    a.close_stdin();
    assert!(a.exit_within(PATIENCE).unwrap().success());
}

#[test]
fn scenario_kill_stubborn_ignores_eof_and_sigterm() {
    let (mut a, session) = scenario("kill-stubborn");
    a.prompt(&session, "go");
    assert_eq!(a.next()["method"], "session/update");
    a.close_stdin();
    assert!(a.exit_within(Duration::from_millis(300)).is_none());
    a.terminate();
    assert!(a.exit_within(Duration::from_millis(300)).is_none());
    let notes: Vec<Value> = a
        .record()
        .iter()
        .filter_map(|e| e.get("note").cloned())
        .collect();
    assert_eq!(notes, ["env", "stdin_eof", "sigterm"]);
}

#[test]
fn scenario_replay_large_streams_20_mib_around_a_permission() {
    let (mut a, session) = scenario("replay-large");
    let id = a.prompt(&session, "go");
    let (before, req) = a.until_request();
    let ups = updates(&before);
    assert_eq!(ups.len(), 10 * 20);
    let first = ups[0]["content"]["text"].as_str().unwrap();
    assert!(first.starts_with("[000.00]"));
    assert_eq!(first.len(), 5 << 10);
    assert_eq!(ups[0]["messageId"], "big-0");
    assert_eq!(ups[199]["messageId"], "big-9");
    let mut big = 0;
    let mut ticks = 0;
    while ticks < 3 {
        let m = a.next();
        let u = &m["params"]["update"];
        match u["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => {
                assert_eq!(ticks, 0, "a tick before the last chunk");
                big += 1;
            }
            Some("agent_thought_chunk") => {
                assert_eq!(u["messageId"], "tick");
                ticks += 1;
            }
            _ => panic!("{m}"),
        }
    }
    assert_eq!(big, 190 * 20);
    a.respond(&req["id"], selected("allow-once"));
    let (_, response) = a.until_response(&id);
    assert_eq!(response["result"]["stopReason"], "end_turn");
}

/// The `childPid` the fake recorded.
fn recorded_child(a: &Agent) -> u32 {
    let record = a.record();
    let note = record
        .iter()
        .find(|e| e["note"] == "child")
        .expect("a child note");
    u32::try_from(note["childPid"].as_u64().unwrap()).unwrap()
}

#[test]
fn scenario_crash_leave_child_leaves_sleep_in_its_group() {
    let (mut a, session) = scenario("crash-leave-child");
    a.prompt(&session, "go");
    assert_eq!(a.exit_within(PATIENCE).unwrap().code(), Some(1));
    let child = recorded_child(&a);
    assert!(running(child));
    assert_eq!(group_members(a.pid()), [child]);
    // `sleep` holds the fake's stdout open: no end of output yet.
    assert!(a.quiet_for(Duration::from_millis(200)));
    drop(a);
    assert!(wait_gone(child, PATIENCE));
}

#[test]
fn scenario_setsid_child_leaves_sleep_in_a_group_of_its_own() {
    let (mut a, session) = scenario("setsid-child");
    a.prompt(&session, "go");
    assert_eq!(a.next_raw(), None);
    assert_eq!(a.exit_within(PATIENCE).unwrap().code(), Some(1));
    let child = recorded_child(&a);
    assert!(group_members(a.pid()).is_empty());
    assert_eq!(group_members(child), [child]);
    drop(a);
    assert!(running(child), "the group kill reached it");
    common::signal(child, rustix::process::Signal::KILL);
    assert!(wait_gone(child, PATIENCE));
}

// ---- the hub against the fake ----
//
// Each one runs a real wb-hub with the fake in its agent table.

/// Creates `sid` with `agent` and reads its events, replayed or live, until one of kind
/// `e`; the `acp.open` reply and every event of `sid` up to that one.
fn spawn_until(c: &mut Client, hub: &Hub, sid: &str, agent: &str, e: &str) -> (Value, Vec<Value>) {
    let open = c.acp_spawn(sid, agent, &hub.home());
    assert_eq!(open["new"], true, "{open}");
    (open, c.events_until(sid, e))
}

/// Creates `sid` with `agent` and waits for setup to succeed; the `acp.open` reply.
fn ready(c: &mut Client, hub: &Hub, sid: &str, agent: &str) -> Value {
    spawn_until(c, hub, sid, agent, "session").0
}

fn epoch(open: &Value) -> u64 {
    open["summary"]["createdAt"].as_u64().unwrap()
}

/// Answers the permission request `req`; the reply.
fn permit(c: &mut Client, sid: &str, req: &Value, epoch: u64, option: &str) -> Value {
    c.request(
        json!({"t": "acp.permission", "sid": sid, "req": req, "epoch": epoch,
                     "outcome": selected(option)["outcome"]}),
    )
}

/// The pid in the first `spawn` event among `evs`, which is also the agent's pgid.
fn agent_pid(evs: &[Value]) -> u32 {
    let spawn = evs
        .iter()
        .find(|e| e["e"] == "spawn")
        .expect("a spawn event");
    u32::try_from(spawn["pid"].as_u64().unwrap()).unwrap()
}

/// The last `n` journal kinds of `sid`.
fn tail(hub: &Hub, sid: &str, n: usize) -> Vec<String> {
    let kinds = hub.kinds(sid);
    kinds[kinds.len().saturating_sub(n)..].to_vec()
}

/// The ACP messages the agent received from the hub with a `result` (its answers).
fn answers(hub: &Hub, agent: &str) -> Vec<Value> {
    hub.received(agent)
        .into_iter()
        .filter(|m| m.get("result").is_some() || m.get("error").is_some())
        .collect()
}

#[test]
fn hub_action_epoch_keeps_late_acp_actions_out_of_the_replacement() {
    let hub = Hub::with_scenarios(&["basic", "cancel"]);
    let mut c = hub.connect();
    let old = epoch(&ready(&mut c, &hub, "a1", "basic"));
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": true, "epoch": old}));

    // Pipeline the stale prompt directly behind the replacement open: the registry
    // must check the incarnation even if the new actor has not published a summary.
    c.send(
        &json!({"t": "acp.open", "rid": 900, "sid": "a1", "since": 0,
                   "spawn": {"agent": "cancel", "cwd": hub.home()}}),
    );
    let prompt = json!([{"type": "text", "text": "go"}]);
    let stale = c.request(json!({"t": "acp.prompt", "sid": "a1", "epoch": old, "prompt": prompt}));
    assert_eq!(stale["code"], "stale", "{stale}");
    let current = epoch(&c.reply(900));
    assert_ne!(old, current);
    c.event("a1", "session");

    for action in [
        json!({"t": "acp.set_mode", "sid": "a1", "modeId": "plan", "epoch": old}),
        json!({"t": "acp.kill", "sid": "a1", "forget": true, "epoch": old}),
        json!({"t": "pty.kill", "sid": "a1", "forget": true, "epoch": old}),
    ] {
        assert_eq!(c.request(action)["code"], "stale");
    }
    assert!(hub.received_calls("cancel", "session/prompt").is_empty());
    assert!(hub.received_calls("cancel", "session/set_mode").is_empty());
    c.ok(json!({"t": "acp.set_mode", "sid": "a1", "modeId": "plan", "epoch": current}));
    c.ok(json!({"t": "acp.prompt", "sid": "a1", "prompt": prompt, "epoch": current}));
    let permission = c.event("a1", "permission");
    let cancel = c.request(json!({"t": "acp.cancel", "sid": "a1", "epoch": old}));
    assert_eq!(cancel["code"], "stale");
    let summary = c.summary_through("a1", &permission);
    assert_eq!(summary["acp"]["pending"][0]["req"], permission["seq"]);
    c.ok(json!({"t": "acp.cancel", "sid": "a1", "epoch": current}));
    assert_eq!(c.event("a1", "turn_end")["stopReason"], "cancelled");
}

#[test]
fn session_kill_selects_the_current_kind_by_epoch() {
    let hub = Hub::with_scenarios(&["basic"]);
    let mut c = hub.connect();
    let kill = |epoch| json!({"t": "session.kill", "sid": "s", "epoch": epoch, "forget": true});
    let agent = epoch(&ready(&mut c, &hub, "s", "basic"));
    c.ok(kill(agent));

    let replacement = c.spawn("s", &["bash"]);
    let shell = replacement["epoch"].as_u64().unwrap();
    assert_ne!(agent, shell);
    assert_eq!(c.request(kill(agent))["code"], "stale");
    assert_eq!(c.attach("s")["pid"], replacement["pid"]);
    c.ok(kill(shell));
    assert_eq!(c.request(kill(shell))["code"], "not_found");
}

#[test]
fn hub_action_epoch_checks_pty_kill_and_wrong_kind_before_acting() {
    let hub = Hub::with_scenarios(&[]);
    let mut c = hub.connect();
    let old = c.spawn("p1", &["bash"])["epoch"].as_u64().unwrap();
    c.ok(json!({"t": "pty.kill", "sid": "p1", "forget": true, "epoch": old}));
    let replacement = c.spawn("p1", &["bash"]);
    let current = replacement["epoch"].as_u64().unwrap();
    assert_ne!(current, old);
    for action in [
        json!({"t": "pty.kill", "sid": "p1", "forget": true, "epoch": old}),
        json!({"t": "acp.kill", "sid": "p1", "forget": true, "epoch": old}),
        json!({"t": "acp.set_config_option", "sid": "p1", "configId": "model", "value": "large",
               "epoch": old, "checkEpochFirst": true}),
    ] {
        assert_eq!(c.request(action)["code"], "stale");
    }
    let wrong_kind =
        c.request(json!({"t": "acp.kill", "sid": "p1", "forget": true, "epoch": current}));
    assert_eq!(wrong_kind["code"], "kind_mismatch");
    assert_eq!(c.attach("p1")["pid"], replacement["pid"]);
    c.ok(json!({"t": "pty.kill", "sid": "p1", "forget": true, "epoch": current}));
}

#[test]
fn hub_action_epoch_explicit_config_guard_precedes_actor_validation() {
    let hub = Hub::with_scenarios(&["auth"]);
    let mut c = hub.connect();
    let (open, _) = spawn_until(&mut c, &hub, "a1", "auth", "setup_error");
    let current = epoch(&open);
    for (expected, code) in [(current + 1, "stale"), (current, "bad_request")] {
        let reply = c.request(json!({"t": "acp.set_config_option", "sid": "a1",
            "epoch": expected, "checkEpochFirst": true, "configId": "model", "value": "large"}));
        assert_eq!(reply["code"], code);
    }
    assert!(
        hub.received_calls("auth", "session/set_config_option")
            .is_empty()
    );
}

#[test]
fn hub_basic_turn_journal_facts_and_reset() {
    let mut hub = Hub::with_scenarios(&["basic"]);
    let mut c = hub.connect();
    let open = c.acp_spawn("a1", "basic", &hub.home());
    assert_eq!(open["new"], true);
    assert_eq!(open["reset"], false);
    let summary = &open["summary"];
    assert_eq!(summary["kind"], "acp");
    assert_eq!(summary["cwd"], hub.home());
    assert_eq!(summary["acp"]["agent"], "basic");
    assert_eq!(summary["acp"]["activity"], "setup");
    for key in [
        "protocolVersion",
        "agentInfo",
        "agentCapabilities",
        "promptCapabilities",
        "authMethods",
        "modes",
        "availableCommands",
        "plan",
        "usage",
    ] {
        assert!(
            open["session"].get(key).is_some(),
            "session.{key} missing: {open}"
        );
    }
    c.event("a1", "session");
    assert_eq!(c.acp_prompt("a1", "hello")["t"], "ok");
    let end = c.event("a1", "turn_end");
    assert_eq!(end["stopReason"], "end_turn");
    assert_eq!(
        hub.kinds("a1"),
        [
            "spawn", "session", "prompt", "update", "update", "update", "turn_end"
        ]
    );
    let journal = hub.journal("a1");
    assert_eq!(journal[0]["via"], "new");
    assert_eq!(journal[1]["via"], "new");
    assert_eq!(
        journal[2]["prompt"],
        json!([{"type": "text", "text": "hello"}])
    );
    // The agent's session id is the Summary's, so updates carry none.
    assert!(journal[3..6].iter().all(|l| l.get("sessionId").is_none()));

    let s = c.summary_until("a1", "the turn is over", |s| s["acp"]["activity"] == "none");
    let acp = &s["acp"];
    assert_eq!(acp["headSeq"], 7);
    assert_eq!(acp["last"]["seq"], 7);
    assert_eq!(acp["last"]["outcome"], "end_turn");
    assert_eq!(acp["last"]["error"], Value::Null);
    assert_eq!(acp["pending"], json!([]));
    assert_eq!(acp["revivable"], true);
    assert_eq!(acp["modeId"], "default");
    assert_eq!(acp["title"], Value::Null);
    let agent_session = acp["agentSessionId"].as_str().unwrap().to_owned();
    assert!(agent_session.starts_with("fake-session-"));
    assert!(acp["seenSeq"].as_u64().unwrap() < 7);
    c.ok(json!({"t": "acp.seen", "sid": "a1", "seq": 1000}));
    assert_eq!(c.summary("a1")["acp"]["seenSeq"], 7);
    c.ok(json!({"t": "acp.seen", "sid": "a1", "seq": 1}));
    assert_eq!(c.summary("a1")["acp"]["seenSeq"], 7);

    // What the agent received.
    let init = hub.received_calls("basic", "initialize");
    assert_eq!(init.len(), 1);
    assert_eq!(init[0]["params"]["protocolVersion"], 1);
    assert_eq!(
        init[0]["params"]["clientCapabilities"],
        common::fake::initialize_params()["clientCapabilities"]
    );
    let new = hub.received_calls("basic", "session/new");
    assert_eq!(
        new[0]["params"],
        json!({"cwd": hub.home(), "mcpServers": []})
    );
    let prompt = hub.received_calls("basic", "session/prompt");
    assert_eq!(prompt[0]["params"]["sessionId"], agent_session);

    // A fresh attach sees the materialised initialize result.
    let mut c2 = hub.connect();
    let reply = c2.ok(json!({"t": "acp.open", "sid": "a1", "since": 7, "epoch": epoch(&open)}));
    assert_eq!(reply["new"], false);
    assert_eq!(reply["reset"], false);
    assert_eq!(reply["head"], 7);
    assert_eq!(reply["session"]["protocolVersion"], 1);
    assert_eq!(reply["session"]["agentInfo"]["name"], "wb-fake-acp");
    assert_eq!(reply["session"]["modes"]["currentModeId"], "default");
    let (evs, replayed) = c2.replay("a1");
    assert!(evs.is_empty(), "{evs:?}");
    assert_eq!(replayed["head"], 7);
    assert_eq!(replayed["truncated"], false);

    // `since` past the head, or another incarnation, resets to a replay from seq 1.
    for open in [
        json!({"t": "acp.open", "sid": "a1", "since": 100}),
        json!({"t": "acp.open", "sid": "a1", "since": 7, "epoch": epoch(&open) + 1}),
    ] {
        let mut c3 = hub.connect();
        let reply = c3.ok(open);
        assert_eq!(reply["reset"], true, "{reply}");
        let (evs, _) = c3.replay("a1");
        let seqs: Vec<u64> = evs.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs.first(), Some(&1));
        assert_eq!(seqs.last(), Some(&7));
    }
    drop((c, c2));
    fold_equals_live(&mut hub);
}

#[test]
fn hub_noise_goes_to_stderr_log_and_setup_succeeds() {
    let mut hub = Hub::with_scenarios(&["noise"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "noise");
    assert_eq!(c.summary("a1")["alive"], true);
    let log = hub.stderr_log("a1");
    assert!(log.contains("wb_fake_acp: starting up"), "{log}");
    assert!(log.len() < 1 << 20, "the over-long line reached stderr.log");
    assert_eq!(c.acp_prompt("a1", "hi")["t"], "ok");
    assert_eq!(c.event("a1", "turn_end")["stopReason"], "end_turn");
    drop(c);
    fold_equals_live(&mut hub);
}

/// A bare req can recur in another journal. Within one journal, even a cancelled
/// question followed by another of the same kind has a different announcing seq.
#[test]
fn answers_bind_to_the_announced_question_across_cancel_and_recreation() {
    let hub = Hub::with_scenarios(&[]);
    let mut other = hub.connect();
    assert_eq!(other.hello["sessionActionEpoch"], true);
    for (kind, first, next) in [
        ("permission", "ask-permission", "perm"),
        ("elicitation", "form", "url"),
    ] {
        let sid = kind;
        let answer = |epoch: u64, req: &Value| match kind {
            "permission" => json!({"t": "acp.permission", "sid": sid, "epoch": epoch,
                "req": req, "outcome": selected("allow-once")["outcome"]}),
            _ => json!({"t": "acp.elicitation", "sid": sid, "epoch": epoch,
                "req": req, "response": {"action": "decline"}}),
        };
        let mut old = hub.connect();
        let before = epoch(&ready(&mut old, &hub, sid, "stub"));
        assert_eq!(old.acp_prompt(sid, first)["t"], "ok");
        let original = old.event(sid, kind);
        old.ok(json!({"t": "acp.kill", "sid": sid, "forget": true}));

        let mut c = hub.connect();
        let current = epoch(&ready(&mut c, &hub, sid, "stub"));
        assert_ne!(before, current);
        assert_eq!(c.acp_prompt(sid, first)["t"], "ok");
        let pending = c.event(sid, kind);
        assert_eq!(original["seq"], pending["seq"]); // exercise a real collision
        assert_eq!(
            old.request(answer(before, &original["seq"]))["code"],
            "stale"
        );

        // Neither a late answer nor a late cancel may consume the new question.
        let cancel = |epoch| json!({"t": "acp.cancel", "sid": sid, "epoch": epoch});
        assert_eq!(old.request(cancel(before))["code"], "stale");
        c.ok(cancel(current));
        c.event(sid, "turn_end");
        assert_eq!(c.acp_prompt(sid, next)["t"], "ok");
        let replacement = c.event(sid, kind);
        let question = if kind == "permission" {
            "toolCall"
        } else {
            "request"
        };
        assert_ne!(replacement[question], pending[question]);
        assert!(replacement["seq"].as_u64().unwrap() > pending["seq"].as_u64().unwrap());
        assert_eq!(
            other.request(answer(current, &pending["seq"]))["code"],
            "already_resolved"
        );

        // Competing clients answer the replacement before either reads its reply.
        let mut race = answer(current, &replacement["seq"]);
        race["rid"] = json!(900);
        c.send(&race);
        other.send(&race);
        let (a, b) = (c.reply(900), other.reply(900));
        let (winner, loser) = if a["t"] == "ok" { (a, b) } else { (b, a) };
        assert_eq!(winner["t"], "ok");
        assert_eq!(loser["code"], "already_resolved");
        c.event(sid, "turn_end");
        assert_eq!(c.summary(sid)["acp"]["pending"], json!([]));
    }
}

#[test]
fn hub_action_epoch_answers_after_restart_remember_each_announced_kind() {
    let mut hub = Hub::with_scenarios(&[]);
    let sid = "questions";
    let mut c = hub.connect();
    let epoch = epoch(&ready(&mut c, &hub, sid, "stub"));
    assert_eq!(c.acp_prompt(sid, "ask-permission")["t"], "ok");
    let permission = c.event(sid, "permission")["seq"].as_u64().unwrap();
    let answer_permission = |req| {
        json!({"t": "acp.permission", "sid": sid, "epoch": epoch,
               "req": req, "outcome": selected("allow-once")["outcome"]})
    };
    c.ok(answer_permission(permission));
    c.event(sid, "turn_end");
    assert_eq!(c.acp_prompt(sid, "form")["t"], "ok");
    let elicitation = c.event(sid, "elicitation")["seq"].as_u64().unwrap();
    let answer_elicitation = |req| {
        json!({"t": "acp.elicitation", "sid": sid, "epoch": epoch,
               "req": req, "response": {"action": "decline"}})
    };

    // One question was answered by a user and the other was pending at shutdown.
    // Neither is held by the new process: it must look up their kinds by journal seq.
    drop(c);
    hub.terminate();
    hub.restart();
    let mut c = hub.connect();
    let journal = hub.journal(sid);
    for (answer, expected) in [
        (answer_permission(permission), "already_resolved"),
        (answer_elicitation(elicitation), "already_resolved"),
        (answer_permission(elicitation), "bad_request"),
        (answer_elicitation(permission), "bad_request"),
    ] {
        assert_eq!(c.request(answer)["code"], expected);
    }
    assert_eq!(hub.journal(sid), journal, "no second resolution");
}

#[test]
fn hub_permission_first_answer_wins() {
    let mut hub = Hub::with_scenarios(&["permission"]);
    let mut c = hub.connect();
    let open = ready(&mut c, &hub, "a1", "permission");
    let epoch = epoch(&open);
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let perm = c.event("a1", "permission");
    let req = perm["seq"].clone();
    assert_eq!(perm["toolCall"]["title"], "Run `rm -rf build`");
    assert_eq!(perm["options"].as_array().unwrap().len(), 3);
    let s = c.summary("a1");
    let pending = &s["acp"]["pending"];
    assert_eq!(pending.as_array().unwrap().len(), 1, "{s}");
    assert_eq!(pending[0]["req"], req);
    assert_eq!(pending[0]["kind"], "permission");
    assert_eq!(pending[0]["title"], "Run `rm -rf build`");
    assert_eq!(s["acp"]["activity"], "turn");

    // A second prompt during the turn is refused.
    assert_eq!(c.acp_prompt("a1", "again")["code"], "busy");
    assert_eq!(
        permit(&mut c, "a1", &req, epoch + 1, "allow-once")["code"],
        "stale"
    );
    assert_eq!(
        permit(&mut c, "a1", &req, epoch, "nope")["code"],
        "bad_option"
    );

    // Two connections answer at once: one wins.
    let mut c2 = hub.connect();
    c2.ok(json!({"t": "acp.open", "sid": "a1", "since": req}));
    c2.replay("a1");
    for (client, option) in [(&mut c, "allow-once"), (&mut c2, "reject-once")] {
        client.send(
            &json!({"t": "acp.permission", "rid": 900, "sid": "a1", "req": req,
                            "epoch": epoch, "outcome": selected(option)["outcome"]}),
        );
    }
    let a = c.reply(900);
    let b = c2.reply(900);
    let mut codes = [a["t"].as_str().unwrap(), b["t"].as_str().unwrap()];
    codes.sort_unstable();
    assert_eq!(codes, ["err", "ok"], "{a} {b}");
    let loser = if a["t"] == "err" { &a } else { &b };
    assert_eq!(loser["code"], "already_resolved");

    let resolved = c.event("a1", "permission_resolved");
    assert_eq!(resolved["req"], req);
    assert_eq!(resolved["by"], "user");
    assert_eq!(c.event("a1", "turn_end")["stopReason"], "end_turn");
    assert_eq!(
        permit(&mut c, "a1", &req, epoch, "allow-once")["code"],
        "already_resolved"
    );
    let answered: Vec<Value> = answers(&hub, "permission");
    assert_eq!(answered.len(), 1, "{answered:?}");
    assert_eq!(answered[0]["result"]["outcome"], resolved["outcome"]);
    let s = c.summary("a1");
    assert_eq!(s["acp"]["pending"], json!([]));
    assert!(s["acp"]["seenSeq"].as_u64() >= req.as_u64(), "{s}");
    drop((c, c2));
    fold_equals_live(&mut hub);
}

fn permission_policy(action: &str) -> Value {
    json!({"rules": [{
        "action": action, "kinds": ["execute"], "roots": ["$cwd", "/nix/store", "/tmp"],
        "programs": ["rm"],
        "command": {"matches": ["^rm "], "notMatches": ["sudo"]}
    }]})
}

fn policy_hub() -> Hub {
    Hub::with_scenarios_and(&[], |cfg| stub(cfg, "omp", &[]))
}

fn policy_ready(c: &mut Client, hub: &Hub, sid: &str, policy: Value) -> Value {
    let open = c.ok(json!({"t":"acp.open", "sid":sid, "since":0,
        "spawn":{"agent":"omp", "cwd":hub.home(), "policy":policy}}));
    c.event(sid, "session");
    open
}

#[test]
fn hub_policy_answers_omp_empty_locations_with_and_without_cwd() {
    let hub = policy_hub();
    let mut c = hub.connect();
    let policy = json!({"rules":[{"action":"allow", "roots":["$cwd"], "programs":["cargo"]}]});
    policy_ready(&mut c, &hub, "omp", policy);
    for (prompt, cwd) in [
        ("omp-permission", None),
        ("omp-permission cwd", Some("src")),
    ] {
        assert_eq!(c.acp_prompt("omp", prompt)["t"], "ok");
        let events = c.events_until("omp", "turn_end");
        let auto = events.iter().find(|e| e["e"] == "permission_auto").unwrap();
        assert_eq!(auto["toolCall"]["locations"], json!([]));
        let input = &auto["toolCall"]["rawInput"];
        assert_eq!(input["command"], "cargo test");
        assert_eq!(input["timeout"], 300);
        assert_eq!(input["pty"], false);
        assert_eq!(input["async"], false);
        assert_eq!(input.get("cwd").and_then(Value::as_str), cwd);
        assert_eq!(auto["outcome"]["optionId"], "allow-once");
        assert!(!events.iter().any(|e| e["e"] == "permission"));
        assert!(hub.journal("omp").contains(auto));
        let summary = c.summary_through("omp", events.last().unwrap());
        assert_eq!(summary["acp"]["pending"], json!([]));
    }
}

#[test]
fn hub_policy_leaves_post_cancel_requests_pending_only_for_that_turn() {
    let hub = policy_hub();
    let mut c = hub.connect();
    let policy = json!({"rules":[{"action":"allow", "roots":["$cwd"], "programs":["cargo"]}]});
    let opened = policy_ready(&mut c, &hub, "cancelled", policy);
    assert_eq!(c.acp_prompt("cancelled", "omp-after-cancel")["t"], "ok");
    c.ok(json!({"t":"acp.cancel", "sid":"cancelled"}));
    let pending = c.event("cancelled", "permission");
    assert_eq!(pending["toolCall"]["rawInput"]["command"], "cargo test");
    assert_eq!(
        c.summary_through("cancelled", &pending)["acp"]["pending"][0]["req"],
        pending["seq"]
    );
    assert!(
        !hub.journal("cancelled")
            .iter()
            .any(|e| e["e"] == "permission_auto")
    );
    assert_eq!(
        permit(
            &mut c,
            "cancelled",
            &pending["seq"],
            epoch(&opened),
            "reject-once"
        )["t"],
        "ok"
    );
    let events = c.events_until("cancelled", "turn_end");
    let resolved = events
        .iter()
        .find(|e| e["e"] == "permission_resolved")
        .unwrap();
    assert_eq!(resolved["by"], "user");
    assert_eq!(resolved["outcome"]["optionId"], "reject-once");
    assert_eq!(events.last().unwrap()["stopReason"], "cancelled");

    assert_eq!(c.acp_prompt("cancelled", "omp-permission")["t"], "ok");
    let events = c.events_until("cancelled", "turn_end");
    let auto = events.iter().find(|e| e["e"] == "permission_auto").unwrap();
    assert_eq!(auto["outcome"]["optionId"], "allow-once");
    assert!(!events.iter().any(|e| e["e"] == "permission"));
    let summary = c.summary_through("cancelled", events.last().unwrap());
    assert_eq!(summary["acp"]["pending"], json!([]));
}

#[test]
fn hub_policy_leaves_permissions_outside_every_turn_pending() {
    let hub = policy_hub();
    let mut c = hub.connect();
    for action in ["allow", "reject"] {
        for cancelled in [false, true] {
            let sid = format!("outside_{action}_{cancelled}");
            let policy =
                json!({"rules":[{"action":action, "roots":["$cwd"], "programs":["cargo"]}]});
            let opened = policy_ready(&mut c, &hub, &sid, policy);
            let prompt = if cancelled {
                "omp-after-cancel outside"
            } else {
                "omp-outside-turn"
            };
            assert_eq!(c.acp_prompt(&sid, prompt)["t"], "ok");
            if cancelled {
                c.ok(json!({"t":"acp.cancel", "sid":sid}));
            }
            // The agent writes its prompt response before sending this permission.
            let events = c.events_until(&sid, "permission");
            let ended = events.iter().find(|ev| ev["e"] == "turn_end").unwrap();
            assert_eq!(
                ended["stopReason"],
                if cancelled { "cancelled" } else { "end_turn" }
            );
            assert!(!events.iter().any(|ev| ev["e"] == "permission_auto"));
            let pending = events.last().unwrap();
            let summary = c.summary_through(&sid, pending);
            assert_eq!(summary["acp"]["activity"], "none");
            assert_eq!(summary["acp"]["pending"][0]["req"], pending["seq"]);
            assert_eq!(
                permit(&mut c, &sid, &pending["seq"], epoch(&opened), "reject-once")["t"],
                "ok"
            );
            assert_eq!(c.event(&sid, "permission_resolved")["by"], "user");
            assert_eq!(c.acp_prompt(&sid, "omp-permission")["t"], "ok");
            let events = c.events_until(&sid, "turn_end");
            let auto = events
                .iter()
                .find(|ev| ev["e"] == "permission_auto")
                .unwrap();
            assert_eq!(auto["policy"]["action"], action);
            let summary = c.summary_through(&sid, events.last().unwrap());
            assert_eq!(summary["acp"]["pending"], json!([]));
        }
    }
}

#[test]
fn hub_policy_only_answers_execute_for_the_configured_omp_agent() {
    let hub = policy_hub();
    let mut c = hub.connect();
    for (agent, sid) in [("omp", "not_omp"), ("stub", "omp")] {
        let mut policy =
            json!({"rules":[{"action":"allow", "roots":["$cwd"], "programs":["cd","cargo"]}]});
        let opened = c.ok(json!({"t":"acp.open", "sid":sid, "since":0,
            "spawn":{"agent":agent, "cwd":hub.home(), "policy":policy}}));
        c.event(sid, "session");
        for replace in [false, true] {
            if replace {
                policy["rules"][0]["action"] = json!("reject");
                c.ok(json!({"t":"acp.set_policy", "sid":sid, "epoch":epoch(&opened), "policy":policy}));
            }
            for (prompt, command) in [
                ("omp-permission", "cargo test"),
                ("omp-permission same-cwd", "cd . && cargo test"),
                ("omp-permission cd", "cd src && cargo test"),
            ] {
                assert_eq!(c.acp_prompt(sid, prompt)["t"], "ok");
                if agent == "omp" {
                    let auto = c.event(sid, "permission_auto");
                    assert_eq!(auto["toolCall"]["rawInput"]["command"], command);
                    assert_eq!(auto["policy"]["action"], policy["rules"][0]["action"]);
                    assert_eq!(
                        auto["outcome"]["optionId"],
                        if replace { "reject-once" } else { "allow-once" }
                    );
                } else {
                    let pending = c.event(sid, "permission");
                    assert_eq!(pending["toolCall"]["rawInput"]["command"], command);
                    let summary = c.summary_through(sid, &pending);
                    assert_eq!(summary["acp"]["pending"][0]["req"], pending["seq"]);
                    assert_eq!(
                        permit(&mut c, sid, &pending["seq"], epoch(&opened), "allow-once")["t"],
                        "ok"
                    );
                }
                let end = c.event(sid, "turn_end");
                assert_eq!(c.summary_through(sid, &end)["acp"]["pending"], json!([]));
            }
        }
        if agent != "omp" {
            assert!(!hub.journal(sid).iter().any(|e| e["e"] == "permission_auto"));
        }
    }
}

#[test]
fn hub_policy_answers_once_without_publishing_pending_and_replays() {
    let mut hub = policy_hub();
    let mut c = hub.connect();
    let mut watcher = hub.connect();
    watcher.ok(json!({"t":"watch"}));
    for (sid, action, option, status) in [
        ("allowed", "allow", "allow-once", "completed"),
        ("rejected", "reject", "reject-once", "failed"),
    ] {
        let policy = permission_policy(action);
        let open = policy_ready(&mut c, &hub, sid, policy.clone());
        assert_eq!(c.summary(sid)["acp"]["policy"], policy);
        assert_eq!(c.acp_prompt(sid, "perm")["t"], "ok");
        let evs = c.events_until(sid, "turn_end");
        let auto = evs.iter().find(|e| e["e"] == "permission_auto").unwrap();
        assert_eq!(auto["policy"], json!({"rule":0,"action":action}));
        assert_eq!(
            auto["outcome"],
            json!({"outcome":"selected","optionId":option})
        );
        assert!(evs.iter().any(|e| e["update"]["status"] == status));
        assert!(!evs.iter().any(|e| e["e"] == "permission"));
        let summary = c.summary_through(sid, evs.last().unwrap());
        assert_eq!(summary["acp"]["pending"], json!([]));
        assert_eq!(
            permit(&mut c, sid, &auto["seq"], epoch(&open), option)["code"],
            "already_resolved"
        );
        let mut attached = hub.connect();
        attached.acp_open(sid, 0);
        let (replay, _) = attached.replay(sid);
        assert_eq!(
            replay.iter().find(|e| e["e"] == "permission_auto"),
            Some(auto)
        );
        assert!(hub.journal(sid).contains(auto));
        assert!(
            hub.journal(sid)
                .iter()
                .any(|e| e["e"] == "policy" && e["policy"] == policy)
        );
    }
    // A list reply is a barrier after every session publication already queued.
    watcher.send(&json!({"t":"list","rid":901}));
    loop {
        let message = watcher.next().expect("watcher stays connected");
        if message["rid"] == 901 {
            assert_eq!(message["t"], "ok");
            break;
        }
        if message["t"] == "session" {
            assert_eq!(message["session"]["acp"]["pending"], json!([]), "{message}");
        }
    }
    drop(watcher);
    let mut unlisted_policy = permission_policy("allow");
    unlisted_policy["rules"][0]["programs"] = json!(["git"]);
    let unlisted = policy_ready(&mut c, &hub, "unlisted", unlisted_policy.clone());
    assert_eq!(c.acp_prompt("unlisted", "perm")["t"], "ok");
    let permission = c.event("unlisted", "permission");
    assert_eq!(
        permission["toolCall"]["rawInput"]["command"],
        "rm -rf build"
    );
    assert!(permission.get("policy").is_none());
    assert_eq!(
        c.summary_through("unlisted", &permission)["acp"]["pending"][0]["req"],
        permission["seq"]
    );
    assert_eq!(
        permit(
            &mut c,
            "unlisted",
            &permission["seq"],
            epoch(&unlisted),
            "allow-once"
        )["t"],
        "ok"
    );
    c.event("unlisted", "turn_end");
    let unlisted_facts: Vec<_> = hub
        .journal("unlisted")
        .into_iter()
        .filter(|e| {
            matches!(
                e["e"].as_str(),
                Some("policy" | "permission" | "permission_resolved")
            )
        })
        .collect();
    assert_eq!(unlisted_facts.len(), 3);
    assert_eq!(unlisted_facts[0]["policy"], unlisted_policy);
    assert_eq!(unlisted_facts[1], permission);
    assert_eq!(unlisted_facts[2]["by"], "user");
    assert!(
        !hub.journal("unlisted")
            .iter()
            .any(|e| e["e"] == "permission_auto")
    );
    drop(c);
    fold_equals_live(&mut hub);
    let mut c = hub.connect();
    assert_eq!(
        c.summary("allowed")["acp"]["policy"],
        permission_policy("allow")
    );
    c.acp_open("allowed", 0);
    c.replay("allowed");
    c.ok(json!({"t":"acp.revive","sid":"allowed"}));
    c.event("allowed", "session");
    assert_eq!(c.acp_prompt("allowed", "perm")["t"], "ok");
    assert_eq!(
        c.event("allowed", "permission_auto")["outcome"]["optionId"],
        "allow-once"
    );
    c.event("allowed", "turn_end");
    assert_eq!(c.summary("unlisted")["acp"]["policy"], unlisted_policy);
    c.acp_open("unlisted", 0);
    let (replay, _) = c.replay("unlisted");
    let replayed_facts: Vec<_> = replay
        .into_iter()
        .filter(|e| {
            matches!(
                e["e"].as_str(),
                Some("policy" | "permission" | "permission_resolved")
            )
        })
        .collect();
    assert_eq!(replayed_facts, unlisted_facts);
    c.ok(json!({"t":"acp.revive","sid":"unlisted"}));
    c.event("unlisted", "session");
    assert_eq!(c.acp_prompt("unlisted", "perm")["t"], "ok");
    let permission = c.event("unlisted", "permission");
    assert!(permission.get("policy").is_none());
    assert_eq!(
        permit(
            &mut c,
            "unlisted",
            &permission["seq"],
            epoch(&unlisted),
            "allow-once"
        )["t"],
        "ok"
    );
    c.event("unlisted", "turn_end");
}

#[test]
fn hub_policy_invalid_replacements_warn_once_and_do_not_accumulate_on_restart() {
    let mut hub = policy_hub();
    let mut c = hub.connect();
    let open = policy_ready(&mut c, &hub, "a1", permission_policy("reject"));
    drop(c);
    hub.terminate();

    let append = |hub: &Hub, policies: &[Value]| {
        let mut seq = hub.journal("a1").len() as u64;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(hub.acp_file("a1.jsonl"))
            .unwrap();
        for policy in policies {
            seq += 1;
            serde_json::to_writer(
                &mut file,
                &json!({"seq":seq, "ts":1, "e":"policy", "policy":policy}),
            )
            .unwrap();
            std::io::Write::write_all(&mut file, b"\n").unwrap();
        }
    };
    let invalid = [
        json!({"rules":[{"action":"allow", "roots":["relative"]}]}),
        json!({"rules":[{"action":"allow", "command":{"matches":["("]}}]}),
    ];
    append(&hub, &invalid);
    let before = hub.journal("a1");

    hub.restart();
    let mut c = hub.connect();
    let attached = c.ok(json!({"t":"acp.open", "sid":"a1", "since":0}));
    assert!(attached["summary"]["acp"]["policy"].is_null());
    let (events, _) = c.replay("a1");
    let warnings: Vec<_> = events
        .iter()
        .filter(|e| e["e"] == "notice" && e["level"] == "warn")
        .collect();
    assert_eq!(warnings.len(), 1, "{events:?}");
    assert_eq!(warnings[0]["seq"], before.len() as u64 + 1);
    let warned = hub.journal("a1");
    assert_eq!(&warned[..before.len()], before.as_slice());
    assert_eq!(warned.last(), Some(warnings[0]));
    drop(c);
    hub.terminate();
    hub.restart();
    let mut c = hub.connect();
    c.ok(json!({"t":"acp.open", "sid":"a1", "since":0}));
    c.replay("a1");
    assert!(c.summary("a1")["acp"]["policy"].is_null());
    assert_eq!(hub.journal("a1"), warned);
    c.ok(json!({"t":"acp.revive", "sid":"a1"}));
    c.event("a1", "session");
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    let req = c.event("a1", "permission")["seq"].clone();
    assert_eq!(
        permit(&mut c, "a1", &req, epoch(&open), "reject-once")["t"],
        "ok"
    );
    c.event("a1", "turn_end");
    c.ok(
        json!({"t":"acp.set_policy", "sid":"a1", "epoch":epoch(&open),
        "policy":permission_policy("allow")}),
    );
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    c.event("a1", "permission_auto");
    c.event("a1", "turn_end");
    drop(c);
    hub.terminate();

    // A newly invalid event needs a new warning, even after an older warning and valid policy.
    append(&hub, &invalid[..1]);
    hub.restart();
    let mut c = hub.connect();
    assert!(c.summary("a1")["acp"]["policy"].is_null());
    let warned_again = hub.journal("a1");
    assert_eq!(
        warned_again
            .iter()
            .filter(|e| e["e"] == "notice" && e["level"] == "warn")
            .count(),
        2
    );
    drop(c);
    hub.terminate();
    hub.restart();
    let mut c = hub.connect();
    assert!(c.summary("a1")["acp"]["policy"].is_null());
    assert_eq!(hub.journal("a1"), warned_again);
    drop(c);
    hub.terminate();

    for policy in [permission_policy("allow"), json!({"rules":[]})] {
        let replacements = [invalid[0].clone(), policy];
        append(&hub, &replacements);
        let before = hub.journal("a1");
        hub.restart();
        let mut c = hub.connect();
        let expected = if replacements[1]["rules"] == json!([]) {
            &Value::Null
        } else {
            &replacements[1]
        };
        assert_eq!(&c.summary("a1")["acp"]["policy"], expected);
        assert_eq!(hub.journal("a1"), before);
        drop(c);
        hub.terminate();
    }
}

#[test]
fn hub_policy_replace_remove_leave_pending_and_never_answer_elicitations() {
    let mut hub = policy_hub();
    let mut c = hub.connect();
    let open = policy_ready(&mut c, &hub, "a1", permission_policy("ask"));
    let epoch = epoch(&open);
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    let req = c.event("a1", "permission")["seq"].clone();
    for policy in [permission_policy("allow"), json!({"rules":[]})] {
        c.ok(json!({"t":"acp.set_policy","sid":"a1","epoch":epoch,"policy":policy}));
        assert_eq!(c.summary("a1")["acp"]["pending"][0]["req"], req);
    }
    assert!(c.summary("a1")["acp"]["policy"].is_null());
    assert_eq!(permit(&mut c, "a1", &req, epoch, "reject-once")["t"], "ok");
    c.event("a1", "turn_end");
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    let req = c.event("a1", "permission")["seq"].clone();
    assert_eq!(permit(&mut c, "a1", &req, epoch, "allow-once")["t"], "ok");
    c.event("a1", "turn_end");
    c.ok(json!({"t":"acp.set_policy","sid":"a1","epoch":epoch,
        "policy":{"rules":[{"action":"allow"}]}}));
    assert_eq!(c.acp_prompt("a1", "form")["t"], "ok");
    let elicitation = c.event("a1", "elicitation");
    let summary = c.summary_through("a1", &elicitation);
    assert_eq!(summary["acp"]["pending"][0]["kind"], "elicitation");
    assert_eq!(summary["acp"]["pending"][0]["req"], elicitation["seq"]);
    c.ok(json!({"t":"acp.elicitation","sid":"a1","epoch":epoch,
        "req":elicitation["seq"],"response":{"action":"decline"}}));
    c.event("a1", "turn_end");
    assert_eq!(
        hub.journal("a1")
            .iter()
            .filter(|e| e["e"] == "policy")
            .count(),
        4
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_policy_is_incarnation_scoped_and_attach_cannot_replace_it() {
    let hub = policy_hub();
    let mut c = hub.connect();
    let open = policy_ready(&mut c, &hub, "a1", permission_policy("reject"));
    let old = epoch(&open);
    let attach = c.ok(json!({"t":"acp.open","sid":"a1","since":0,
        "spawn":{"agent":"stub","cwd":hub.home(),"policy":permission_policy("allow")}}));
    assert_eq!(
        attach["summary"]["acp"]["policy"],
        permission_policy("reject")
    );
    c.replay("a1");
    c.ok(json!({"t":"acp.kill","sid":"a1","forget":true}));
    let new = ready(&mut c, &hub, "a1", "stub");
    assert_ne!(epoch(&new), old);
    assert_eq!(
        c.request(json!({"t":"acp.set_policy","sid":"a1","epoch":old,
        "policy":permission_policy("allow")}))["code"],
        "stale"
    );
    assert!(c.summary("a1")["acp"]["policy"].is_null());
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    let req = c.event("a1", "permission")["seq"].clone();
    assert_eq!(
        permit(&mut c, "a1", &req, epoch(&new), "reject-once")["t"],
        "ok"
    );
    c.event("a1", "turn_end");
}

#[test]
fn hub_invalid_policy_never_registers_or_spawns_and_replacement_is_atomic() {
    let hub = policy_hub();
    let mut c = hub.connect();
    let invalid = [
        json!({"rules":[{"action":"allow","command":{"matches":["("]}}]}),
        json!({"rules":[{"action":"allow","roots":["relative"]}]}),
        json!({"rules":[{"action":"alow"}]}),
        json!({"rules":[],"typo":true}),
        json!({"rules":vec![json!({"action":"allow"});65]}),
        json!({"rules":[{"action":"allow","programs":null}]}),
        json!({"rules":[{"action":"allow","programs":"rm"}]}),
        json!({"rules":[{"action":"allow","programs":[1]}]}),
        json!({"rules":[{"action":"allow","programs":[""]}]}),
        json!({"rules":[{"action":"allow","programs":["rm -rf"]}]}),
        json!({"rules":[{"action":"allow","programs":["rm\tbuild"]}]}),
        json!({"rules":[{"action":"allow","programs":["rm\nbuild"]}]}),
        json!({"rules":[{"action":"allow","programs":["rm\u{a0}build"]}]}),
        json!({"rules":[{"action":"allow","programs":["rm\u{2003}build"]}]}),
        json!({"rules":[{"action":"allow","programs":["r\u{0}m"]}]}),
        json!({"rules":[{"action":"allow","programs":["x".repeat(257)]}]}),
        json!({"rules":[{"action":"allow","programs":["é".repeat(129)]}]}),
        json!({"rules":[{"action":"allow","programs":vec!["rm";65]}]}),
    ];
    for policy in &invalid {
        let reply = c.request(json!({"t":"acp.open","sid":"bad","since":0,
            "spawn":{"agent":"stub","cwd":hub.home(),"policy":policy}}));
        assert_eq!(reply["code"], "bad_request", "{reply}");
        assert!(!hub.acp_file("bad.json").exists());
    }
    assert!(
        c.ok(json!({"t":"list"}))["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let open = policy_ready(&mut c, &hub, "a1", permission_policy("reject"));
    let before = hub.journal("a1");
    for policy in invalid {
        assert_eq!(
            c.request(json!({"t":"acp.set_policy","sid":"a1","epoch":epoch(&open),
                "policy":policy}))["code"],
            "bad_request"
        );
    }
    assert_eq!(
        c.summary("a1")["acp"]["policy"],
        permission_policy("reject")
    );
    assert_eq!(hub.journal("a1"), before);
}

#[cfg(debug_assertions)]
#[test]
fn hub_policy_journal_fault_sends_cancellation_not_an_unrecorded_allow() {
    let hub = Hub::start_with_env(
        |cfg| stub(cfg, "omp", &[]),
        &[("WB_HUB_TEST_FAIL_WRITE_AT", "7")],
    );
    let mut c = hub.connect();
    policy_ready(&mut c, &hub, "a1", permission_policy("allow"));
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    c.summary_until("a1", "policy answer faults the journal", |s| {
        s["fault"]["code"] == "journal_write" && s["alive"] == false
    });
    assert!(!hub.kinds("a1").iter().any(|e| e == "permission_auto"));
    let outcomes: Vec<Value> = answers(&hub, "omp")
        .iter()
        .map(|answer| answer["result"]["outcome"].clone())
        .collect();
    assert_eq!(outcomes, [json!({"outcome":"cancelled"})]);
}

#[cfg(debug_assertions)]
#[test]
fn hub_policy_spawn_write_failure_accounts_for_every_startup_option() {
    let hub = Hub::start_with_env(
        |cfg| stub(cfg, "stub", &[]),
        &[("WB_HUB_TEST_FAIL_WRITE_AT", "1")],
    );
    let mut c = hub.connect();
    let open = c.ok(json!({"t":"acp.open","sid":"a1","since":0,
        "spawn":{"agent":"stub","cwd":hub.home(),"policy":permission_policy("allow"),
            "config":[{"id":"model","value":"large"},{"id":"thinking","value":true}]}}));
    assert_eq!(open["summary"]["alive"], false);
    assert_eq!(open["summary"]["fault"]["code"], "journal_write");
    let errors = open["configErrors"].as_array().unwrap();
    assert_eq!(
        errors
            .iter()
            .map(|e| (&e["id"], &e["value"], &e["code"]))
            .collect::<Vec<_>>(),
        [
            (&json!("model"), &json!("large"), &json!("faulted")),
            (&json!("thinking"), &json!(true), &json!("faulted"))
        ]
    );
    assert!(hub.record("stub").is_empty());
    assert!(hub.journal("a1").is_empty());
}

#[test]
fn hub_permission_reconnect_replays_in_seq_order() {
    let mut hub = Hub::with_scenarios(&["permission-reconnect"]);
    let mut a = hub.connect();
    let open = ready(&mut a, &hub, "a1", "permission-reconnect");
    assert_eq!(a.acp_prompt("a1", "go")["t"], "ok");
    assert_eq!(a.event("a1", "permission")["seq"], 120);
    a.summary_until("a1", "all 200 events", |s| s["acp"]["headSeq"] == 200);
    drop(a);

    let mut b = hub.connect();
    let reply = b.ok(json!({"t": "acp.open", "sid": "a1", "since": 0, "epoch": epoch(&open)}));
    assert_eq!(reply["head"], 200);
    assert_eq!(reply["reset"], false);
    let (evs, replayed) = b.replay("a1");
    assert_eq!(replayed["truncated"], false);
    let seqs: Vec<u64> = evs.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=200).collect::<Vec<u64>>());
    assert_eq!(evs[119]["e"], "permission");
    assert_eq!(
        permit(&mut b, "a1", &json!(120), epoch(&open), "allow-once")["t"],
        "ok"
    );
    assert_eq!(b.event("a1", "turn_end")["stopReason"], "end_turn");
    drop(b);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_agent_cancels_its_own_request() {
    let mut hub = Hub::with_scenarios(&["agent-cancels"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "agent-cancels");
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let perm = c.event("a1", "permission");
    let resolved = c.event("a1", "permission_resolved");
    assert_eq!(resolved["req"], perm["seq"]);
    assert_eq!(resolved["by"], "agent");
    assert_eq!(c.event("a1", "turn_end")["stopReason"], "end_turn");
    assert_eq!(c.summary("a1")["acp"]["pending"], json!([]));
    let answered = answers(&hub, "agent-cancels");
    assert_eq!(answered.len(), 1, "{answered:?}");
    assert_eq!(answered[0]["id"], "perm-1");
    assert_eq!(answered[0]["result"], cancelled());
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_form_and_url_elicitations() {
    let mut hub = Hub::with_scenarios(&[]);
    let mut c = hub.connect();
    let open = ready(&mut c, &hub, "a1", "stub");
    let epoch = epoch(&open);
    assert_eq!(c.acp_prompt("a1", "form")["t"], "ok");
    let ev = c.event("a1", "elicitation");
    let req = ev["seq"].clone();
    assert_eq!(ev["request"]["mode"], "form");
    let s = c.summary("a1");
    assert_eq!(s["acp"]["pending"][0]["kind"], "elicitation");
    assert_eq!(s["acp"]["pending"][0]["title"], "Pick the build settings");
    let answer = |c: &mut Client, response: Value| {
        c.request(
            json!({"t": "acp.elicitation", "sid": "a1", "req": req, "epoch": epoch,
                         "response": response}),
        )
    };
    for bad in [
        json!({"colour": {"nested": "red"}}),
        json!({"targets": ["x86_64", 1]}),
    ] {
        let reply = answer(&mut c, json!({"action": "accept", "content": bad}));
        assert_eq!(reply["code"], "bad_request", "{reply}");
    }
    let stale = c.request(json!({"t": "acp.elicitation", "sid": "a1", "req": req,
                                 "epoch": epoch + 1, "response": {"action": "decline"}}));
    assert_eq!(stale["code"], "stale");
    let content = json!({"colour": "blue", "count": 7, "verbose": false, "targets": ["riscv64"]});
    assert_eq!(
        answer(&mut c, json!({"action": "accept", "content": content}))["t"],
        "ok"
    );
    let evs = c.events_until("a1", "turn_end");
    let resolved = evs
        .iter()
        .find(|e| e["e"] == "elicitation_resolved")
        .unwrap();
    assert_eq!(resolved["req"], req);
    assert_eq!(resolved["by"], "user");
    let ups: Vec<Value> = evs
        .iter()
        .filter(|e| e["e"] == "update")
        .map(|e| e["update"].clone())
        .collect();
    assert_eq!(form_content(&ups), content);

    assert_eq!(c.acp_prompt("a1", "url")["t"], "ok");
    let ev = c.event("a1", "elicitation");
    assert_eq!(
        ev["request"]["url"],
        "https://example.org/wb-fake-acp/consent"
    );
    let reply = c.request(
        json!({"t": "acp.elicitation", "sid": "a1", "req": ev["seq"],
                                 "epoch": epoch, "response": {"action": "accept"}}),
    );
    assert_eq!(reply["t"], "ok");
    let evs = c.events_until("a1", "turn_end");
    let complete = evs
        .iter()
        .find(|e| e["e"] == "elicitation_complete")
        .unwrap();
    assert_eq!(complete["elicitationId"], ev["request"]["elicitationId"]);
    assert_eq!(c.summary("a1")["acp"]["pending"], json!([]));
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_request_scoped_elicitation_pauses_the_setup_timer() {
    let mut hub = Hub::with_scenarios(&["elicitation"]);
    let mut c = hub.connect();
    let (open, evs) = spawn_until(&mut c, &hub, "a1", "elicitation", "setup_error");
    assert_eq!(evs.last().unwrap()["code"], "auth_required");
    assert_eq!(c.summary("a1")["alive"], true);
    c.send(&json!({"t": "acp.authenticate", "rid": 900, "sid": "a1", "methodId": "fake-login"}));
    let ev = c.event("a1", "elicitation");
    assert!(ev["request"].get("sessionId").is_none(), "{ev}");
    assert!(ev["request"].get("requestId").is_some(), "{ev}");
    // Longer than SETUP_IDLE_TIMEOUT: a pending request pauses it.
    std::thread::sleep(wb_proto::limits::SETUP_IDLE_TIMEOUT + Duration::from_secs(1));
    let s = c.summary("a1");
    assert_eq!(s["alive"], true, "{s}");
    assert_eq!(s["acp"]["activity"], "setup", "{s}");
    let reply = c.request(
        json!({"t": "acp.elicitation", "sid": "a1", "req": ev["seq"],
                                 "epoch": epoch(&open),
                                 "response": {"action": "accept", "content": {"token": "t"}}}),
    );
    assert_eq!(reply["t"], "ok");
    let auth = c.reply(900);
    assert_eq!(auth["t"], "ok", "{auth}");
    let session = c.event("a1", "session");
    assert_eq!(session["via"], "new");
    assert!(!hub.kinds("a1").iter().any(|k| k == "exit"));
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_cancel_resolves_pending_and_ends_cancelled() {
    let mut hub = Hub::with_scenarios(&["cancel"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "cancel");
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let perm = c.event("a1", "permission");
    c.ok(json!({"t": "acp.cancel", "sid": "a1"}));
    let resolved = c.event("a1", "permission_resolved");
    assert_eq!(resolved["req"], perm["seq"]);
    assert_eq!(resolved["by"], "cancel");
    assert_eq!(resolved["outcome"], cancelled()["outcome"]);
    assert_eq!(c.event("a1", "turn_end")["stopReason"], "cancelled");
    let received = hub.received("cancel");
    let cancel_at = received
        .iter()
        .position(|m| m["method"] == "session/cancel")
        .expect("session/cancel");
    let answer_at = received
        .iter()
        .position(|m| m["result"] == cancelled())
        .expect("the cancelled answer");
    assert!(cancel_at < answer_at);
    let s = c.summary_until("a1", "the turn is over", |s| s["acp"]["activity"] == "none");
    assert_eq!(s["acp"]["last"]["outcome"], "cancelled");
    // With no turn, cancel is a no-op.
    let head = s["acp"]["headSeq"].clone();
    c.ok(json!({"t": "acp.cancel", "sid": "a1"}));
    assert_eq!(c.summary("a1")["acp"]["headSeq"], head);
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_crash_midturn_writes_the_death_invariant() {
    let mut hub = Hub::with_scenarios(&["crash-midturn"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "crash-midturn");
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let evs = c.events_until("a1", "exit");
    let kinds: Vec<&str> = evs.iter().map(|e| e["e"].as_str().unwrap()).collect();
    let at = |k: &str| {
        kinds
            .iter()
            .position(|x| *x == k)
            .unwrap_or_else(|| panic!("{kinds:?}"))
    };
    assert!(at("permission") < at("permission_resolved"));
    assert!(at("permission_resolved") < at("turn_error"));
    let resolved = &evs[at("permission_resolved")];
    assert_eq!(resolved["by"], "hub");
    assert_eq!(evs[at("turn_error")]["code"], "agent_exited");
    let notice = &evs[at("notice")];
    assert!(
        notice["text"].as_str().unwrap().contains("boom"),
        "{notice}"
    );
    let exit = evs.last().unwrap();
    assert_eq!(exit["code"], 1);
    assert_eq!(exit["reason"], "exited");
    let s = c.summary("a1");
    assert_eq!(s["alive"], false);
    assert_eq!(s["acp"]["pending"], json!([]));
    assert_eq!(s["acp"]["activity"], "none");
    assert_eq!(s["acp"]["last"]["outcome"], "error");
    assert_eq!(s["acp"]["last"]["error"]["code"], "agent_exited");
    assert_eq!(s["acp"]["revivable"], true);
    // No respawn.
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(hub.kinds("a1").iter().filter(|k| *k == "spawn").count(), 1);
    assert_eq!(c.acp_prompt("a1", "again")["code"], "not_alive");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_auth_waits_for_authenticate() {
    let mut hub = Hub::with_scenarios(&["auth"]);
    let mut c = hub.connect();
    let (_, evs) = spawn_until(&mut c, &hub, "a1", "auth", "setup_error");
    let err = evs.last().unwrap();
    assert_eq!(err["code"], "auth_required");
    assert_eq!(err["rpc"]["code"], -32000);
    let s = c.summary("a1");
    assert_eq!(s["alive"], true);
    assert_eq!(s["acp"]["last"]["outcome"], "error");
    assert_eq!(s["acp"]["last"]["error"]["code"], "auth_required");
    let bad = c.request(json!({"t": "acp.authenticate", "sid": "a1", "methodId": "other"}));
    assert_eq!(bad["code"], "bad_option");
    c.ok(json!({"t": "acp.authenticate", "sid": "a1", "methodId": "fake-login"}));
    let evs = c.events_until("a1", "session");
    assert_eq!(evs[0]["e"], "authenticate");
    assert_eq!(evs[0]["methodId"], "fake-login");
    let methods: Vec<Value> = hub
        .received("auth")
        .iter()
        .filter_map(|m| m.get("method").cloned())
        .collect();
    assert_eq!(
        methods,
        ["initialize", "session/new", "authenticate", "session/new"]
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_auth_with_only_terminal_methods_kills_the_agent() {
    let mut hub = Hub::with_scenarios(&["auth-terminal"]);
    let mut c = hub.connect();
    let (_, evs) = spawn_until(&mut c, &hub, "a1", "auth-terminal", "exit");
    let err = evs.iter().find(|e| e["e"] == "setup_error").unwrap();
    assert_eq!(err["code"], "auth_required");
    let s = c.summary("a1");
    assert_eq!(s["alive"], false);
    let bad = c.request(json!({"t": "acp.authenticate", "sid": "a1", "methodId": "fake-terminal"}));
    assert_eq!(bad["code"], "bad_option", "{bad}");
    assert!(
        hub.received_calls("auth-terminal", "authenticate")
            .is_empty()
    );
    drop(c);
    fold_equals_live(&mut hub);
}

/// Runs a turn on `sid`, kills the agent and waits for the exit; the Summary.
fn turn_then_kill(c: &mut Client, sid: &str) -> Value {
    assert_eq!(c.acp_prompt(sid, "go")["t"], "ok");
    c.event(sid, "turn_end");
    c.ok(json!({"t": "acp.kill", "sid": sid, "forget": false}));
    c.event(sid, "exit");
    c.summary_until(sid, "the agent is dead", |s| s["alive"] == false)
}

/// Revives `sid` and reads its events until both the `session` and the `notice` that
/// a successful revive journals have arrived; those events.
fn revive(c: &mut Client, sid: &str) -> Vec<Value> {
    c.ok(json!({"t": "acp.revive", "sid": sid}));
    let mut evs = c.events_until(sid, "session");
    if !evs.iter().any(|e| e["e"] == "notice") {
        evs.extend(c.events_until(sid, "notice"));
    }
    evs
}

/// The text of the `notice` among `evs`.
fn notice_text(evs: &[Value]) -> String {
    let notice = evs.iter().find(|e| e["e"] == "notice").expect("a notice");
    notice["text"].as_str().unwrap().to_owned()
}

#[test]
fn hub_revive_resumes_when_resume_is_advertised() {
    let mut hub = Hub::with_scenarios(&["revive-resume"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "revive-resume");
    let s = turn_then_kill(&mut c, "a1");
    assert_eq!(s["acp"]["revivable"], true);
    assert_eq!(s["acp"]["seenSeq"], s["acp"]["headSeq"]);
    let exit = hub.journal("a1").pop().unwrap();
    assert_eq!(exit["reason"], "killed");
    let agent_session = s["acp"]["agentSessionId"].clone();
    let evs = revive(&mut c, "a1");
    assert_eq!(evs[0]["e"], "spawn");
    assert_eq!(evs[0]["via"], "revive");
    let session = evs.iter().find(|e| e["e"] == "session").unwrap();
    assert_eq!(session["via"], "resume");
    assert!(notice_text(&evs).contains("resume"), "{evs:?}");
    let resume = hub.received_calls("revive-resume", "session/resume");
    assert_eq!(resume.len(), 1);
    assert_eq!(resume[0]["params"]["sessionId"], agent_session);
    assert_eq!(resume[0]["params"]["cwd"], hub.home());
    assert!(
        hub.received_calls("revive-resume", "session/load")
            .is_empty()
    );
    let s = c.summary_until("a1", "revived", |s| {
        s["alive"] == true && s["acp"]["activity"] == "none"
    });
    assert_eq!(s["acp"]["agentSessionId"], agent_session);
    assert_eq!(c.acp_prompt("a1", "again")["t"], "ok");
    c.event("a1", "turn_end");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_revive_loads_without_journaling_history() {
    let mut hub = Hub::with_scenarios(&["revive-load"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "revive-load");
    let s = turn_then_kill(&mut c, "a1");
    let head = s["acp"]["headSeq"].as_u64().unwrap();
    let evs = revive(&mut c, "a1");
    let session = evs.iter().find(|e| e["e"] == "session").unwrap();
    assert_eq!(session["via"], "load");
    assert!(notice_text(&evs).contains("load"), "{evs:?}");
    let journal = hub.journal("a1");
    let since_revive = &journal[usize::try_from(head).unwrap()..];
    let updates: Vec<&Value> = since_revive
        .iter()
        .filter(|l| l["e"] == "update")
        .map(|l| &l["update"])
        .collect();
    assert_eq!(updates.len(), 1, "history was journaled: {updates:?}");
    assert_eq!(updates[0]["sessionUpdate"], "available_commands_update");
    assert!(
        hub.received_calls("revive-load", "session/resume")
            .is_empty()
    );
    assert_eq!(hub.received_calls("revive-load", "session/load").len(), 1);
    let mut c2 = hub.connect();
    let reply = c2.ok(json!({"t": "acp.open", "sid": "a1", "since": 0}));
    assert_eq!(reply["session"]["availableCommands"][0]["name"], "review");
    c2.replay("a1");
    drop((c, c2));
    fold_equals_live(&mut hub);
}

#[test]
fn hub_revive_failure_makes_the_session_unrevivable() {
    let mut hub = Hub::with_scenarios(&["revive-fail"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "revive-fail");
    turn_then_kill(&mut c, "a1");
    c.ok(json!({"t": "acp.revive", "sid": "a1"}));
    let evs = c.events_until("a1", "exit");
    let err = evs.iter().find(|e| e["e"] == "setup_error").unwrap();
    assert_eq!(err["code"], "revive_failed");
    assert_eq!(hub.received_calls("revive-fail", "session/resume").len(), 1);
    assert_eq!(hub.received_calls("revive-fail", "session/load").len(), 1);
    let s = c.summary_until("a1", "dead again", |s| s["alive"] == false);
    assert_eq!(s["acp"]["revivable"], false);
    assert_eq!(
        c.request(json!({"t": "acp.revive", "sid": "a1"}))["code"],
        "not_revivable"
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_unknown_variants_and_methods() {
    let mut hub = Hub::with_scenarios(&["unknown"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "unknown");
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let evs = c.events_until("a1", "turn_end");
    let future = evs
        .iter()
        .find(|e| e["e"] == "update" && e["update"]["sessionUpdate"] == "fake_future_update")
        .expect("the unknown variant, journaled");
    assert_eq!(future["update"]["detail"], json!({"answer": 42}));
    let ups: Vec<Value> = evs
        .iter()
        .filter(|e| e["e"] == "update")
        .map(|e| e["update"].clone())
        .collect();
    assert_eq!(
        text_of(&ups, "agent_message_chunk"),
        "fs/read_text_file: -32601"
    );
    // Neither the agent's request nor its unknown notification is journaled.
    assert_eq!(
        hub.kinds("a1"),
        ["spawn", "session", "prompt", "update", "update", "turn_end"]
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_protocol_version_2_is_an_agent_error() {
    let mut hub = Hub::with_scenarios(&["version"]);
    let mut c = hub.connect();
    let (_, evs) = spawn_until(&mut c, &hub, "a1", "version", "exit");
    let err = evs.iter().find(|e| e["e"] == "setup_error").unwrap();
    assert_eq!(err["code"], "agent_error");
    assert_eq!(c.summary("a1")["alive"], false);
    assert!(hub.received_calls("version", "session/new").is_empty());
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_silent_initialize_times_out() {
    let mut hub = Hub::with_scenarios(&["hang"]);
    let mut c = hub.connect();
    let started = Instant::now();
    c.acp_spawn("a1", "hang", &hub.home());
    let evs = c.events_until_within("a1", "setup_error", Duration::from_secs(40));
    assert_eq!(evs.last().unwrap()["code"], "timeout");
    assert!(started.elapsed() >= wb_proto::limits::SETUP_IDLE_TIMEOUT - Duration::from_secs(1));
    c.event("a1", "exit");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_set_mode_journals_the_mode() {
    let mut hub = Hub::with_scenarios(&["set-mode"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "set-mode");
    c.ok(json!({"t": "acp.set_mode", "sid": "a1", "modeId": "plan"}));
    assert_eq!(c.event("a1", "mode")["modeId"], "plan");
    assert_eq!(c.summary("a1")["acp"]["modeId"], "plan");
    let bad = c.request(json!({"t": "acp.set_mode", "sid": "a1", "modeId": "nope"}));
    assert_eq!(bad["code"], "bad_option");
    let sent = hub.received_calls("set-mode", "session/set_mode");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["params"]["modeId"], "plan");
    drop(c);
    fold_equals_live(&mut hub);
}

fn configure(c: &mut Client, sid: &str, epoch: u64, id: &str, value: Value) -> Value {
    c.request(json!({"t": "acp.set_config_option", "sid": sid, "epoch": epoch, "configId": id, "value": value}))
}

fn spawn_config(c: &mut Client, hub: &Hub, sid: &str, agent: &str, config: Value) -> Value {
    c.ok(json!({
        "t": "acp.open", "sid": sid, "since": 0,
        "spawn": {"agent": agent, "cwd": hub.home(), "config": config}
    }))
}

#[test]
fn hub_startup_config_blocks_competing_prompts_before_and_between_options() {
    let mut hub = Hub::with_scenarios(&["config-batch"]);
    let mut opener = hub.connect();
    opener.send(&json!({
        "t": "acp.open", "rid": 900, "sid": "a1", "since": 0,
        "spawn": {"agent": "config-batch", "cwd": hub.home(), "config": [
            {"id": "model", "value": "large"}, {"id": "effort", "value": "max"}
        ]}
    }));
    eventually(PATIENCE, "session/new received", || {
        !hub.received_calls("config-batch", "session/new").is_empty()
    });
    let mut competitor = hub.connect();
    let attached = competitor.ok(json!({"t": "acp.open", "sid": "a1", "since": 0}));
    assert!(attached.get("configErrors").is_none());
    assert_eq!(competitor.acp_prompt("a1", "too early")["code"], "busy");
    assert_eq!(
        competitor.request(json!({"t": "acp.set_mode", "sid": "a1", "modeId": "plan"}))["code"],
        "busy"
    );
    assert_eq!(
        configure(&mut competitor, "a1", 0, "thinking", json!(true))["code"],
        "busy"
    );
    fs::write(hub.dir.join("config-batch.step"), "1").unwrap();
    eventually(PATIENCE, "first config request received", || {
        hub.received_calls("config-batch", "session/set_config_option")
            .len()
            == 1
    });
    fs::write(hub.dir.join("config-batch.step"), "2").unwrap();
    // The first result has been journaled, but the second is still delayed.
    assert_eq!(
        competitor.event("a1", "config")["configOptions"][0]["currentValue"],
        "large"
    );
    assert_eq!(competitor.summary("a1")["acp"]["activity"], "setup");
    assert_eq!(
        competitor.acp_prompt("a1", "between options")["code"],
        "busy"
    );
    assert!(
        hub.received_calls("config-batch", "session/prompt")
            .is_empty()
    );
    fs::write(hub.dir.join("config-batch.step"), "3").unwrap();

    let opened = opener.reply(900);
    assert_eq!(opened["t"], "ok");
    assert!(opened.get("configErrors").is_none());
    assert_eq!(opened["session"]["configOptions"][1]["currentValue"], "max");
    let (replay, _) = opener.replay("a1");
    assert_eq!(
        replay
            .iter()
            .map(|ev| ev["e"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["spawn", "session", "config", "config"]
    );
    assert_eq!(competitor.acp_prompt("a1", "after batch")["t"], "ok");
    let turn = competitor.events_until("a1", "turn_end");
    let text = turn
        .iter()
        .filter_map(|ev| ev.pointer("/update/content/text").and_then(Value::as_str))
        .collect::<String>();
    assert_eq!(text, "model=large effort=max");
    let methods: Vec<String> = hub
        .received("config-batch")
        .iter()
        .filter_map(|call| call["method"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(
        methods,
        [
            "initialize",
            "session/new",
            "session/set_config_option",
            "session/set_config_option",
            "session/prompt"
        ]
    );
    let calls = hub.received_calls("config-batch", "session/set_config_option");
    assert_eq!(calls[0]["params"]["configId"], "model");
    assert_eq!(calls[1]["params"]["configId"], "effort");
    drop((opener, competitor));
    fold_equals_live(&mut hub);
}

#[test]
fn hub_startup_config_errors_continue_in_order_without_rejecting_creation() {
    let mut hub = Hub::with_scenarios(&["config-result", "config-error", "config-malformed-list"]);
    let mut c = hub.connect();
    let opened = spawn_config(
        &mut c,
        &hub,
        "a1",
        "config-result",
        json!([
            {"id": "missing", "value": "bad"}, {"id": "model", "value": "large"},
            {"id": "effort", "value": "max"}, {"id": "thinking", "value": "true"}
        ]),
    );
    assert_eq!(opened["new"], true);
    assert_eq!(
        opened["configErrors"],
        json!([
            {"id": "missing", "value": "bad", "code": "bad_option",
             "error": "configuration missing or its value is not offered"},
            {"id": "thinking", "value": "true", "code": "bad_option",
             "error": "configuration thinking or its value is not offered"}
        ])
    );
    assert_eq!(
        opened["session"]["configOptions"][0]["currentValue"],
        "large"
    );
    assert_eq!(opened["session"]["configOptions"][1]["currentValue"], "max");
    c.replay("a1");
    assert_eq!(
        hub.kinds("a1"),
        ["spawn", "session", "notice", "config", "config", "notice"]
    );

    let failed = spawn_config(
        &mut c,
        &hub,
        "a2",
        "config-error",
        json!([
            {"id": "model", "value": "large"}, {"id": "thinking", "value": true}
        ]),
    );
    assert_eq!(failed["t"], "ok");
    let errors = failed["configErrors"].as_array().unwrap();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0]["id"], "model");
    assert_eq!(errors[1]["id"], "thinking");
    assert!(errors.iter().all(|error| error["code"] == "agent_error"));
    c.replay("a2");
    assert_eq!(
        hub.received_calls("config-error", "session/set_config_option")
            .len(),
        2
    );
    assert_eq!(hub.kinds("a2"), ["spawn", "session", "notice", "notice"]);

    let malformed = spawn_config(
        &mut c,
        &hub,
        "a3",
        "config-malformed-list",
        json!([
            {"id": "model", "value": "large"}, {"id": "thinking", "value": false}
        ]),
    );
    assert_eq!(malformed["configErrors"].as_array().unwrap().len(), 1);
    assert_eq!(malformed["configErrors"][0]["code"], "agent_error");
    assert_eq!(malformed["session"]["configOptions"], json!([]));
    c.replay("a3");
    assert_eq!(
        hub.kinds("a3"),
        ["spawn", "session", "notice", "update", "config"]
    );
    assert!(
        hub.received_calls("config-result", "session/prompt")
            .is_empty()
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_startup_config_setup_failures_and_death_account_for_every_entry() {
    let mut hub = Hub::with_scenarios_and(
        &["version", "auth", "config-new-malformed", "config-exit"],
        |config| {
            config["agents"]["missing"] =
                json!({"label": "Missing", "argv": ["/nonexistent/wb-agent"]});
        },
    );
    let mut c = hub.connect();
    for (index, agent) in [
        "version",
        "auth",
        "config-new-malformed",
        "config-exit",
        "missing",
    ]
    .iter()
    .enumerate()
    {
        let sid = format!("failed{index}");
        let opened = spawn_config(
            &mut c,
            &hub,
            &sid,
            agent,
            json!([
                {"id": "model", "value": "large"}, {"id": "thinking", "value": true}
            ]),
        );
        assert_eq!(opened["new"], true);
        let errors = opened["configErrors"].as_array().unwrap();
        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0]["id"], "model");
        assert_eq!(errors[1]["id"], "thinking");
        let code = match *agent {
            "config-exit" => "not_alive",
            "missing" => "spawn_failed",
            "config-new-malformed" => "bad_option",
            _ => "agent_error",
        };
        assert!(errors.iter().all(|error| error["code"] == code));
        c.replay(&sid);
        assert!(!hub.kinds(&sid).iter().any(|kind| kind == "config"));
        assert_eq!(
            hub.received_calls(agent, "session/set_config_option").len(),
            usize::from(*agent == "config-exit")
        );
        if *agent == "config-new-malformed" {
            assert!(hub.kinds(&sid).iter().any(|kind| kind == "session"));
            assert_eq!(c.summary(&sid)["alive"], true);
            assert_eq!(c.acp_prompt(&sid, "still usable")["t"], "ok");
            c.event(&sid, "turn_end");
        }
    }
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_invalid_setup_options_do_not_kill_new_or_revived_sessions() {
    let mut hub = Hub::with_scenarios(&["config-new-malformed", "config-revive-malformed"]);
    let mut c = hub.connect();
    for (sid, agent, via) in [
        ("resume", "config-new-malformed", "resume"),
        ("load", "config-revive-malformed", "load"),
    ] {
        ready(&mut c, &hub, sid, agent);
        turn_then_kill(&mut c, sid);
        let evs = revive(&mut c, sid);
        let session = evs.iter().find(|ev| ev["e"] == "session").unwrap();
        assert_eq!(session["via"], via);
        assert!(session.get("configOptions").is_none());
        let summary = c.summary(sid);
        assert_eq!(summary["alive"], true);
        assert!(summary["acp"]["configOptions"].is_null());
        assert_eq!(c.acp_prompt(sid, "still usable")["t"], "ok");
        c.event(sid, "turn_end");
    }
    assert_eq!(
        hub.received_calls("config-revive-malformed", "session/resume")
            .len(),
        1
    );
    assert_eq!(
        hub.received_calls("config-revive-malformed", "session/load")
            .len(),
        1
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[cfg(debug_assertions)]
#[test]
fn hub_spawn_failure_with_journal_fault_releases_config_before_and_after_probe() {
    let hub = Hub::start_with_env(
        |cfg| {
            cfg["agents"]["missing"] =
                json!({"label": "Missing", "argv": ["/nonexistent/wb-agent"]});
        },
        &[("WB_HUB_TEST_FAIL_WRITE_AT", "1")],
    );
    let mut c = hub.connect();
    let opened = spawn_config(
        &mut c,
        &hub,
        "a1",
        "missing",
        json!([
            {"id": "model", "value": "large"}, {"id": "thinking", "value": true}
        ]),
    );
    assert!(
        opened["configErrors"]
            .as_array()
            .unwrap()
            .iter()
            .all(|error| error["code"] == "faulted")
    );
    assert_eq!(opened["configErrors"][0]["id"], "model");
    assert_eq!(opened["configErrors"][1]["id"], "thinking");
    assert_eq!(opened["summary"]["alive"], false);
    assert_eq!(opened["summary"]["fault"]["code"], "journal_write");
    assert_eq!(opened["summary"]["acp"]["activity"], "none");
    c.replay("a1");
    assert_eq!(c.acp_prompt("a1", "before probe")["code"], "faulted");
    // Revive triggers the same probe as the timer, without waiting a minute.
    assert_eq!(
        c.request(json!({"t": "acp.revive", "sid": "a1"}))["code"],
        "not_revivable"
    );
    let summary = c.summary("a1");
    assert!(summary["fault"].is_null());
    assert_eq!(summary["acp"]["activity"], "none");
    assert_eq!(c.acp_prompt("a1", "after probe")["code"], "not_alive");
    assert_eq!(
        c.request(json!({"t": "acp.revive", "sid": "a1"}))["code"],
        "not_revivable"
    );
    assert_eq!(hub.kinds("a1"), ["notice"]);
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": true}));
    assert!(
        c.ok(json!({"t": "list"}))["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn hub_startup_config_kill_releases_open_without_applying_a_late_result() {
    let mut hub = Hub::with_scenarios(&["config-batch"]);
    let mut opener = hub.connect();
    fs::write(hub.dir.join("config-batch.step"), "2").unwrap();
    opener.send(&json!({
        "t": "acp.open", "rid": 900, "sid": "a1", "since": 0,
        "spawn": {"agent": "config-batch", "cwd": hub.home(), "config": [
            {"id": "model", "value": "large"}, {"id": "effort", "value": "max"}
        ]}
    }));
    eventually(PATIENCE, "second config request received", || {
        hub.received_calls("config-batch", "session/set_config_option")
            .len()
            == 2
    });
    let mut killer = hub.connect();
    killer.ok(json!({"t": "acp.kill", "sid": "a1", "forget": false}));
    let opened = opener.reply(900);
    assert_eq!(opened["t"], "ok");
    assert_eq!(opened["configErrors"].as_array().unwrap().len(), 1);
    assert_eq!(opened["configErrors"][0]["id"], "effort");
    assert_eq!(opened["configErrors"][0]["code"], "not_alive");
    assert_eq!(
        opened["session"]["configOptions"][0]["currentValue"],
        "large"
    );
    assert_eq!(opened["session"]["configOptions"][1]["currentValue"], "low");
    opener.replay("a1");
    fs::write(hub.dir.join("config-batch.step"), "3").unwrap();
    opener.event("a1", "exit");
    assert_eq!(
        hub.kinds("a1")
            .iter()
            .filter(|kind| kind.as_str() == "config")
            .count(),
        1
    );
    assert_eq!(
        killer.summary("a1")["acp"]["configOptions"][1]["currentValue"],
        "low"
    );
    drop((opener, killer));
    fold_equals_live(&mut hub);
}

#[test]
fn hub_empty_startup_config_preserves_immediate_open_and_never_calls_config() {
    let mut hub = Hub::with_scenarios(&["config-batch"]);
    let mut c = hub.connect();
    let opened = spawn_config(&mut c, &hub, "a1", "config-batch", json!([]));
    assert!(opened.get("configErrors").is_none());
    assert_eq!(opened["summary"]["acp"]["activity"], "setup");
    fs::write(hub.dir.join("config-batch.step"), "1").unwrap();
    c.event("a1", "session");
    assert!(
        hub.received_calls("config-batch", "session/set_config_option")
            .is_empty()
    );
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    c.event("a1", "turn_end");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_startup_config_rejects_duplicate_ids_too_many_entries_and_untyped_values() {
    let mut hub = Hub::with_scenarios(&["config-result"]);
    let mut c = hub.connect();
    let too_many: Vec<Value> = (0..17)
        .map(|i| json!({"id": format!("id{i}"), "value": true}))
        .collect();
    for config in [
        json!([{"id": "model", "value": "small"}, {"id": "model", "value": "large"}]),
        json!(too_many),
        json!([{"id": "thinking", "value": null}]),
        json!([{"id": "thinking", "value": 1}]),
        json!([{"id": "thinking", "value": []}]),
        json!([{"id": "thinking", "value": {}}]),
    ] {
        let reply = c.request(json!({
            "t": "acp.open", "sid": "a1", "since": 0,
            "spawn": {"agent": "config-result", "cwd": hub.home(), "config": config}
        }));
        assert_eq!(reply["code"], "bad_request");
    }
    assert!(hub.received("config-result").is_empty());
    assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
    let maximum: Vec<Value> = (0..16)
        .map(|i| json!({"id": format!("id{i}"), "value": true}))
        .collect();
    let opened = spawn_config(&mut c, &hub, "a1", "config-result", json!(maximum));
    assert_eq!(opened["configErrors"].as_array().unwrap().len(), 16);
    c.replay("a1");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_malformed_config_lists_and_updates_preserve_good_state_across_replay_and_restart() {
    let mut hub = Hub::with_scenarios(&["config-malformed-list"]);
    let mut c = hub.connect();
    let opened = ready(&mut c, &hub, "a1", "config-malformed-list");
    let initial = c.summary("a1")["acp"]["configOptions"].clone();
    for (id, value) in [
        ("model", json!("large")),
        ("effort", json!("high")),
        ("thinking", json!(true)),
    ] {
        assert_eq!(
            configure(&mut c, "a1", epoch(&opened), id, value)["code"],
            "agent_error"
        );
        assert_eq!(c.summary("a1")["acp"]["configOptions"], initial);
    }
    assert_eq!(hub.kinds("a1"), ["spawn", "session"]);
    let mut attached = hub.connect();
    let replayed = attached.ok(json!({"t": "acp.open", "sid": "a1", "since": 0}));
    assert_eq!(replayed["session"]["configOptions"], initial);
    attached.replay("a1");

    let empty = ready(&mut c, &hub, "empty", "config-malformed-list");
    assert_eq!(
        configure(&mut c, "empty", epoch(&empty), "thinking", json!(false))["t"],
        "ok"
    );
    assert_eq!(c.event("empty", "config")["configOptions"], json!([]));
    assert_eq!(c.summary("empty")["acp"]["configOptions"], json!([]));
    drop((c, attached));
    fold_equals_live(&mut hub);
    let mut c = hub.connect();
    assert_eq!(c.summary("a1")["acp"]["configOptions"], initial);
    assert_eq!(c.summary("empty")["acp"]["configOptions"], json!([]));
}

#[test]
fn hub_startup_config_timeout_releases_open_and_ignores_late_result() {
    let mut hub = Hub::with_scenarios(&["config-hang"]);
    let mut c = hub.connect();
    c.send(&json!({
        "t": "acp.open", "rid": 900, "sid": "a1", "since": 0,
        "spawn": {"agent": "config-hang", "cwd": hub.home(), "config": [
            {"id": "model", "value": "large"}, {"id": "missing", "value": "bad"}
        ]}
    }));
    let opened = c.reply_within(900, Duration::from_secs(40));
    assert_eq!(opened["t"], "ok");
    assert_eq!(opened["configErrors"][0]["code"], "timeout");
    assert_eq!(opened["configErrors"][1]["code"], "bad_option");
    let initial = opened["session"]["configOptions"].clone();
    assert_eq!(initial[0]["currentValue"], "small");
    c.replay("a1");
    assert_eq!(c.acp_prompt("a1", "release late result")["t"], "ok");
    c.event("a1", "turn_end");
    assert_eq!(c.summary("a1")["acp"]["configOptions"], initial);
    assert!(!hub.kinds("a1").iter().any(|kind| kind == "config"));
    drop(c);
    fold_equals_live(&mut hub);
}

#[cfg(debug_assertions)]
#[test]
fn hub_startup_config_journal_failure_releases_open_and_fails_remaining_entries() {
    let mut hub = Hub::start_with_env(
        |cfg| stub(cfg, "config-result", &["--scenario", "config-result"]),
        &[("WB_HUB_TEST_FAIL_WRITE_AT", "3")],
    );
    let mut c = hub.connect();
    let opened = spawn_config(
        &mut c,
        &hub,
        "a1",
        "config-result",
        json!([
            {"id": "model", "value": "large"}, {"id": "thinking", "value": true}
        ]),
    );
    let errors = opened["configErrors"].as_array().unwrap();
    assert_eq!(errors.len(), 2);
    assert!(errors.iter().all(|error| error["code"] == "faulted"));
    assert_eq!(
        opened["session"]["configOptions"][0]["currentValue"],
        "small"
    );
    c.replay("a1");
    c.summary_until("a1", "faulted and dead", |summary| {
        summary["fault"]["code"] == "journal_write" && summary["alive"] == false
    });
    assert_eq!(hub.kinds("a1"), ["spawn", "session"]);
    assert_eq!(
        hub.received_calls("config-result", "session/set_config_option")
            .len(),
        1
    );
    // Probe the one-shot failure and record the held-back exit before comparing folds.
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": false}));
    assert!(c.summary("a1")["fault"].is_null());
    assert_eq!(hub.kinds("a1"), ["spawn", "session", "exit"]);
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_config_result_is_authoritative_journaled_and_available_without_replay() {
    let mut hub = Hub::with_scenarios(&["config-result"]);
    let mut c = hub.connect();
    let open = ready(&mut c, &hub, "a1", "config-result");
    let epoch = epoch(&open);
    let initial = c.summary("a1")["acp"]["configOptions"].clone();
    assert_eq!(initial[0]["currentValue"], "small");
    assert_eq!(initial[2]["currentValue"], false);
    assert_eq!(
        configure(&mut c, "a1", epoch, "model", json!("large"))["t"],
        "ok"
    );
    let event = c.event("a1", "config");
    let options = &event["configOptions"];
    assert_eq!(options[0]["currentValue"], "large");
    assert_eq!(options[1]["options"][2]["value"], "max");
    assert_eq!(tail(&hub, "a1", 1), ["config"]);
    assert!(!hub.kinds("a1").iter().any(|kind| kind == "update"));
    assert_eq!(
        configure(&mut c, "a1", epoch, "effort", json!("max"))["t"],
        "ok"
    );
    assert_eq!(
        c.event("a1", "config")["configOptions"][1]["currentValue"],
        "max"
    );
    assert_eq!(
        configure(&mut c, "a1", epoch, "effort", json!("high"))["t"],
        "ok"
    );
    assert_eq!(
        c.event("a1", "config")["configOptions"][1]["currentValue"],
        "low"
    );
    assert_eq!(
        configure(&mut c, "a1", epoch, "thinking", json!(true))["t"],
        "ok"
    );
    let current = c.event("a1", "config")["configOptions"].clone();
    assert_eq!(current[2]["currentValue"], true);
    assert_eq!(c.summary("a1")["acp"]["configOptions"], current);
    let mut attached = hub.connect();
    let reopened = attached.ok(json!({"t": "acp.open", "sid": "a1", "since": 6, "epoch": epoch}));
    assert_eq!(reopened["session"]["configOptions"], current);
    assert_eq!(reopened["summary"]["acp"]["configOptions"], current);
    let (replay, _) = attached.replay("a1");
    assert!(replay.is_empty());
    let calls = hub.received_calls("config-result", "session/set_config_option");
    assert_eq!(
        calls[0]["params"],
        json!({"sessionId": c.summary("a1")["acp"]["agentSessionId"],
                                       "configId": "model", "value": "large"})
    );
    assert_eq!(calls[3]["params"]["type"], "boolean");
    assert_eq!(calls[3]["params"]["value"], true);
    drop((c, attached));
    fold_equals_live(&mut hub);
    let mut c = hub.connect();
    assert_eq!(c.summary("a1")["acp"]["configOptions"], current);
}

#[test]
fn hub_config_rejects_unknown_values_and_stale_epochs_without_agent_calls() {
    let mut hub = Hub::with_scenarios(&["config-result", "basic"]);
    let mut c = hub.connect();
    let open = ready(&mut c, &hub, "a1", "config-result");
    let current_epoch = epoch(&open);
    for (id, value) in [
        ("missing", json!("large")),
        ("model", json!("missing")),
        ("model", json!(true)),
        ("thinking", json!("true")),
        ("thinking", json!(1)),
        ("thinking", Value::Null),
        ("effort", json!("max")),
    ] {
        assert_eq!(
            configure(&mut c, "a1", current_epoch, id, value)["code"],
            "bad_option"
        );
    }
    assert_eq!(
        configure(&mut c, "a1", current_epoch + 1, "missing", json!({}))["code"],
        "stale"
    );
    assert!(
        hub.received_calls("config-result", "session/set_config_option")
            .is_empty()
    );
    let basic = ready(&mut c, &hub, "b1", "basic");
    assert_eq!(
        configure(&mut c, "b1", epoch(&basic), "model", json!("large"))["code"],
        "bad_option"
    );
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": false}));
    assert_eq!(
        configure(&mut c, "a1", current_epoch + 1, "missing", Value::Null)["code"],
        "not_alive"
    );
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": true}));
    let recreated = ready(&mut c, &hub, "a1", "config-result");
    assert_ne!(epoch(&recreated), current_epoch);
    assert_eq!(
        configure(&mut c, "a1", current_epoch, "model", json!("large"))["code"],
        "stale"
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_config_requires_a_live_acp_session_before_checking_epoch_or_option() {
    let mut hub = Hub::with_scenarios(&["auth"]);
    let mut c = hub.connect();
    let (open, _) = spawn_until(&mut c, &hub, "a1", "auth", "setup_error");
    let reply = configure(&mut c, "a1", epoch(&open) + 1, "missing", Value::Null);
    assert_eq!(reply["code"], "bad_request");
    assert!(
        hub.received_calls("auth", "session/set_config_option")
            .is_empty()
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_config_updates_during_a_pending_turn() {
    let mut hub = Hub::with_scenarios(&["config"]);
    let mut c = hub.connect();
    let open = ready(&mut c, &hub, "a1", "config");
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    c.event("a1", "permission");
    assert_eq!(
        configure(&mut c, "a1", epoch(&open), "thinking", json!(true))["t"],
        "ok"
    );
    let update = c.event("a1", "update");
    assert_eq!(update["update"]["sessionUpdate"], "config_option_update");
    assert_eq!(
        c.event("a1", "config")["configOptions"][2]["currentValue"],
        true
    );
    let summary = c.summary("a1");
    assert_eq!(summary["acp"]["activity"], "turn");
    assert_eq!(summary["acp"]["pending"].as_array().unwrap().len(), 1);
    assert_eq!(summary["acp"]["configOptions"][2]["currentValue"], true);
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_config_agent_errors_malformed_results_and_death_never_invent_values() {
    let mut hub = Hub::with_scenarios(&["config-error", "config-malformed", "config-exit"]);
    let mut c = hub.connect();
    for (i, agent) in ["config-error", "config-malformed", "config-exit"]
        .into_iter()
        .enumerate()
    {
        let sid = format!("a{i}");
        let open = ready(&mut c, &hub, &sid, agent);
        let initial = c.summary(&sid)["acp"]["configOptions"].clone();
        let reply = configure(&mut c, &sid, epoch(&open), "model", json!("large"));
        assert_eq!(
            reply["code"],
            if agent == "config-exit" {
                "not_alive"
            } else {
                "agent_error"
            }
        );
        assert_eq!(c.summary(&sid)["acp"]["configOptions"], initial);
        assert!(!hub.kinds(&sid).iter().any(|kind| kind == "config"));
    }
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_config_timeout_ignores_a_late_result_without_changing_the_offering() {
    let mut hub = Hub::with_scenarios(&["config-hang"]);
    let mut c = hub.connect();
    let open = ready(&mut c, &hub, "a1", "config-hang");
    let initial = c.summary("a1")["acp"]["configOptions"].clone();
    c.send(
        &json!({"t": "acp.set_config_option", "rid": 900, "sid": "a1",
                  "epoch": epoch(&open), "configId": "model", "value": "large"}),
    );
    let reply = c.reply_within(900, Duration::from_secs(40));
    assert_eq!(reply["code"], "timeout");
    // The fake releases its held result before answering this prompt. Its late
    // config response must not create an event or overwrite the offering.
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    c.event("a1", "turn_end");
    assert_eq!(c.summary("a1")["acp"]["configOptions"], initial);
    assert!(!hub.kinds("a1").iter().any(|kind| kind == "config"));
    drop(c);
    fold_equals_live(&mut hub);
}

#[cfg(debug_assertions)]
#[test]
fn hub_config_journal_failure_is_not_acknowledged_or_folded() {
    let mut hub = Hub::start_with_env(
        |cfg| stub(cfg, "config-result", &["--scenario", "config-result"]),
        &[("WB_HUB_TEST_FAIL_WRITE_AT", "3")],
    );
    let mut c = hub.connect();
    let open = ready(&mut c, &hub, "a1", "config-result");
    let initial = c.summary("a1")["acp"]["configOptions"].clone();
    let reply = configure(&mut c, "a1", epoch(&open), "model", json!("large"));
    assert_eq!(reply["code"], "faulted");
    let summary = c.summary_until("a1", "faulted and dead", |s| {
        s["fault"]["code"] == "journal_write" && s["alive"] == false
    });
    assert_eq!(summary["acp"]["configOptions"], initial);
    assert_eq!(hub.kinds("a1"), ["spawn", "session"]);
    assert_eq!(
        configure(&mut c, "a1", epoch(&open) + 1, "missing", Value::Null)["code"],
        "faulted"
    );
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": false}));
    drop(c);
    fold_equals_live(&mut hub);
}

fn set_task(c: &mut Client, sid: &str, task: Value) -> Value {
    c.request(json!({"t": "acp.set_task", "sid": sid, "task": task}))
}

#[test]
fn hub_set_task_refuses_an_absent_sid() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let reply = set_task(&mut c, "missing", json!("work"));
    assert_eq!(reply["code"], "not_found");
}

#[test]
fn hub_set_task_refuses_a_pty_session() {
    let hub = Hub::start();
    let mut c = hub.connect();
    c.spawn("p1", &["sleep", "1000"]);
    let reply = set_task(&mut c, "p1", json!("work"));
    assert_eq!(reply["code"], "kind_mismatch");
}

#[test]
fn hub_validates_task_before_creation_or_mutation() {
    let hub = Hub::with_scenarios(&["basic"]);
    let mut c = hub.connect();
    let max = "é".repeat(wb_proto::limits::TASK_MAX / 2);
    let invalid = [
        json!(format!("{max}x")),
        json!("\nissue 44"),
        json!("issue\u{7f}44"),
        json!(false),
    ];
    let spawn = |task: &Value| {
        json!({"t": "acp.open", "sid": "a1", "since": 0,
               "spawn": {"agent": "basic", "cwd": hub.home(), "task": task}})
    };
    for value in &invalid {
        assert_eq!(c.request(spawn(value))["code"], "bad_request");
    }
    assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
    assert!(!hub.acp_file("a1.jsonl").exists());
    let opened = c.ok(spawn(&json!(format!("  {max}  "))));
    assert_eq!(opened["summary"]["acp"]["task"], max);
    c.event("a1", "session");
    for value in invalid {
        assert_eq!(set_task(&mut c, "a1", value)["code"], "bad_request");
    }
    assert_eq!(
        c.request(json!({"t": "acp.set_task", "sid": "a1"}))["code"],
        "bad_request"
    );
    let reopened = c.ok(spawn(&json!("not a mutation")));
    assert_eq!(reopened["new"], false);
    assert_eq!(reopened["summary"]["acp"]["task"], max);
    assert_eq!(hub.kinds("a1"), ["task", "spawn", "session"]);
}

#[test]
fn hub_task_and_clear_survive_restart_and_revive_independently_of_config() {
    let mut hub = Hub::with_scenarios(&["config-result", "basic"]);
    let mut c = hub.connect();
    assert_eq!(c.hello["acpTask"], true);
    let opened = c.ok(json!({
        "t": "acp.open", "sid": "a1", "since": 0,
        "spawn": {"agent": "config-result", "cwd": hub.home(), "task": "  issue 44  ",
                  "config": [{"id": "model", "value": "large"}]}
    }));
    let options = &opened["summary"]["acp"]["configOptions"];
    assert_eq!(options[0]["currentValue"], "large");
    assert_eq!(opened["summary"]["acp"]["task"], "issue 44");
    let (replay, _) = c.replay("a1");
    assert_eq!(replay[0]["e"], "task");
    assert_eq!(replay[0]["task"], "issue 44");
    assert_eq!(set_task(&mut c, "a1", json!("  issue 45  "))["t"], "ok");
    assert_eq!(c.event("a1", "task")["task"], "issue 45");
    assert_eq!(&c.summary("a1")["acp"]["configOptions"], options);

    let cleared = c.ok(json!({"t": "acp.open", "sid": "cleared", "since": 0,
        "spawn": {"agent": "basic", "cwd": hub.home(), "task": "   "}}));
    assert!(cleared["summary"]["acp"].get("task").is_none());
    c.event("cleared", "session");
    assert_eq!(hub.kinds("cleared"), ["spawn", "session"]);
    for clear in [json!("  "), Value::Null] {
        assert_eq!(set_task(&mut c, "cleared", json!("work"))["t"], "ok");
        assert_eq!(c.event("cleared", "task")["task"], "work");
        assert_eq!(set_task(&mut c, "cleared", clear)["t"], "ok");
        assert_eq!(c.event("cleared", "task").get("task"), Some(&Value::Null));
        assert!(c.summary("cleared")["acp"].get("task").is_none());
    }
    drop(c);
    fold_equals_live(&mut hub);

    let mut c = hub.connect();
    let reopened = c.ok(json!({"t": "acp.open", "sid": "a1", "since": 0}));
    assert_eq!(reopened["summary"]["acp"]["task"], "issue 45");
    assert_eq!(&reopened["summary"]["acp"]["configOptions"], options);
    c.replay("a1");
    revive(&mut c, "a1");
    assert_eq!(c.summary("a1")["acp"]["task"], "issue 45");
    let reopened = c.ok(json!({"t": "acp.open", "sid": "cleared", "since": 0}));
    assert!(reopened["summary"]["acp"].get("task").is_none());
    c.replay("cleared");
    revive(&mut c, "cleared");
    assert!(c.summary("cleared")["acp"].get("task").is_none());
}

#[test]
fn hub_initial_task_and_policy_survive_restart_and_revive() {
    let mut hub = policy_hub();
    let mut c = hub.connect();
    let policy = permission_policy("allow");
    let check = |summary: &Value| {
        assert_eq!(summary["acp"]["task"], "issue 44");
        assert_eq!(summary["acp"]["policy"], policy);
    };
    let opened = c.ok(json!({"t": "acp.open", "sid": "a1", "since": 0,
        "spawn": {"agent": "omp", "cwd": hub.home(), "task": "  issue 44  ", "policy": policy}}));
    check(&opened["summary"]);
    c.event("a1", "session");
    assert_eq!(hub.kinds("a1"), ["task", "policy", "spawn", "session"]);
    drop(c);
    fold_equals_live(&mut hub);

    let mut c = hub.connect();
    let attached = c.acp_open("a1", 0);
    check(&attached["summary"]);
    c.replay("a1");
    let events = revive(&mut c, "a1");
    let session = events.iter().find(|e| e["e"] == "session").unwrap();
    assert_eq!(session["via"], "resume");
    check(&c.summary("a1"));
    assert_eq!(c.acp_prompt("a1", "perm")["t"], "ok");
    assert_eq!(
        c.event("a1", "permission_auto")["outcome"]["optionId"],
        "allow-once"
    );
    c.event("a1", "turn_end");
}

#[cfg(debug_assertions)]
#[test]
fn hub_initial_task_write_fault_refuses_creation_before_starting_the_agent() {
    let policy = permission_policy("allow");
    // Task alone, then both fields with the fault on the task or the following policy.
    for (fail_at, initial_policy) in [("1", None), ("1", Some(&policy)), ("2", Some(&policy))] {
        let hub = Hub::start_with_env(
            |cfg| stub(cfg, "basic", &["--scenario", "basic"]),
            &[("WB_HUB_TEST_FAIL_WRITE_AT", fail_at)],
        );
        let mut c = hub.connect();
        let mut open = json!({"t": "acp.open", "sid": "a1", "since": 0,
            "spawn": {"agent": "basic", "cwd": hub.home(), "task": "work",
                      "config": [{"id": "model", "value": "large"}]}});
        if let Some(policy) = initial_policy {
            open["spawn"]["policy"] = policy.clone();
        }
        let reply = c.request(open.clone());
        assert_eq!(reply["t"], "err");
        assert_eq!(reply["code"], "faulted");
        assert!(fs::read_dir(hub.acp_file("")).unwrap().next().is_none());
        assert!(hub.record("basic").is_empty());
        assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
        assert_eq!(c.acp_open("a1", 0)["code"], "not_found");

        let retried = c.ok(open);
        assert_eq!(retried["new"], true);
        assert_eq!(retried["summary"]["acp"]["task"], "work");
        assert_eq!(retried["summary"]["acp"].get("policy"), initial_policy);
        c.event("a1", "session");
    }
}

#[cfg(debug_assertions)]
#[test]
fn hub_task_write_fault_does_not_clear_the_last_recorded_value() {
    let hub = Hub::start_with_env(
        |cfg| stub(cfg, "basic", &["--scenario", "basic"]),
        &[("WB_HUB_TEST_FAIL_WRITE_AT", "4")],
    );
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "basic");
    assert_eq!(set_task(&mut c, "a1", json!("keep"))["t"], "ok");
    assert_eq!(set_task(&mut c, "a1", Value::Null)["code"], "faulted");
    let summary = c.summary_until("a1", "faulted and dead", |s| {
        s["fault"]["code"] == "journal_write" && s["alive"] == false
    });
    assert_eq!(summary["acp"]["task"], "keep");
    assert_eq!(hub.kinds("a1"), ["spawn", "session", "task"]);
}

#[test]
fn hub_kill_forget_outlasts_a_stubborn_agent_then_respawns_fresh() {
    let mut hub = Hub::with_scenarios(&["kill-stubborn", "basic"]);
    let mut w = hub.connect();
    w.ok(json!({"t": "watch"}));
    let mut c = hub.connect();
    let (open, evs) = spawn_until(&mut c, &hub, "a1", "kill-stubborn", "session");
    let pid = agent_pid(&evs);
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    c.event("a1", "update");
    let started = Instant::now();
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": true}));
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(5) && took < Duration::from_secs(9),
        "{took:?}"
    );
    assert!(!running(pid));
    assert!(group_members(pid).is_empty());
    let notes: Vec<Value> = hub
        .record("kill-stubborn")
        .iter()
        .filter_map(|e| e.get("note").cloned())
        .collect();
    assert_eq!(notes, ["env", "stdin_eof", "sigterm"]);
    for client in [&mut c, &mut w] {
        let gone = client.until("gone", |m| m["t"] == "gone");
        assert_eq!(gone["sid"], "a1");
        assert_eq!(gone["epoch"], epoch(&open));
    }
    for ext in ["json", "jsonl"] {
        assert!(
            !hub.acp_file(&format!("a1.{ext}")).exists(),
            "a1.{ext} kept"
        );
    }
    let (open2, evs) = spawn_until(&mut c, &hub, "a1", "basic", "session");
    assert_ne!(epoch(&open2), epoch(&open));
    let seqs: Vec<&Value> = evs.iter().map(|e| &e["seq"]).collect();
    assert_eq!(seqs, [1, 2], "not a fresh transcript");
    drop((c, w));
    fold_equals_live(&mut hub);
}

/// Unlike `wait_gone`, this also waits for a zombie to disappear.
fn wait_reaped(pid: u32) {
    let proc = PathBuf::from(format!("/proc/{pid}"));
    eventually(PATIENCE, "the agent leader is reaped", || {
        !proc.try_exists().unwrap()
    });
}

#[test]
fn hub_kills_what_a_crashed_agent_left_in_its_group() {
    let scenario = "crash-leave-child";
    let mut hub = Hub::with_scenarios_and(&[scenario], |config| {
        let state = PathBuf::from(config["stateDir"].as_str().unwrap());
        let survivor = state.with_file_name("group-survivor.pid");
        let bash = config["shells"][0]["paths"][0].clone();
        let fake = &mut config["agents"][scenario]["argv"];
        // Publish readiness only after ignoring TERM, so this member needs KILL.
        let script = r#"
(
    trap '' TERM
    printf '%s\n' "$BASHPID" >"$1"
    exec sleep 60
) </dev/null >/dev/null 2>&1 &
shift
exec "$@"
"#;
        let mut argv = vec![
            bash,
            json!("-c"),
            json!(script),
            json!("survivor"),
            json!(survivor),
        ];
        argv.append(fake.as_array_mut().unwrap());
        *fake = json!(argv);
    });
    let mut c = hub.connect();
    let (_, evs) = spawn_until(&mut c, &hub, "a1", scenario, "session");
    let pgid = agent_pid(&evs);
    let survivor = hub.dir.join("group-survivor.pid");
    let survivor_pid = || {
        fs::read_to_string(&survivor)
            .ok()?
            .strip_suffix('\n')?
            .parse::<u32>()
            .ok()
    };
    eventually(PATIENCE, "the stubborn group member is ready", || {
        survivor_pid().is_some()
    });
    let survivor_pid = survivor_pid().unwrap();
    assert!(group_members(pgid).contains(&survivor_pid));
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let exit = c.event("a1", "exit");
    assert_eq!(exit["reason"], "exited");
    assert_eq!(exit["code"], 1);

    let note = hub
        .record(scenario)
        .into_iter()
        .find(|e| e["note"] == "child")
        .expect("a child note");
    let child = u32::try_from(note["childPid"].as_u64().unwrap()).unwrap();
    eventually(PATIENCE, "both crash survivors are terminated", || {
        !running(child) && !running(survivor_pid) && group_members(pgid).is_empty()
    });
    wait_reaped(pgid);
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_leaves_a_child_that_left_the_group() {
    let mut hub = Hub::with_scenarios(&["setsid-child"]);
    let mut c = hub.connect();
    let (_, evs) = spawn_until(&mut c, &hub, "a1", "setsid-child", "session");
    let leader = agent_pid(&evs);
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    c.event("a1", "exit");
    let note = hub
        .record("setsid-child")
        .into_iter()
        .find(|e| e["note"] == "child")
        .expect("a child note");
    let child = u32::try_from(note["childPid"].as_u64().unwrap()).unwrap();
    // No live group member remained. Wait for cleanup before checking the escapee.
    wait_reaped(leader);
    let survived = group_members(child) == [child];
    common::signal(child, rustix::process::Signal::KILL);
    assert!(
        survived,
        "the hub killed a process outside the agent's group"
    );
    assert!(wait_gone(child, PATIENCE));
    drop(c);
    fold_equals_live(&mut hub);
}

/// `replay-large`'s message `m` after coalescing: its 20 chunks in order.
fn large_message(m: usize) -> String {
    (0..20)
        .map(|c| {
            let mut text = format!("[{m:03}.{c:02}]");
            text.extend(std::iter::repeat_n('x', (5 << 10) - text.len()));
            text
        })
        .collect()
}

#[test]
fn hub_large_replay_is_capped_coalesced_and_ascending() {
    let mut hub = Hub::with_scenarios(&["replay-large"]);
    let mut a = hub.connect();
    let open = ready(&mut a, &hub, "a1", "replay-large");
    assert_eq!(a.acp_prompt("a1", "go")["t"], "ok");
    drop(a);
    // spawn, session, prompt, 10 messages of 20 chunks, the permission at 204, then 190
    // more messages: 4004 events before the ticks.
    let mut c = hub.connect();
    let s = c.summary_until("a1", "the chunks and a tick", |s| {
        s["acp"]["headSeq"].as_u64().unwrap() > 4004
    });
    assert_eq!(s["acp"]["pending"][0]["req"], 204);

    let mut b = hub.connect();
    let reply = b.ok(json!({"t": "acp.open", "sid": "a1", "since": 0, "epoch": epoch(&open)}));
    let head = reply["head"].as_u64().unwrap();
    let from = reply["from"].as_u64().unwrap();
    let (evs, replayed) = b.replay("a1");
    assert_eq!(replayed["head"], head);
    assert_eq!(replayed["truncated"], true);
    assert!(from > 204, "from {from}");
    let seqs: Vec<u64> = evs.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
    assert!(
        seqs.windows(2).all(|w| w[0] < w[1]),
        "not ascending: {seqs:?}"
    );
    assert_eq!(seqs.last(), Some(&head));
    let pinned = evs
        .iter()
        .position(|e| e["seq"] == 204)
        .expect("the pending permission");
    assert_eq!(evs[pinned]["e"], "permission");
    // Only the pinned event lies below `from`, so it comes first.
    assert_eq!(pinned, 0);
    assert!(seqs[1..].iter().all(|s| *s >= from));
    let size: usize = evs.iter().map(|e| e.to_string().len()).sum();
    let cap = wb_proto::limits::ACP_REPLAY_MAX;
    assert!(size <= cap + (128 << 10), "replay of {size} bytes");
    assert!(size >= 3 << 20, "replay of only {size} bytes");
    for ev in &evs[pinned + 1..] {
        let u = &ev["update"];
        let id = u["messageId"].as_str().unwrap_or_default();
        if let Some(m) = id.strip_prefix("big-") {
            let m: usize = m.parse().unwrap();
            assert_eq!(
                u["content"]["text"].as_str().unwrap(),
                large_message(m),
                "big-{m}"
            );
        }
    }
    let live = b.until("a live event", |m| m["t"] == "acp.ev");
    assert_eq!(live["ev"]["seq"], head + 1);
    assert_eq!(
        permit(&mut b, "a1", &json!(204), epoch(&open), "allow-once")["t"],
        "ok"
    );
    b.event("a1", "turn_end");
    drop((b, c));
    fold_equals_live(&mut hub);
}

#[test]
fn hub_slow_reader_gets_the_paced_replay_then_the_live_events() {
    let mut hub = Hub::with_scenarios(&[]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "stub");
    turn_then_kill(&mut c, "a1");
    drop(c);
    hub.terminate();
    // 70,000 small notices: the replay keeps the last 4 MiB of them, about 6 MB on the
    // wire, more than CONN_QUEUE and the socket together, so it is paced.
    let path = hub.acp_file("a1.jsonl");
    let journal = std::fs::read_to_string(&path).unwrap();
    let last: Value = serde_json::from_str(journal.lines().last().unwrap()).unwrap();
    let (mut head, ts) = (last["seq"].as_u64().unwrap(), last["ts"].as_u64().unwrap());
    let mut more = String::new();
    for _ in 0..70_000 {
        head += 1;
        more += &json!({"seq": head, "ts": ts, "e": "notice", "level": "info", "text": "n"})
            .to_string();
        more.push('\n');
    }
    std::fs::write(&path, journal + &more).unwrap();
    hub.restart();

    let mut b = hub.connect();
    assert_eq!(
        b.ok(json!({"t": "acp.open", "sid": "a1", "since": 0}))["head"],
        head
    );
    // While b reads nothing its queue fills and the replay waits. Viewers come and go
    // meanwhile; their `acp.info`s wait in b's backlog.
    for _ in 0..60 {
        let mut o = hub.connect();
        o.ok(json!({"t": "acp.open", "sid": "a1", "since": head}));
    }
    // b now reads at about 2 MB/s, slower than the hub sends.
    let (mut n, mut seq) = (0, 0);
    let replayed = loop {
        let m = b
            .next()
            .unwrap_or_else(|| panic!("closed after {n} messages, at seq {seq}"));
        n += 1;
        if n % 20 == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        match m["t"].as_str() {
            Some("acp.ev") => {
                let s = m["ev"]["seq"].as_u64().unwrap();
                assert!(s > seq, "{s} after {seq}");
                seq = s;
            }
            Some("acp.replayed") => break m,
            _ => {}
        }
    };
    assert_eq!(replayed["head"], head);
    assert_eq!(seq, head);
    assert!(n > 50_000, "a replay of only {n} messages");
    b.until("a held-back acp.info", |m| m["t"] == "acp.info");
}

#[test]
fn hub_kill9_midturn_is_normalised_at_restart() {
    let mut hub = Hub::with_scenarios(&["permission"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "permission");
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let perm = c.event("a1", "permission");
    drop(c);
    hub.kill9();
    hub.restart();
    let journal = hub.journal("a1");
    let n = journal.len();
    let last3: Vec<&Value> = journal[n - 3..].iter().collect();
    assert_eq!(last3[0]["e"], "permission_resolved");
    assert_eq!(last3[0]["req"], perm["seq"]);
    assert_eq!(last3[0]["by"], "hub");
    assert_eq!(last3[1]["e"], "turn_error");
    assert_eq!(last3[1]["code"], "interrupted");
    assert_eq!(last3[2]["e"], "exit");
    assert_eq!(last3[2]["reason"], "hub_restart");
    let mut c = hub.connect();
    let s = c.summary("a1");
    assert_eq!(s["alive"], false);
    assert_eq!(s["acp"]["revivable"], true);
    assert_eq!(s["acp"]["pending"], json!([]));
    assert_eq!(s["acp"]["activity"], "none");
    c.ok(json!({"t": "acp.open", "sid": "a1", "since": n as u64}));
    c.replay("a1");
    c.ok(json!({"t": "acp.revive", "sid": "a1"}));
    assert_eq!(c.event("a1", "session")["via"], "resume");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_sigterm_midturn_writes_hub_restart_and_ends_the_group() {
    let mut hub = Hub::with_scenarios(&["permission"]);
    let mut c = hub.connect();
    let (_, evs) = spawn_until(&mut c, &hub, "a1", "permission", "session");
    let pid = agent_pid(&evs);
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    c.event("a1", "permission");
    drop(c);
    hub.terminate();
    assert!(wait_gone(pid, PATIENCE));
    assert_eq!(
        tail(&hub, "a1", 3),
        ["permission_resolved", "turn_error", "exit"]
    );
    let journal = hub.journal("a1");
    assert_eq!(journal[journal.len() - 2]["code"], "interrupted");
    assert_eq!(journal[journal.len() - 1]["reason"], "hub_restart");
    hub.restart();
    let mut c = hub.connect();
    assert_eq!(c.summary("a1")["acp"]["revivable"], true);
    drop(c);
    fold_equals_live(&mut hub);
}

// The release `package` check omits this test; `debug-tests` runs it with the hook enabled.
#[cfg(debug_assertions)]
#[test]
fn hub_journal_write_fault_fails_closed_and_recovers() {
    let mut hub = Hub::start_with_env(
        |config| stub(config, "basic", &["--scenario", "basic"]),
        &[("WB_HUB_TEST_FAIL_WRITE_AT", "5")],
    );
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "basic");
    // spawn 1, session 2, prompt 3, update 4; the second update's append fails.
    assert_eq!(c.acp_prompt("a1", "go")["t"], "ok");
    let s = c.summary_until("a1", "faulted and dead", |s| {
        s["fault"]["code"] == "journal_write" && s["alive"] == false
    });
    assert_eq!(s["acp"]["headSeq"], 4);
    assert_eq!(hub.kinds("a1"), ["spawn", "session", "prompt", "update"]);
    assert_eq!(c.acp_prompt("a1", "again")["code"], "faulted");
    // A kill retries the death-invariant lines; they take seqs 5 and 6.
    c.ok(json!({"t": "acp.kill", "sid": "a1", "forget": false}));
    let s = c.summary_until("a1", "the fault cleared", |s| s["fault"].is_null());
    assert_eq!(s["acp"]["headSeq"], 6);
    assert_eq!(tail(&hub, "a1", 2), ["turn_error", "exit"]);
    assert_eq!(s["acp"]["revivable"], true);
    c.ok(json!({"t": "acp.revive", "sid": "a1"}));
    c.summary_until("a1", "revived", |s| s["alive"] == true);
    let journal = hub.journal("a1");
    assert_eq!(journal[6]["e"], "spawn");
    assert_eq!(journal[6]["via"], "revive");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_quarantines_a_garbage_journal() {
    let mut hub = Hub::with_scenarios(&["basic"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "basic");
    turn_then_kill(&mut c, "a1");
    drop(c);
    hub.terminate();
    let meta = std::fs::read_to_string(hub.acp_file("a1.json")).unwrap();
    let mut meta: Value = serde_json::from_str(&meta).unwrap();
    meta["sid"] = "x".into();
    std::fs::write(hub.acp_file("x.json"), meta.to_string()).unwrap();
    let spawn = std::fs::read_to_string(hub.acp_file("a1.jsonl")).unwrap();
    let first = spawn.lines().next().unwrap();
    std::fs::write(
        hub.acp_file("x.jsonl"),
        format!("not a journal line\n{first}\n"),
    )
    .unwrap();
    hub.restart();

    let mut c = hub.connect();
    let x = c.summary("x");
    assert_eq!(x["fault"]["code"], "load_failed");
    assert_eq!(x["alive"], false);
    assert_eq!(x["acp"]["revivable"], false);
    assert_eq!(c.summary("a1")["fault"], Value::Null);
    let names: Vec<String> = std::fs::read_dir(hub.acp_file(""))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    for ext in ["json", "jsonl"] {
        assert!(
            names
                .iter()
                .any(|n| n.starts_with("x.quarantine-") && n.ends_with(&format!(".{ext}"))),
            "no quarantined .{ext} in {names:?}"
        );
    }
    assert!(!hub.acp_file("x.json").exists());
    c.ok(json!({"t": "acp.kill", "sid": "x", "forget": true}));
    let after: Vec<String> = std::fs::read_dir(hub.acp_file(""))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        after
            .iter()
            .filter(|n| n.starts_with("x.quarantine-"))
            .count(),
        2,
        "{after:?}"
    );
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn restored_summaries_only_use_wire_bounds_on_overflow() {
    use std::io::{BufWriter, Write};
    use wb_proto::hub::{HubMessage, Summary};
    use wb_proto::limits::MAX_LINE;

    const RID: u64 = u64::MAX;
    const PENDING: u64 = 4097;
    let mut hub = Hub::start();
    assert!(hub.terminate().success());
    let agent_id = "s".repeat(32 * 1024 + 1);
    let pending: Vec<_> = (3..3 + PENDING)
        .map(|req| json!({"req": req, "kind": "permission", "title": "", "ts": 1}))
        .collect();
    let mut original: Summary = serde_json::from_value(json!({
        "sid": "a-fit", "kind": "acp", "host": "example", "createdAt": 1,
        "updatedAt": 9_999_999_999_999_999_999u64, "alive": false, "viewers": 0,
        "cwd": CWD, "fault": null, "acp": {
            "agent": "basic", "agentSessionId": agent_id, "revivable": false, "activity": "none",
            "pending": pending, "last": null, "headSeq": PENDING + 2, "seenSeq": 0,
            "title": "", "modeId": null, "configOptions": null
        }
    }))
    .unwrap();
    let baseline = serde_json::to_vec(&HubMessage::SessionsPage {
        rid: RID,
        sessions: vec![original.clone()],
    })
    .unwrap()
    .len();
    // Leave room for the actual timestamp. Both titles separately fit as journal lines.
    let title_len = MAX_LINE - baseline - 1;
    original.acp.as_mut().unwrap().title = Some("x".repeat(title_len));
    for (sid, len) in [("a-fit", title_len), ("b-big", title_len + 128)] {
        let mut journal =
            BufWriter::new(fs::File::create(hub.acp_file(&format!("{sid}.jsonl"))).unwrap());
        fs::write(
            hub.acp_file(&format!("{sid}.json")),
            json!({"sid": sid, "agent": "basic", "cwd": CWD, "createdAt": 1, "seenSeq": 0})
                .to_string(),
        )
        .unwrap();
        writeln!(
            journal,
            "{}",
            json!({
                "seq": 1, "ts": 1, "e": "session", "via": "new", "sessionId": agent_id
            })
        )
        .unwrap();
        writeln!(
            journal,
            "{}",
            json!({
                "seq": 2, "ts": 1, "e": "update",
                "update": {"sessionUpdate": "session_info_update", "title": "x".repeat(len)}
            })
        )
        .unwrap();
        for seq in 3..3 + PENDING {
            writeln!(
                journal,
                "{}",
                json!({
                    "seq": seq, "ts": 1, "e": "permission", "toolCall": {}, "options": []
                })
            )
            .unwrap();
        }
        journal.flush().unwrap();
    }
    hub.restart();
    let mut watcher = hub.connect();
    watcher.send(&json!({"t": "watch", "rid": RID, "stream": true}));
    let mut first = watcher.next().unwrap();
    assert_eq!(first["t"], "sessions.page");
    assert_eq!(first["rid"], RID);
    let [actual]: [Summary; 1] = serde_json::from_value(first["sessions"].take()).unwrap();
    original.updated_at = actual.updated_at;
    assert_eq!(actual.acp.as_ref().unwrap().pending.len(), PENDING as usize);
    assert!(actual == original, "a fitting summary was changed");

    let last = watcher.next().unwrap();
    assert_eq!(last["t"], "ok");
    let [bounded] = last["sessions"].as_array().unwrap().as_slice() else {
        panic!("expected one final summary");
    };
    assert_eq!(bounded["sid"], "b-big");
    assert_eq!(bounded["acp"]["pending"].as_array().unwrap().len(), 4096);
    assert_eq!(bounded["acp"]["agentSessionId"], Value::Null);
    assert_eq!(bounded["acp"]["title"].as_str().unwrap().len(), 32 * 1024);
}

#[test]
fn hub_exec_failure_writes_only_setup_error() {
    let mut hub = Hub::start_with(|config| {
        config["agents"]["missing"] =
            json!({"label": "Missing", "argv": ["/nonexistent/wb-agent"]});
    });
    let mut c = hub.connect();
    let (_, evs) = spawn_until(&mut c, &hub, "a1", "missing", "setup_error");
    assert_eq!(evs.last().unwrap()["code"], "spawn_failed");
    assert_eq!(hub.kinds("a1"), ["setup_error"]);
    let s = c.summary("a1");
    assert_eq!(s["alive"], false);
    assert_eq!(s["acp"]["last"]["error"]["code"], "spawn_failed");
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_acp_open_errors() {
    let hub = Hub::with_scenarios(&["basic"]);
    let mut c = hub.connect();
    assert_eq!(c.acp_open("nope", 0)["code"], "not_found");
    assert_eq!(c.acp_prompt("nope", "hi")["code"], "not_found");
    let unknown = c.request(json!({"t": "acp.open", "sid": "a1", "since": 0,
                                   "spawn": {"agent": "absent", "cwd": hub.home()}}));
    assert_eq!(unknown["code"], "unknown_agent");
    c.spawn("p1", &["sleep", "1000"]);
    let mismatch = c.request(json!({"t": "acp.open", "sid": "p1", "since": 0,
                                    "spawn": {"agent": "basic", "cwd": hub.home()}}));
    assert_eq!(mismatch["code"], "kind_mismatch");
    ready(&mut c, &hub, "a1", "basic");
    assert_eq!(c.attach("a1")["code"], "kind_mismatch");
}

#[test]
fn hub_builds_the_agent_environment_from_scratch() {
    let hub = Hub::with_scenarios(&["basic"]);
    let mut c = hub.connect();
    ready(&mut c, &hub, "a1", "basic");
    let record = hub.record("basic");
    let env = record.iter().find(|e| e["note"] == "env").unwrap();
    let names: Vec<&str> = env["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "HOME",
            "LOGNAME",
            "PATH",
            "RUST_LOG",
            "SHELL",
            "USER",
            "WB_SESSION",
            "WB_SET"
        ]
    );
    assert_eq!(env["SHELL"], hub.shell);
    assert_eq!(env["WB_SESSION"], "a1");
    for canary in common::CANARIES {
        assert!(!names.contains(&canary), "{canary} reached the agent");
    }
}

// ---- agents on another host (DESIGN §3.8.5) ----

/// The launcher of host `laptop`: it notes its directory, its argument count and its
/// arguments in `launches`, leaves a `sleep` in its process group (noted in
/// `sleepers`), knows only the agent `stub`, changes to the decoded cwd, sets
/// `WB_SESSION` and becomes `wb-fake-acp` in keyword mode, recording to `remote.rec`.
const LAUNCHER: &str = r#"here=${0%/*}
printf '%s %s %s\n' "$PWD" "$#" "$*" >> "$here/launches"
sleep 600 </dev/null >/dev/null 2>&1 &
echo $! >> "$here/sleepers"
[ "$1" = stub ] || { echo "no agent $1" >&2; exit 1; }
hex=$2 path=
while [ -n "$hex" ]; do path+="\\x${hex:0:2}"; hex=${hex:2}; done
printf -v cwd "$path"
cd "$cwd" || exit 1
export WB_SESSION=$3
exec "$FAKE" --record "$here/remote.rec"
"#;

/// A hub with the `basic` scenario as a local agent and host `laptop`, whose launcher
/// is [`LAUNCHER`] run by bash.
fn hub_with_laptop() -> Hub {
    Hub::with_scenarios_and(&["basic"], |config| {
        let state = PathBuf::from(config["stateDir"].as_str().unwrap());
        let dir = state.parent().unwrap();
        let script = dir.join("launch.sh");
        let fake = env!("CARGO_BIN_EXE_wb-fake-acp");
        fs::write(&script, format!("FAKE={fake}\n{LAUNCHER}")).unwrap();
        let bash = config["shells"][0]["paths"][0].clone();
        config["hosts"] = json!({"laptop": {
            "argv": [bash, script],
            "agents": {"stub": {"label": "Remote stub"}}
        }});
    })
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

/// Each launch: the launcher's directory, its argument count and its arguments.
fn launches(hub: &Hub) -> Vec<(String, String, Vec<String>)> {
    fs::read_to_string(hub.dir.join("launches"))
        .unwrap_or_default()
        .lines()
        .map(|l| {
            let mut words = l.split(' ');
            let pwd = words.next().unwrap().to_owned();
            let count = words.next().unwrap().to_owned();
            (pwd, count, words.map(str::to_owned).collect())
        })
        .collect()
}

fn remote_spawn(c: &mut Client, sid: &str, agent: &str, cwd: &str, host: &str) -> Value {
    c.request(json!({"t": "acp.open", "sid": sid, "since": 0,
                     "spawn": {"agent": agent, "cwd": cwd, "host": host}}))
}

fn last_sleeper(hub: &Hub) -> u32 {
    let text = fs::read_to_string(hub.dir.join("sleepers")).unwrap();
    text.lines().last().unwrap().parse().unwrap()
}

#[test]
fn hub_starts_an_agent_on_another_host_through_its_launcher() {
    let mut hub = hub_with_laptop();
    let mut c = hub.connect();
    assert_eq!(c.hello["host"], "example");
    assert_eq!(
        c.hello["hosts"],
        json!([{"name": "laptop", "agents": [{"name": "stub", "label": "Remote stub"}]}])
    );
    let cwd = hub.dir.join("work dir").join("ü;$(x)");
    fs::create_dir_all(&cwd).unwrap();
    let cwd = cwd.to_str().unwrap().to_owned();

    let open = remote_spawn(&mut c, "r1", "stub", &cwd, "laptop");
    assert_eq!(open["t"], "ok", "{open}");
    assert_eq!(open["new"], true);
    assert_eq!(open["summary"]["host"], "laptop");
    assert_eq!(open["summary"]["cwd"], cwd);
    let evs = c.events_until("r1", "session");
    let pid = agent_pid(&evs);

    // Run in the hub's home with exactly the agent, the hex cwd and the sid.
    let want = vec!["stub".to_owned(), hex(&cwd), "r1".to_owned()];
    assert_eq!(launches(&hub), [(hub.home(), "3".to_owned(), want.clone())]);
    let plain = |a: &String| {
        a.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    assert!(want.iter().all(plain));
    // The agent runs in the decoded cwd, with the launcher's WB_SESSION.
    let agent_cwd = fs::read_link(format!("/proc/{pid}/cwd")).unwrap();
    assert_eq!(agent_cwd.to_str().unwrap(), cwd);
    let record = hub.record("remote");
    let env = record.iter().find(|e| e["note"] == "env").unwrap();
    assert_eq!(env["WB_SESSION"], "r1");
    assert_eq!(env["SHELL"], hub.shell);
    let names: Vec<&str> = env["names"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect();
    assert!(names.contains(&"WB_SET"), "{names:?}");
    // `agents.<name>.env` is for local agents.
    assert!(!names.contains(&"RUST_LOG"), "{names:?}");
    for canary in common::CANARIES {
        assert!(!names.contains(&canary), "{canary} reached the launcher");
    }
    let new = hub.received_calls("remote", "session/new");
    assert_eq!(new[0]["params"]["cwd"], cwd);
    let meta: Value = serde_json::from_slice(&fs::read(hub.acp_file("r1.json")).unwrap()).unwrap();
    assert_eq!(meta["host"], "laptop");
    assert_eq!(c.summary("r1")["host"], "laptop");
    assert_eq!(c.acp_prompt("r1", "hello there")["t"], "ok");
    c.event("r1", "turn_end");
    drop(c);

    // The session remembers its host: a revive after a restart goes the same way.
    hub.terminate();
    hub.restart();
    let mut c = hub.connect();
    let s = c.summary("r1");
    assert_eq!(s["host"], "laptop");
    assert_eq!(s["alive"], false);
    assert_eq!(c.acp_open("r1", 0)["t"], "ok");
    c.replay("r1");
    let evs = revive(&mut c, "r1");
    assert_eq!(evs[0]["via"], "revive");
    let pid = agent_pid(&evs);
    let all = launches(&hub);
    assert_eq!(all.len(), 2, "{all:?}");
    assert_eq!(all[1], (hub.home(), "3".to_owned(), want));
    let resume = hub.received_calls("remote", "session/resume");
    assert_eq!(resume.len(), 1);
    assert_eq!(resume[0]["params"]["cwd"], cwd);

    // A kill ends the launcher's process group, the sleep it left included.
    let sleeper = last_sleeper(&hub);
    assert!(running(sleeper));
    c.ok(json!({"t": "acp.kill", "sid": "r1", "forget": false}));
    c.summary_until("r1", "the agent exits", |s| s["alive"] == false);
    eventually(PATIENCE, "the group is gone", || {
        group_members(pid).is_empty()
    });
    assert!(!running(sleeper));
    drop(c);
    fold_equals_live(&mut hub);
}

#[test]
fn hub_refuses_remote_spawns_it_cannot_make_and_keeps_no_session() {
    let hub = hub_with_laptop();
    let mut c = hub.connect();
    let home = hub.home();
    let missing = hub.dir.join("not here").to_str().unwrap().to_owned();
    let long = format!("/{}", "a".repeat(4096));
    let refusals = [
        ("stub", home.as_str(), "mars", "bad_request", "no host mars"),
        (
            "basic",
            &home,
            "laptop",
            "unknown_agent",
            "no agent basic on laptop",
        ),
        ("stub", "relative", "laptop", "bad_request", "cwd"),
        ("stub", "/a\0b", "laptop", "bad_request", "cwd"),
        ("stub", &long, "laptop", "bad_request", "cwd"),
        // The hub's own host is local: its rules apply.
        (
            "stub",
            &missing,
            "example",
            "bad_request",
            "existing directory",
        ),
        ("stub", &missing, "", "bad_request", "no host "),
    ];
    for (agent, cwd, host, code, message) in refusals {
        let err = remote_spawn(&mut c, "r1", agent, cwd, host);
        assert_eq!(err["code"], code, "{host} {agent}: {err}");
        let text = err["message"].as_str().unwrap();
        assert!(text.contains(message), "{host} {agent}: {err}");
        assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
        assert!(!hub.acp_file("r1.json").exists());
    }
    assert!(launches(&hub).is_empty());
    // A local spawn refuses the missing cwd too.
    let err = c.request(json!({"t": "acp.open", "sid": "r1", "since": 0,
                               "spawn": {"agent": "stub", "cwd": missing}}));
    assert_eq!(err["code"], "bad_request", "{err}");

    // On another host the cwd is not looked up here.
    let open = remote_spawn(&mut c, "r1", "stub", &missing, "laptop");
    assert_eq!(open["t"], "ok", "{open}");
    assert_eq!(open["summary"]["host"], "laptop");
    c.event("r1", "exit");
    let all = launches(&hub);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].2[1], hex(&missing));

    // `host` naming the hub's own host is a local spawn and is recorded as one.
    let open = remote_spawn(&mut c, "a1", "stub", &home, "example");
    assert_eq!(open["t"], "ok", "{open}");
    assert_eq!(open["summary"]["host"], "example");
    c.events_until("a1", "session");
    let meta: Value = serde_json::from_slice(&fs::read(hub.acp_file("a1.json")).unwrap()).unwrap();
    assert!(meta.get("host").is_none(), "{meta}");
    assert_eq!(launches(&hub).len(), 1);
    assert_eq!(hub.received_calls("stub", "session/new").len(), 1);
}
