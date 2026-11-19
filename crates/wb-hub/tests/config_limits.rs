//! Oversized agent offerings cannot break the hub's session snapshots, including old journals.
mod common;

use std::fs;
use std::path::Path;
use std::time::Duration;

use common::Hub;
use serde_json::{Value, json};
use wb_proto::limits::MAX_LINE;

fn boolean() -> Value {
    json!({"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": false})
}

fn huge_options() -> Value {
    let mut option = boolean();
    option["description"] = json!("x".repeat(9 << 20));
    json!([option])
}

/// Prepared lines keep the agent's large reply independent of the hub's encoder.
fn big_agent(dir: &Path, initial: Value) -> String {
    fs::create_dir_all(dir).unwrap();
    let huge = huge_options();
    for (name, line) in [
        (
            "init",
            json!({"jsonrpc": "2.0", "id": 1, "result": {
                "protocolVersion": 1, "agentCapabilities": {}
            }}),
        ),
        (
            "new",
            json!({"jsonrpc": "2.0", "id": 2, "result": {
                "sessionId": "s1", "configOptions": initial
            }}),
        ),
        (
            "config",
            json!({"jsonrpc": "2.0", "id": 3, "result": {"configOptions": huge}}),
        ),
        (
            "update",
            json!({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": "s1", "update": {"sessionUpdate": "config_option_update", "configOptions": huge}
            }}),
        ),
        (
            "end",
            json!({"jsonrpc": "2.0", "id": 4, "result": {"stopReason": "end_turn"}}),
        ),
    ] {
        fs::write(dir.join(format!("{name}.json")), line.to_string()).unwrap();
    }
    let script = format!(
        r#"n=0
while IFS= read -r line; do
  n=$((n+1))
  case $n in
    1) printf '%s\n' "$(<"{d}/init.json")" ;;
    2) printf '%s\n' "$(<"{d}/new.json")" ;;
    3) printf '%s\n' "$(<"{d}/config.json")" ;;
    4) printf '%s\n' "$(<"{d}/update.json")" "$(<"{d}/end.json")" ;;
  esac
done
"#,
        d = dir.display()
    );
    let path = dir.join("big.sh");
    fs::write(&path, script).unwrap();
    path.display().to_string()
}

fn hub_with_big_agent(initial: Value) -> Hub {
    Hub::start_with(|cfg| {
        let dir = Path::new(cfg["stateDir"].as_str().unwrap())
            .parent()
            .unwrap()
            .join("big");
        let script = big_agent(&dir, initial);
        cfg["agents"]["big"] = json!({
            "label": "Big", "argv": [cfg["shells"][0]["paths"][0], script]
        });
    })
}

#[test]
fn oversized_new_offerings_leave_open_and_list_below_max_line() {
    let hub = hub_with_big_agent(huge_options());
    let mut c = hub.connect();
    for sid in ["b1", "b2"] {
        c.acp_spawn(sid, "big", &hub.home());
        let session = c
            .events_until_within(sid, "session", Duration::from_secs(20))
            .pop()
            .unwrap();
        assert!(session.get("configOptions").is_none());
    }
    let mut attached = hub.connect();
    let open = attached.acp_open("b1", 0);
    assert!(open.to_string().len() < MAX_LINE);
    assert!(open["session"]["configOptions"].is_null());
    assert!(open["summary"]["acp"]["configOptions"].is_null());
    let list = c.ok(json!({"t": "list"}));
    assert!(list.to_string().len() < MAX_LINE);
    for summary in list["sessions"].as_array().unwrap() {
        assert_eq!(summary["alive"], true);
        assert!(summary["acp"]["configOptions"].is_null());
    }
}

#[test]
fn oversized_live_replacements_keep_the_previous_offering() {
    let initial = json!([boolean()]);
    let hub = hub_with_big_agent(initial.clone());
    let mut c = hub.connect();
    let open = c.acp_spawn("a1", "big", &hub.home());
    c.event("a1", "session");
    let reply = c.request(json!({"t": "acp.set_config_option", "sid": "a1",
        "epoch": open["summary"]["createdAt"], "configId": "thinking", "value": true}));
    assert_eq!(reply["code"], "agent_error");
    assert_eq!(c.summary("a1")["acp"]["configOptions"], initial);
    assert_eq!(c.acp_prompt("a1", "send an oversized update")["t"], "ok");
    c.event("a1", "turn_end");
    assert_eq!(c.summary("a1")["acp"]["configOptions"], initial);
    assert_eq!(hub.kinds("a1"), ["spawn", "session", "prompt", "turn_end"]);
}

#[test]
fn oversized_legacy_journal_offerings_are_absent_after_restart() {
    let mut hub = Hub::with_scenarios(&["basic"]);
    let mut c = hub.connect();
    for sid in ["session", "config", "update"] {
        c.acp_spawn(sid, "basic", &hub.home());
        c.event(sid, "session");
    }
    drop(c);
    hub.terminate();
    for sid in ["session", "config", "update"] {
        let mut journal = hub.journal(sid);
        if sid == "session" {
            journal.iter_mut().find(|ev| ev["e"] == "session").unwrap()["configOptions"] =
                huge_options();
        } else {
            let mut event = json!({"seq": journal.len() + 1, "ts": 2000, "e": sid});
            if sid == "config" {
                event["configOptions"] = huge_options();
            } else {
                event["update"] = json!({"sessionUpdate": "config_option_update", "configOptions": huge_options()});
            }
            journal.push(event);
        }
        let mut text = String::new();
        for event in journal {
            text.push_str(&event.to_string());
            text.push('\n');
        }
        fs::write(hub.acp_file(&format!("{sid}.jsonl")), text).unwrap();
    }
    hub.restart();
    let mut c = hub.connect();
    let list = c.ok(json!({"t": "list"}));
    assert!(list.to_string().len() < MAX_LINE);
    for sid in ["session", "config", "update"] {
        let open = c.acp_open(sid, 0);
        assert_eq!(open["t"], "ok");
        assert!(open.to_string().len() < MAX_LINE);
        assert!(open["summary"]["fault"].is_null());
        assert!(open["summary"]["acp"]["configOptions"].is_null());
        assert!(open["session"]["configOptions"].is_null());
        c.replay(sid);
    }
}
