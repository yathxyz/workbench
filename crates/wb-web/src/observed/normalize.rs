//! One event's payload, native or neutral, reduced to an [`Event`] (design §3.8.3).

use serde_json::{Map, Value};

use super::{OBS_TEXT_MAX, ObsKind, Tool};

/// Longest tail line, in bytes.
pub(super) const TAIL_MAX: usize = 240;
/// The harnesses whose payload is their hook's stdin, unchanged.
const NATIVE: [&str; 2] = ["claude", "codex"];
/// The tool input fields that stand for the whole input, first present wins.
const INPUT_KEYS: [&str; 6] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "description",
];

/// What the fold needs from one payload. Texts are already excerpts.
#[derive(Debug, PartialEq)]
pub(super) struct Event {
    pub kind: ObsKind,
    /// A `Notification` of type `permission_prompt`: a `permission` only while nothing
    /// is pending, else a `note`.
    pub prompt_notice: bool,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub cwd: Option<String>,
    pub transcript_path: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    /// The prompt, the last assistant message, or the message of a request or note.
    pub text: Option<String>,
    pub tool: Option<Tool>,
    pub tail: String,
}

/// Whether `s` is a session id or agent id: `^[A-Za-z0-9._:-]{1,128}$`.
pub(super) fn valid_session_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

/// `s` cut to at most `max` bytes, `…` included, without cutting a character. `max`
/// must be at least 6.
pub(super) fn excerpt(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut cut = max - '…'.len_utf8();
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

/// An excerpt for a tail line, on one line.
fn tail_line(s: &str) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    excerpt(&flat, TAIL_MAX)
}

/// The string at `key`, as an excerpt; absent for any other type.
fn text(p: &Map<String, Value>, key: &str) -> Option<String> {
    p.get(key)
        .and_then(Value::as_str)
        .map(|s| excerpt(s, OBS_TEXT_MAX))
}

/// A hook event name compared tolerantly: lowercase, without `_`.
fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '_')
        .flat_map(char::to_lowercase)
        .collect()
}

/// A tool input as one excerpt: the first present of [`INPUT_KEYS`], else compact JSON.
fn input_excerpt(v: &Value) -> Option<String> {
    let as_text = |v: &Value| match v {
        Value::String(s) => excerpt(s, OBS_TEXT_MAX),
        other => excerpt(&other.to_string(), OBS_TEXT_MAX),
    };
    match v {
        Value::Null => None,
        Value::Object(m) => Some(
            INPUT_KEYS
                .iter()
                .find_map(|k| m.get(*k).filter(|x| !x.is_null()))
                .map_or_else(|| as_text(v), as_text),
        ),
        other => Some(as_text(other)),
    }
}

/// `a: b`, or whichever of them is present.
fn join(a: Option<&str>, b: Option<&str>) -> String {
    match (a, b) {
        (Some(a), Some(b)) => format!("{a}: {b}"),
        (Some(s), None) | (None, Some(s)) => s.to_owned(),
        (None, None) => String::new(),
    }
}

fn tool_tail(tool: Option<&Tool>) -> String {
    let name = tool.map(|t| t.name.as_str());
    join(name, tool.and_then(|t| t.input.as_deref()))
}

/// Reduces `payload` of `harness`. `Err` is a refusal with its message.
pub(super) fn normalize(harness: &str, payload: &Map<String, Value>) -> Result<Event, String> {
    let session_id = payload
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|s| valid_session_id(s))
        .ok_or("bad session_id")?
        .to_owned();
    let agent_id = match payload.get("agent_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(a)) if valid_session_id(a) => Some(a.clone()),
        Some(_) => return Err("bad agent_id".into()),
    };
    let mut ev = Event {
        kind: ObsKind::Note,
        prompt_notice: false,
        session_id,
        agent_id,
        agent_type: text(payload, "agent_type"),
        cwd: text(payload, "cwd"),
        transcript_path: text(payload, "transcript_path"),
        model: text(payload, "model"),
        permission_mode: text(payload, "permission_mode"),
        text: None,
        tool: None,
        tail: String::new(),
    };
    if NATIVE.contains(&harness) {
        native(payload, &mut ev);
    } else {
        neutral(payload, &mut ev)?;
    }
    ev.tail = tail_line(&ev.tail);
    Ok(ev)
}

