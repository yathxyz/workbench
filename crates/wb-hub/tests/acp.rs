//! ACP: `wb-fake-acp` on its own (every scenario and keyword over stdio, every message
//! checked against the ACP schema), and the hub's ACP sessions against it (DESIGN §9.2,
//! 10-hub §11.3).

mod common;

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use common::acp::group_members;
use common::fake::{Agent, text_of, updates};
use common::{running, wait_gone};

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

// ---- the fake on its own ----

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
    let status = a
        .exit_within(common::PATIENCE)
        .expect("exit at end of stdin");
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
    assert_eq!(
        text_of(&updates(&msgs), "agent_message_chunk"),
        format!("form accept: {content}")
    );

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
    // Exactly one response reached the fake.
    let answers: Vec<Value> = a
        .record()
        .into_iter()
        .filter(|e| e["recv"]["id"] == req["id"] && e["recv"].get("result").is_some())
        .collect();
    assert_eq!(answers.len(), 1);
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
    let status = a.exit_within(common::PATIENCE).unwrap();
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
    assert!(a.exit_within(common::PATIENCE).unwrap().success());
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
    assert_eq!(a.exit_within(common::PATIENCE).unwrap().code(), Some(1));
    let child = recorded_child(&a);
    assert!(running(child));
    assert_eq!(group_members(a.pid()), [child]);
    // `sleep` holds the fake's stdout open: no end of output yet.
    assert!(a.quiet_for(Duration::from_millis(200)));
    drop(a);
    assert!(wait_gone(child, common::PATIENCE));
}

#[test]
fn scenario_setsid_child_leaves_sleep_in_a_group_of_its_own() {
    let (mut a, session) = scenario("setsid-child");
    a.prompt(&session, "go");
    assert_eq!(a.next_raw(), None);
    assert_eq!(a.exit_within(common::PATIENCE).unwrap().code(), Some(1));
    let child = recorded_child(&a);
    assert!(group_members(a.pid()).is_empty());
    assert_eq!(group_members(child), [child]);
    drop(a);
    assert!(running(child), "the group kill reached it");
    common::signal(child, rustix::process::Signal::KILL);
    assert!(wait_gone(child, common::PATIENCE));
}