/// A hook's stdin: `hook_event_name` picks the kind (§3.8.3, the fold table).
fn native(p: &Map<String, Value>, ev: &mut Event) {
    let name = p.get("hook_event_name").and_then(Value::as_str);
    let tool = || {
        p.get("tool_name").and_then(Value::as_str).map(|n| Tool {
            name: excerpt(n, OBS_TEXT_MAX),
            input: p.get("tool_input").and_then(input_excerpt),
        })
    };
    match squash(name.unwrap_or_default()).as_str() {
        "sessionstart" => {
            ev.kind = ObsKind::Start;
            ev.tail = text(p, "source").unwrap_or_default();
        }
        "userpromptsubmit" => {
            ev.kind = ObsKind::Prompt;
            ev.text = text(p, "prompt");
            ev.tail = ev.text.clone().unwrap_or_default();
        }
        "pretooluse" => {
            ev.kind = ObsKind::ToolStart;
            ev.tool = tool();
            ev.tail = tool_tail(ev.tool.as_ref());
        }
        "posttooluse" => {
            ev.kind = ObsKind::ToolEnd;
            ev.tail = tool().map(|t| t.name).unwrap_or_default();
        }
        "posttoolusefailure" => {
            ev.kind = ObsKind::ToolFail;
            let name = tool().map(|t| t.name);
            ev.tail = join(name.as_deref(), text(p, "error").as_deref());
        }
        "permissionrequest" => {
            ev.kind = ObsKind::Permission;
            ev.tool = tool();
            ev.tail = tool_tail(ev.tool.as_ref());
        }
        "notification" => {
            let kind = p
                .get("notification_type")
                .and_then(Value::as_str)
                .map(squash);
            ev.text = text(p, "message");
            match kind.as_deref() {
                Some("permissionprompt") => {
                    ev.kind = ObsKind::Permission;
                    ev.prompt_notice = true;
                    ev.tail = ev.text.clone().unwrap_or_default();
                }
                Some("elicitationdialog") => {
                    ev.kind = ObsKind::Question;
                    ev.tail = ev.text.clone().unwrap_or_default();
                }
                _ => {
                    ev.tail = join(name, ev.text.as_deref());
                }
            }
        }
        "stop" => {
            ev.kind = ObsKind::TurnEnd;
            ev.text = text(p, "last_assistant_message");
            ev.tail = ev.text.clone().unwrap_or_default();
        }
        "subagentstart" => {
            ev.kind = ObsKind::SubagentStart;
            ev.tail = ev.agent_type.clone().unwrap_or_default();
        }
        "subagentstop" => {
            ev.kind = ObsKind::SubagentEnd;
            ev.text = text(p, "last_assistant_message");
            ev.tail = ev.agent_type.clone().unwrap_or_default();
        }
        "sessionend" => {
            ev.kind = ObsKind::End;
            ev.tail = text(p, "reason").unwrap_or_default();
        }
        _ => {
            ev.tail = name.unwrap_or_default().to_owned();
        }
    }
}

/// A neutral event: `kind` is an [`ObsKind`] by name.
fn neutral(p: &Map<String, Value>, ev: &mut Event) -> Result<(), String> {
    ev.kind = p
        .get("kind")
        .and_then(Value::as_str)
        .and_then(ObsKind::parse)
        .ok_or("unknown kind")?;
    ev.text = text(p, "text");
    ev.tool = p.get("tool").and_then(Value::as_object).and_then(|t| {
        t.get("name").and_then(Value::as_str).map(|n| Tool {
            name: excerpt(n, OBS_TEXT_MAX),
            input: t.get("input").and_then(input_excerpt),
        })
    });
    let reason = text(p, "reason");
    let tool_name = ev.tool.as_ref().map(|t| t.name.as_str());
    ev.tail = match ev.kind {
        ObsKind::Start => String::new(),
        ObsKind::ToolStart => tool_tail(ev.tool.as_ref()),
        ObsKind::ToolEnd => tool_name.unwrap_or_default().to_owned(),
        ObsKind::ToolFail => join(tool_name, reason.as_deref().or(ev.text.as_deref())),
        ObsKind::Permission if ev.text.is_none() => tool_tail(ev.tool.as_ref()),
        ObsKind::SubagentStart | ObsKind::SubagentEnd => ev.agent_type.clone().unwrap_or_default(),
        ObsKind::End | ObsKind::PermissionDone => reason.unwrap_or_default(),
        _ => ev.text.clone().unwrap_or_default(),
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use ObsKind::*;

    fn norm(harness: &str, v: Value) -> Result<Event, String> {
        normalize(harness, v.as_object().unwrap())
    }

    /// What a row checks: kind, the permission-prompt flag, text, tool name and input,
    /// agent id, tail.
    type Row = (
        ObsKind,
        bool,
        Option<&'static str>,
        Option<(&'static str, Option<&'static str>)>,
        Option<&'static str>,
        &'static str,
    );

    fn check(harness: &str, rows: Vec<(&str, Value, Row)>) {
        for (name, payload, want) in rows {
            let ev = norm(harness, payload).unwrap_or_else(|e| panic!("{name}: {e}"));
            let got = (
                ev.kind,
                ev.prompt_notice,
                ev.text.as_deref(),
                ev.tool
                    .as_ref()
                    .map(|t| (t.name.as_str(), t.input.as_deref())),
                ev.agent_id.as_deref(),
                ev.tail.as_str(),
            );
            assert_eq!(got, want, "{name}");
        }
    }

    // Claude Code 2.1.318: every fixture has the fields of the zod hook input schema
    // `hook_event_name: "<Name>"` in the installed bundle, on top of its base schema
    // (`session_id`, `transcript_path`, `cwd`, optional `permission_mode`, `agent_id`,
    // `agent_type`). Field values are illustrative; field names and literals are not.
    #[test]
    fn claude_fixtures() {
        let base = |extra: Value| {
            let mut v = json!({
                "session_id": "5f0c7e1a-3b2d-4c9e-8a71-2d6f0b9e4c13",
                "transcript_path": "/home/alice/.claude/projects/-home-alice-proj-x/5f0c7e1a.jsonl",
                "cwd": "/home/alice/proj/x",
                "permission_mode": "default"
            });
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            v
        };
        let edit = json!({"file_path": "/home/alice/proj/x/src/lib.rs", "old_string": "a", "new_string": "b"});
        check(
            "claude",
            vec![
                // Schema `SessionStart`: `source` in startup|resume|clear|compact|fork, `model` optional.
                (
                    "SessionStart",
                    base(
                        json!({"hook_event_name": "SessionStart", "source": "startup", "model": "claude-opus-4-1"}),
                    ),
                    (Start, false, None, None, None, "startup"),
                ),
                // Schema `UserPromptSubmit`: `prompt`, `source` optional.
                (
                    "UserPromptSubmit",
                    base(
                        json!({"hook_event_name": "UserPromptSubmit", "prompt": "Fix the test\nin auth.rs"}),
                    ),
                    (
                        Prompt,
                        false,
                        Some("Fix the test\nin auth.rs"),
                        None,
                        None,
                        "Fix the test in auth.rs",
                    ),
                ),
                // Schema `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`. The Edit
                // tool's input (`file_path`, `old_string`, `new_string`) is its schema in
                // the same bundle.
                (
                    "PreToolUse",
                    base(
                        json!({"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": edit, "tool_use_id": "toolu_01"}),
                    ),
                    (
                        ToolStart,
                        false,
                        None,
                        Some(("Edit", Some("/home/alice/proj/x/src/lib.rs"))),
                        None,
                        "Edit: /home/alice/proj/x/src/lib.rs",
                    ),
                ),
                // Schema `PreToolUse` from within a subagent: base `agent_id`, `agent_type`.
                (
                    "PreToolUse in a subagent",
                    base(
                        json!({"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": edit, "tool_use_id": "toolu_02", "agent_id": "a4c1f09", "agent_type": "general-purpose"}),
                    ),
                    (
                        ToolStart,
                        false,
                        None,
                        Some(("Edit", Some("/home/alice/proj/x/src/lib.rs"))),
                        Some("a4c1f09"),
                        "Edit: /home/alice/proj/x/src/lib.rs",
                    ),
                ),
                // Schema `PostToolUse`: `tool_response`, `duration_ms` optional.
                (
                    "PostToolUse",
                    base(
                        json!({"hook_event_name": "PostToolUse", "tool_name": "Edit", "tool_input": edit, "tool_response": {"filePath": "/home/alice/proj/x/src/lib.rs"}, "tool_use_id": "toolu_01", "duration_ms": 12}),
                    ),
                    (ToolEnd, false, None, None, None, "Edit"),
                ),
                // Schema `PostToolUseFailure`: `error`, `is_interrupt` optional.
                (
                    "PostToolUseFailure",
                    base(
                        json!({"hook_event_name": "PostToolUseFailure", "tool_name": "Edit", "tool_input": edit, "tool_use_id": "toolu_01", "error": "String not found in file", "is_interrupt": false}),
                    ),
                    (
                        ToolFail,
                        false,
                        None,
                        None,
                        None,
                        "Edit: String not found in file",
                    ),
                ),
                // Schema `PermissionRequest`: `tool_name`, `tool_input`, `permission_suggestions` optional.
                (
                    "PermissionRequest",
                    base(
                        json!({"hook_event_name": "PermissionRequest", "tool_name": "Edit", "tool_input": edit}),
                    ),
                    (
                        Permission,
                        false,
                        None,
                        Some(("Edit", Some("/home/alice/proj/x/src/lib.rs"))),
                        None,
                        "Edit: /home/alice/proj/x/src/lib.rs",
                    ),
                ),
                // Schema `Notification`: `message`, `title` optional, `notification_type`.
                // `permission_prompt` is in the bundle's notification type list; the
                // message text is illustrative.
                (
                    "Notification permission_prompt",
                    base(
                        json!({"hook_event_name": "Notification", "message": "Claude needs your permission to use Edit", "notification_type": "permission_prompt"}),
                    ),
                    (
                        Permission,
                        true,
                        Some("Claude needs your permission to use Edit"),
                        None,
                        None,
                        "Claude needs your permission to use Edit",
                    ),
                ),
                // `elicitation_dialog` is in the same list; the message text is illustrative.
                (
                    "Notification elicitation_dialog",
                    base(
                        json!({"hook_event_name": "Notification", "message": "Claude Code needs your input", "notification_type": "elicitation_dialog"}),
                    ),
                    (
                        Question,
                        false,
                        Some("Claude Code needs your input"),
                        None,
                        None,
                        "Claude Code needs your input",
                    ),
                ),
                // `idle_prompt` with the message the bundle sends it with.
                (
                    "Notification idle_prompt",
                    base(
                        json!({"hook_event_name": "Notification", "message": "Claude is waiting for your input", "notification_type": "idle_prompt"}),
                    ),
                    (
                        Note,
                        false,
                        Some("Claude is waiting for your input"),
                        None,
                        None,
                        "Notification: Claude is waiting for your input",
                    ),
                ),
                // Schema `Stop`: `stop_hook_active`, `last_assistant_message` optional.
                (
                    "Stop",
                    base(
                        json!({"hook_event_name": "Stop", "stop_hook_active": false, "last_assistant_message": "All tests pass.", "background_tasks": [], "session_crons": []}),
                    ),
                    (
                        TurnEnd,
                        false,
                        Some("All tests pass."),
                        None,
                        None,
                        "All tests pass.",
                    ),
                ),
                // Schema `SubagentStart`: `agent_id`, `agent_type`.
                (
                    "SubagentStart",
                    base(
                        json!({"hook_event_name": "SubagentStart", "agent_id": "a4c1f09", "agent_type": "general-purpose"}),
                    ),
                    (
                        SubagentStart,
                        false,
                        None,
                        None,
                        Some("a4c1f09"),
                        "general-purpose",
                    ),
                ),
                // Schema `SubagentStop`: `stop_hook_active`, `agent_id`,
                // `agent_transcript_path`, `agent_type`, `last_assistant_message` optional.
                (
                    "SubagentStop",
                    base(
                        json!({"hook_event_name": "SubagentStop", "stop_hook_active": false, "agent_id": "a4c1f09", "agent_transcript_path": "/home/alice/.claude/projects/-home-alice-proj-x/5f0c7e1a/subagents/agent-a4c1f09.jsonl", "agent_type": "general-purpose", "last_assistant_message": "Found 3 call sites."}),
                    ),
                    (
                        SubagentEnd,
                        false,
                        Some("Found 3 call sites."),
                        None,
                        Some("a4c1f09"),
                        "general-purpose",
                    ),
                ),
                // Schema `PreCompact`: `trigger` in manual|auto, `custom_instructions` nullable.
                (
                    "PreCompact",
                    base(
                        json!({"hook_event_name": "PreCompact", "trigger": "auto", "custom_instructions": null}),
                    ),
                    (Note, false, None, None, None, "PreCompact"),
                ),
                // Schema `SessionEnd`: `reason` in clear|resume|logout|prompt_input_exit|other.
                (
                    "SessionEnd",
                    base(json!({"hook_event_name": "SessionEnd", "reason": "prompt_input_exit"})),
                    (End, false, None, None, None, "prompt_input_exit"),
                ),
            ],
        );
    }

    // codex-cli 0.144.1: every fixture has exactly the `required` fields of the JSON
    // schema `<event>.command.input` embedded in the installed binary (codex-rs/hooks at
    // tag rust-v0.144.1). That release has no SessionEnd, Notification or
    // PostToolUseFailure hook. The shell tool's `tool_name` "Bash" and its `tool_input`
    // `{command, description?}` are from codex-rs/core/src/tools/hook_names.rs and
    // sandboxing.rs (`PermissionRequestPayload::bash`) at that tag. A subagent's events
    // carry the root thread's `session_id` and its own thread id as `agent_id`
    // (core/src/session/session.rs and hook_runtime.rs at that tag). Values are
    // illustrative.
    #[test]
    fn codex_fixtures() {
        let base = |extra: Value| {
            let mut v = json!({
                "session_id": "019a7c3e-55d1-7b20-9f3e-0c4d2a1b8e77",
                "transcript_path": null,
                "cwd": "/home/alice/proj/x",
                "model": "gpt-5.5",
            });
            v.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            v
        };
        let turn = "019a7c3e-6002-7c11-8d55-4b3a2f1e0d99";
        let bash = json!({"command": "cargo test", "description": "Run the tests"});
        check(
            "codex",
            vec![
                // session-start.command.input: `permission_mode`, `source` in startup|resume|clear|compact.
                (
                    "SessionStart",
                    base(
                        json!({"hook_event_name": "SessionStart", "permission_mode": "default", "source": "startup"}),
                    ),
                    (Start, false, None, None, None, "startup"),
                ),
                // user-prompt-submit.command.input: `prompt`, `turn_id`.
                (
                    "UserPromptSubmit",
                    base(
                        json!({"hook_event_name": "UserPromptSubmit", "permission_mode": "default", "prompt": "Add a test", "turn_id": turn}),
                    ),
                    (Prompt, false, Some("Add a test"), None, None, "Add a test"),
                ),
                // pre-tool-use.command.input: `tool_name`, `tool_input`, `tool_use_id`, `turn_id`.
                (
                    "PreToolUse",
                    base(
                        json!({"hook_event_name": "PreToolUse", "permission_mode": "default", "tool_name": "Bash", "tool_input": bash, "tool_use_id": "call_1", "turn_id": turn}),
                    ),
                    (
                        ToolStart,
                        false,
                        None,
                        Some(("Bash", Some("cargo test"))),
                        None,
                        "Bash: cargo test",
                    ),
                ),
                // permission-request.command.input: `tool_name`, `tool_input`, `turn_id`.
                (
                    "PermissionRequest",
                    base(
                        json!({"hook_event_name": "PermissionRequest", "permission_mode": "default", "tool_name": "Bash", "tool_input": bash, "turn_id": turn}),
                    ),
                    (
                        Permission,
                        false,
                        None,
                        Some(("Bash", Some("cargo test"))),
                        None,
                        "Bash: cargo test",
                    ),
                ),
                // post-tool-use.command.input: `tool_response`.
                (
                    "PostToolUse",
                    base(
                        json!({"hook_event_name": "PostToolUse", "permission_mode": "default", "tool_name": "Bash", "tool_input": bash, "tool_response": "ok", "tool_use_id": "call_1", "turn_id": turn}),
                    ),
                    (ToolEnd, false, None, None, None, "Bash"),
                ),
                // stop.command.input: `last_assistant_message`, `stop_hook_active`, `turn_id`.
                (
                    "Stop",
                    base(
                        json!({"hook_event_name": "Stop", "permission_mode": "default", "last_assistant_message": "Added the test.", "stop_hook_active": false, "turn_id": turn}),
                    ),
                    (
                        TurnEnd,
                        false,
                        Some("Added the test."),
                        None,
                        None,
                        "Added the test.",
                    ),
                ),
                // subagent-start.command.input: `agent_id`, `agent_type`, `turn_id`.
                (
                    "SubagentStart",
                    base(
                        json!({"hook_event_name": "SubagentStart", "permission_mode": "default", "agent_id": "019a7c3f-0001-7000-8000-000000000001", "agent_type": "explorer", "turn_id": turn}),
                    ),
                    (
                        SubagentStart,
                        false,
                        None,
                        None,
                        Some("019a7c3f-0001-7000-8000-000000000001"),
                        "explorer",
                    ),
                ),
                // subagent-stop.command.input: `agent_transcript_path`, `last_assistant_message`, `stop_hook_active`.
                (
                    "SubagentStop",
                    base(
                        json!({"hook_event_name": "SubagentStop", "permission_mode": "default", "agent_id": "019a7c3f-0001-7000-8000-000000000001", "agent_transcript_path": null, "agent_type": "explorer", "last_assistant_message": "Done.", "stop_hook_active": false, "turn_id": turn}),
                    ),
                    (
                        SubagentEnd,
                        false,
                        Some("Done."),
                        None,
                        Some("019a7c3f-0001-7000-8000-000000000001"),
                        "explorer",
                    ),
                ),
                // pre-compact.command.input: `trigger` in manual|auto, `turn_id`.
                (
                    "PreCompact",
                    base(
                        json!({"hook_event_name": "PreCompact", "trigger": "auto", "turn_id": turn}),
                    ),
                    (Note, false, None, None, None, "PreCompact"),
                ),
                // post-compact.command.input: `trigger`, `turn_id`.
                (
                    "PostCompact",
                    base(
                        json!({"hook_event_name": "PostCompact", "trigger": "manual", "turn_id": turn}),
                    ),
                    (Note, false, None, None, None, "PostCompact"),
                ),
            ],
        );
    }

    #[test]
    fn hook_names_match_without_case_or_underscores() {
        for name in ["PreToolUse", "pre_tool_use", "PRE_TOOL_USE", "preToolUse"] {
            let ev = norm(
                "codex",
                json!({"session_id": "s", "hook_event_name": name, "tool_name": "Bash"}),
            )
            .unwrap();
            assert_eq!(ev.kind, ToolStart, "{name}");
        }
        let ev = norm(
            "claude",
            json!({"session_id": "s", "hook_event_name": "notification", "notification_type": "PermissionPrompt"}),
        )
        .unwrap();
        assert!(ev.prompt_notice);
        let ev = norm("claude", json!({"session_id": "s"})).unwrap();
        assert_eq!((ev.kind, ev.tail.as_str()), (Note, ""));
    }

    #[test]
    fn neutral_events() {
        let n = |v: Value| {
            let mut v = v;
            v["session_id"] = json!("pi-1");
            norm("pi", v)
        };
        let rows: Vec<(&str, Value, Row)> = vec![
            (
                "start",
                json!({"kind": "start", "model": "m"}),
                (Start, false, None, None, None, ""),
            ),
            (
                "prompt",
                json!({"kind": "prompt", "text": "hi"}),
                (Prompt, false, Some("hi"), None, None, "hi"),
            ),
            (
                "tool_start",
                json!({"kind": "tool_start", "tool": {"name": "read", "input": {"path": "a.rs"}}}),
                (
                    ToolStart,
                    false,
                    None,
                    Some(("read", Some("a.rs"))),
                    None,
                    "read: a.rs",
                ),
            ),
            (
                "tool_fail",
                json!({"kind": "tool_fail", "tool": {"name": "read"}, "reason": "ENOENT"}),
                (
                    ToolFail,
                    false,
                    None,
                    Some(("read", None)),
                    None,
                    "read: ENOENT",
                ),
            ),
            (
                "permission",
                json!({"kind": "permission", "text": "May I?", "tool": {"name": "bash", "input": {"command": "rm x"}}}),
                (
                    Permission,
                    false,
                    Some("May I?"),
                    Some(("bash", Some("rm x"))),
                    None,
                    "May I?",
                ),
            ),
            (
                "permission_done",
                json!({"kind": "permission_done"}),
                (PermissionDone, false, None, None, None, ""),
            ),
            (
                "question",
                json!({"kind": "question", "text": "Which?"}),
                (Question, false, Some("Which?"), None, None, "Which?"),
            ),
            (
                "turn_end",
                json!({"kind": "turn_end", "text": "ok"}),
                (TurnEnd, false, Some("ok"), None, None, "ok"),
            ),
            (
                "subagent_start",
                json!({"kind": "subagent_start", "agent_id": "x1", "agent_type": "scout"}),
                (SubagentStart, false, None, None, Some("x1"), "scout"),
            ),
            (
                "note",
                json!({"kind": "note", "text": "compacting"}),
                (Note, false, Some("compacting"), None, None, "compacting"),
            ),
            (
                "end",
                json!({"kind": "end", "reason": "quit"}),
                (End, false, None, None, None, "quit"),
            ),
            (
                "a native name means nothing here",
                json!({"kind": "end", "hook_event_name": "PreToolUse"}),
                (End, false, None, None, None, ""),
            ),
        ];
        for (name, v, want) in rows {
            let ev = n(v).unwrap();
            let got = (
                ev.kind,
                ev.prompt_notice,
                ev.text.as_deref(),
                ev.tool
                    .as_ref()
                    .map(|t| (t.name.as_str(), t.input.as_deref())),
                ev.agent_id.as_deref(),
                ev.tail.as_str(),
            );
            assert_eq!(got, want, "{name}");
        }
    }

    #[test]
    fn refusals() {
        let rows = [
            (
                "pi",
                json!({"session_id": "s", "kind": "launch"}),
                "unknown kind",
            ),
            ("pi", json!({"session_id": "s"}), "unknown kind"),
            (
                "pi",
                json!({"session_id": "s", "kind": "PROMPT"}),
                "unknown kind",
            ),
            ("claude", json!({}), "bad session_id"),
            ("claude", json!({"session_id": ""}), "bad session_id"),
            ("claude", json!({"session_id": "a/b"}), "bad session_id"),
            ("claude", json!({"session_id": 7}), "bad session_id"),
            (
                "claude",
                json!({"session_id": "x".repeat(129)}),
                "bad session_id",
            ),
            (
                "claude",
                json!({"session_id": "s", "agent_id": "../x"}),
                "bad agent_id",
            ),
            (
                "claude",
                json!({"session_id": "s", "agent_id": 3}),
                "bad agent_id",
            ),
        ];
        for (harness, v, want) in rows {
            assert_eq!(norm(harness, v.clone()).unwrap_err(), want, "{v}");
        }
        assert!(
            norm(
                "claude",
                json!({"session_id": "a.B_c:d-9", "agent_id": null})
            )
            .is_ok()
        );
    }

    #[test]
    fn tool_inputs() {
        let rows = [
            (json!({"command": "ls", "path": "p"}), Some("ls")),
            (json!({"pattern": "fn", "path": "src"}), Some("src")),
            (json!({"command": null, "url": "u"}), Some("u")),
            (json!({"command": ["ls", "-l"]}), Some(r#"["ls","-l"]"#)),
            (json!({"query": "q"}), Some(r#"{"query":"q"}"#)),
            (json!("raw text"), Some("raw text")),
            (json!(42), Some("42")),
            (json!(null), None),
        ];
        for (input, want) in rows {
            assert_eq!(input_excerpt(&input).as_deref(), want, "{input}");
        }
    }

    #[test]
    fn excerpts_cut_at_a_char_boundary() {
        assert_eq!(excerpt("abcdef", 6), "abcdef");
        assert_eq!(excerpt("abcdefg", 6), "abc…");
        // é is 2 bytes, € 3, 😀 4; each straddles the cut at byte 3.
        assert_eq!(excerpt("abéxxxx", 6), "ab…");
        assert_eq!(excerpt("a€xxxxx", 6), "a…");
        assert_eq!(excerpt("ab😀xxxx", 6), "ab…");
        assert_eq!(excerpt("😀😀", 8), "😀😀");
        for max in [6, 7, 8, 9, 240, OBS_TEXT_MAX] {
            let s = "aé€😀".repeat(1000);
            let e = excerpt(&s, max);
            assert!(e.len() <= max && e.ends_with('…'), "{max}");
        }
        assert_eq!(tail_line("a\nb\tc"), "a b c");
        assert_eq!(tail_line(&"é".repeat(200)).len(), 239);
    }

    #[test]
    fn any_payload_shape_is_safe() {
        let shapes = [
            json!({"session_id": "s", "hook_event_name": 5, "tool_name": [], "tool_input": {"command": {"a": [1, {"b": null}]}}}),
            json!({"session_id": "s", "hook_event_name": "Notification", "notification_type": null, "message": {}}),
            json!({"session_id": "s", "hook_event_name": "PreToolUse", "tool_name": "x".repeat(10_000), "tool_input": "y".repeat(100_000)}),
            json!({"session_id": "s", "cwd": 1, "model": [], "agent_type": {}}),
        ];
        for v in shapes {
            let ev = norm("claude", v).unwrap();
            assert!(ev.tail.len() <= TAIL_MAX);
            if let Some(t) = ev.tool {
                assert!(t.name.len() <= OBS_TEXT_MAX);
                assert!(t.input.is_none_or(|i| i.len() <= OBS_TEXT_MAX));
            }
        }
    }
}
