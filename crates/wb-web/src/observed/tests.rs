use std::os::unix::fs::MetadataExt;

use serde_json::json;
use tempfile::TempDir;

use super::*;

const HOST: &str = "devbox";
const T0: u64 = 1_763_300_000_000;
/// The clock of the server as the events arrive; they are dated from `T0` to it.
const NOW: u64 = T0 + 60_000;
const PID: u64 = 4242;
const START: u64 = 98_765_432;

struct Fx {
    dir: TempDir,
    proc_root: PathBuf,
    reg: Registry,
}

fn fx() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let proc_root = dir.path().join("proc");
    fs::create_dir(&proc_root).unwrap();
    let reg = Registry::load(dir.path(), HOST, &proc_root, T0);
    Fx {
        dir,
        proc_root,
        reg,
    }
}

impl Fx {
    fn reload(&self, now: u64) -> Registry {
        Registry::load(self.dir.path(), HOST, &self.proc_root, now)
    }

    /// A process `pid` started at `start`, in the fake `/proc`.
    fn process(&self, pid: u64, start: u64) {
        let dir = self.proc_root.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        let fields: Vec<String> = (4..22).map(|n| n.to_string()).collect();
        let stat = format!("{pid} (a) b) (c) S {} {start} 23 24\n", fields.join(" "));
        fs::write(dir.join("stat"), stat).unwrap();
    }
}

/// A claude hook event of session `sid` at `at`, from pid [`PID`].
fn claude(sid: &str, at: u64, hook: &str, extra: Value) -> Value {
    let mut payload = json!({
        "session_id": sid,
        "transcript_path": "/home/alice/.claude/projects/x/s.jsonl",
        "cwd": "/home/alice/proj/x/src",
        "hook_event_name": hook,
    });
    payload
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    json!({
        "harness": "claude", "at": at, "pid": PID, "pidStart": START,
        "projectRoot": "/home/alice/proj/x", "payload": payload,
    })
}

fn edit() -> Value {
    json!({"tool_name": "Edit", "tool_input": {"file_path": "/home/alice/proj/x/a.rs"}})
}

fn by_key(reg: &Registry, key: &str) -> ObservedSession {
    reg.list()
        .into_iter()
        .find(|s| s.key == key)
        .unwrap_or_else(|| panic!("no record {key}"))
}

fn top(reg: &Registry) -> ObservedSession {
    by_key(reg, "devbox/claude/s1")
}

fn feed(reg: &Registry, events: &[(&str, Value)]) {
    for (i, (hook, extra)) in events.iter().enumerate() {
        let ev = claude("s1", T0 + i as u64, hook, extra.clone());
        reg.ingest(HOST, ev, NOW).unwrap();
    }
}

/// Hook events by name, with their fields beyond the common ones.
type Events = Vec<(&'static str, Value)>;

#[test]
fn state_table() {
    use State::*;
    let none = || json!({});
    let prompt = || ("UserPromptSubmit", json!({"prompt": "go"}));
    let rows: Vec<(&str, Events, State)> = vec![
        ("started", vec![("SessionStart", none())], Idle),
        ("prompted", vec![prompt()], Running),
        ("in a tool", vec![prompt(), ("PreToolUse", edit())], Running),
        (
            "asking permission",
            vec![prompt(), ("PermissionRequest", edit())],
            WaitingPermission,
        ),
        (
            "permission prompt notification",
            vec![
                prompt(),
                (
                    "Notification",
                    json!({"message": "m", "notification_type": "permission_prompt"}),
                ),
            ],
            WaitingPermission,
        ),
        (
            "asking a question",
            vec![
                prompt(),
                (
                    "Notification",
                    json!({"message": "m", "notification_type": "elicitation_dialog"}),
                ),
            ],
            WaitingInput,
        ),
        (
            "permission granted",
            vec![
                prompt(),
                ("PermissionRequest", edit()),
                ("PostToolUse", edit()),
            ],
            Running,
        ),
        ("turn over", vec![prompt(), ("Stop", none())], Done),
        (
            "next prompt",
            vec![prompt(), ("Stop", none()), prompt()],
            Running,
        ),
        (
            "idle notification keeps done",
            vec![
                prompt(),
                ("Stop", none()),
                (
                    "Notification",
                    json!({"message": "m", "notification_type": "idle_prompt"}),
                ),
            ],
            Done,
        ),
        (
            "ended while asking",
            vec![
                prompt(),
                ("PermissionRequest", edit()),
                ("SessionEnd", json!({"reason": "other"})),
            ],
            Exited,
        ),
        (
            "revived by a note after an end",
            vec![
                prompt(),
                ("PreToolUse", edit()),
                ("SessionEnd", json!({"reason": "other"})),
                ("PreCompact", none()),
            ],
            Idle,
        ),
    ];
    for (name, events, want) in rows {
        let f = fx();
        feed(&f.reg, &events);
        assert_eq!(top(&f.reg).state, want, "{name}");
    }
}

#[test]
fn fold_fills_the_record() {
    let f = fx();
    feed(
        &f.reg,
        &[
            (
                "SessionStart",
                json!({"source": "startup", "model": "claude-opus-4-1"}),
            ),
            (
                "UserPromptSubmit",
                json!({"prompt": "\n  Fix the test  \nplease"}),
            ),
            ("PreToolUse", edit()),
            (
                "PostToolUseFailure",
                json!({"tool_name": "Edit", "error": "nope"}),
            ),
            ("PreToolUse", edit()),
            ("PostToolUse", edit()),
            ("Stop", json!({"last_assistant_message": "Fixed."})),
        ],
    );
    let s = top(&f.reg);
    assert_eq!(s.id, id_of("devbox/claude/s1"));
    assert!(s.id.starts_with("o_") && s.id.len() == 18);
    assert_eq!(s.host, HOST);
    assert_eq!(s.project, "x");
    assert_eq!(s.cwd.as_deref(), Some("/home/alice/proj/x/src"));
    assert_eq!(s.model.as_deref(), Some("claude-opus-4-1"));
    assert_eq!(s.pid, Some(PID as u32));
    assert_eq!(s.title, "Fix the test");
    assert_eq!(s.last_prompt.as_deref(), Some("\n  Fix the test  \nplease"));
    assert_eq!(s.last_message.as_deref(), Some("Fixed."));
    assert_eq!(s.tool, None);
    assert_eq!((s.started_at, s.last_at), (T0, T0 + 6));
    assert_eq!(
        s.counts,
        Counts {
            events: 7,
            prompts: 1,
            tools: 2,
            tool_failures: 1,
            subagents: 0
        }
    );
    let kinds: Vec<ObsKind> = s.tail.iter().map(|t| t.kind).collect();
    use ObsKind::*;
    assert_eq!(
        kinds,
        [
            Start, Prompt, ToolStart, ToolFail, ToolStart, ToolEnd, TurnEnd
        ]
    );
    // The wire form is camelCase with the §3.4.6 state names.
    let v = serde_json::to_value(&s).unwrap();
    assert_eq!(v["state"], "done");
    assert_eq!(v["counts"]["toolFailures"], 1);
    assert!(v.get("pidStart").is_none() && v.get("turn").is_none());
}

#[test]
fn titles() {
    let f = fx();
    feed(&f.reg, &[("SessionStart", json!({}))]);
    assert_eq!(top(&f.reg).title, "claude · x");
    feed(&f.reg, &[("UserPromptSubmit", json!({"prompt": " \n"}))]);
    assert_eq!(top(&f.reg).title, "claude · x");
    let long = "é".repeat(100);
    feed(&f.reg, &[("UserPromptSubmit", json!({"prompt": long}))]);
    let title = top(&f.reg).title;
    assert!(title.len() <= 120 && title.ends_with('…'), "{title}");
    assert_eq!(title, format!("{}…", "é".repeat(58)));
    feed(&f.reg, &[("UserPromptSubmit", json!({"prompt": "later"}))]);
    assert_eq!(top(&f.reg).title, title);
    let text = "😀".repeat(1000);
    feed(&f.reg, &[("UserPromptSubmit", json!({"prompt": text}))]);
    let last = top(&f.reg).last_prompt.unwrap();
    assert!(last.len() <= OBS_TEXT_MAX && last.ends_with('…'));
    assert!(top(&f.reg).tail.iter().all(|t| t.text.len() <= 240));
}

#[test]
fn pending_is_cleared_by_later_events_but_notes_and_permissions() {
    let f = fx();
    let pending = |reg: &Registry| top(reg).pending.map(|p| (p.kind, p.tool, p.message));
    feed(
        &f.reg,
        &[
            ("UserPromptSubmit", json!({"prompt": "go"})),
            ("PermissionRequest", edit()),
        ],
    );
    let edit_pending = Some((PendingKind::Permission, Some("Edit".to_owned()), None));
    assert_eq!(pending(&f.reg), edit_pending);
    // A permission prompt notification while something is pending is only a note.
    feed(
        &f.reg,
        &[(
            "Notification",
            json!({"message": "needs you", "notification_type": "permission_prompt"}),
        )],
    );
    assert_eq!(pending(&f.reg), edit_pending);
    assert_eq!(top(&f.reg).tail.last().unwrap().kind, ObsKind::Note);
    feed(&f.reg, &[("PreCompact", json!({"trigger": "auto"}))]);
    assert_eq!(pending(&f.reg), edit_pending);
    feed(&f.reg, &[("PostToolUse", edit())]);
    assert_eq!(pending(&f.reg), None);
    // With nothing pending it is a permission of its own.
    feed(
        &f.reg,
        &[(
            "Notification",
            json!({"message": "needs you", "notification_type": "permission_prompt"}),
        )],
    );
    assert_eq!(
        pending(&f.reg),
        Some((PendingKind::Permission, None, Some("needs you".to_owned())))
    );
    // A subagent's event leaves the parent's pending alone.
    feed(
        &f.reg,
        &[("PreToolUse", json!({"agent_id": "a1", "tool_name": "Read"}))],
    );
    assert!(pending(&f.reg).is_some());
    feed(&f.reg, &[("Stop", json!({}))]);
    assert_eq!(pending(&f.reg), None);

    // A neutral permission_done clears it.
    let pi = |kind: &str| json!({"harness": "pi", "payload": {"session_id": "p", "kind": kind, "text": "ok?"}});
    f.reg.ingest(HOST, pi("permission"), NOW).unwrap();
    assert_eq!(
        by_key(&f.reg, "devbox/pi/p").state,
        State::WaitingPermission
    );
    f.reg.ingest(HOST, pi("permission_done"), NOW).unwrap();
    assert_eq!(by_key(&f.reg, "devbox/pi/p").pending, None);
}

#[test]
fn subagent_events_go_to_the_subagent_record() {
    let f = fx();
    feed(
        &f.reg,
        &[
            ("UserPromptSubmit", json!({"prompt": "go"})),
            (
                "SubagentStart",
                json!({"agent_id": "a1", "agent_type": "general-purpose"}),
            ),
            (
                "PreToolUse",
                json!({"agent_id": "a1", "agent_type": "general-purpose", "tool_name": "Grep", "tool_input": {"pattern": "fn main"}}),
            ),
        ],
    );
    let parent = top(&f.reg);
    let sub = by_key(&f.reg, "devbox/claude/s1/a1");
    assert_eq!(sub.parent.as_deref(), Some(parent.id.as_str()));
    assert_eq!(sub.session_id, "s1");
    assert_eq!(sub.title, "general-purpose");
    assert_eq!(sub.state, State::Running);
    assert_eq!(sub.tool.as_ref().unwrap().input.as_deref(), Some("fn main"));
    assert_eq!(sub.counts.events, 2);
    assert_eq!(parent.counts.events, 1);
    assert_eq!(parent.counts.subagents, 1);
    assert_eq!(parent.last_at, T0 + 2);
    assert_eq!(parent.tool, None);

    feed(
        &f.reg,
        &[(
            "SubagentStop",
            json!({"agent_id": "a1", "agent_type": "general-purpose", "last_assistant_message": "3 hits"}),
        )],
    );
    let sub = by_key(&f.reg, "devbox/claude/s1/a1");
    assert_eq!(sub.end_reason, Some(EndReason::SessionEnd));
    assert_eq!(sub.last_message.as_deref(), Some("3 hits"));
    assert!(top(&f.reg).ended_at.is_none());

    // A parent's end ends its live subagents, and only those.
    feed(
        &f.reg,
        &[
            (
                "SubagentStart",
                json!({"agent_id": "a2", "agent_type": "x"}),
            ),
            ("SessionEnd", json!({"reason": "other"})),
        ],
    );
    let a1 = by_key(&f.reg, "devbox/claude/s1/a1");
    let a2 = by_key(&f.reg, "devbox/claude/s1/a2");
    assert_eq!(a1.end_reason, Some(EndReason::SessionEnd));
    assert_eq!(a2.end_reason, Some(EndReason::ParentEnded));
    assert_eq!(a2.ended_at, top(&f.reg).ended_at);
    assert_eq!(top(&f.reg).end_reason, Some(EndReason::SessionEnd));
}

#[test]
fn a_start_from_the_same_process_replaces_the_session() {
    let f = fx();
    let start = |sid: &str, pid: u64, pid_start: u64, host: &str| {
        let mut ev = claude(sid, T0, "SessionStart", json!({"source": "clear"}));
        ev["pid"] = json!(pid);
        ev["pidStart"] = json!(pid_start);
        f.reg.ingest(host, ev, NOW).unwrap();
    };
    start("s1", PID, START, HOST);
    feed(
        &f.reg,
        &[(
            "SubagentStart",
            json!({"agent_id": "a1", "agent_type": "x"}),
        )],
    );
    start("other-host", PID, START, "laptop");
    start("other-start", PID, START + 1, HOST);
    start("s2", PID, START, HOST);
    let s1 = top(&f.reg);
    assert_eq!(s1.end_reason, Some(EndReason::Replaced));
    assert_eq!(
        by_key(&f.reg, "devbox/claude/s1/a1").end_reason,
        Some(EndReason::ParentEnded)
    );
    for key in [
        "devbox/claude/s2",
        "laptop/claude/other-host",
        "devbox/claude/other-start",
    ] {
        assert!(by_key(&f.reg, key).ended_at.is_none(), "{key}");
    }
}

#[test]
fn sweep_checks_processes_of_its_own_host_only() {
    let f = fx();
    let at = |sid: &str, pid: u64, host: &str| {
        let mut ev = claude(sid, T0, "SessionStart", json!({}));
        ev["pid"] = json!(pid);
        f.reg.ingest(host, ev, NOW).unwrap();
    };
    f.process(100, START);
    f.process(101, START + 5);
    at("alive", 100, HOST);
    at("restarted", 101, HOST);
    at("gone", 102, HOST);
    at("elsewhere", 102, "laptop");
    let mut no_pid = claude("no-pid", T0, "SessionStart", json!({}));
    no_pid.as_object_mut().unwrap().remove("pid");
    f.reg.ingest(HOST, no_pid, NOW).unwrap();
    f.reg.sweep(T0 + 1);
    let reason = |key: &str| by_key(&f.reg, key).end_reason;
    assert_eq!(reason("devbox/claude/alive"), None);
    assert_eq!(
        reason("devbox/claude/restarted"),
        Some(EndReason::ProcessGone)
    );
    assert_eq!(reason("devbox/claude/gone"), Some(EndReason::ProcessGone));
    assert_eq!(reason("laptop/claude/elsewhere"), None);
    assert_eq!(reason("devbox/claude/no-pid"), None);
    assert_eq!(by_key(&f.reg, "devbox/claude/gone").ended_at, Some(T0 + 1));
}

#[test]
fn stat_start_time_survives_odd_command_names() {
    let rest: Vec<String> = (3..=21).map(|n| n.to_string()).collect();
    let rest = rest.join(" ");
    let rows = [
        (format!("1 (bash) {rest} 777 23"), Some(777)),
        (format!("1 (a) (b) ) {rest} 778 23"), Some(778)),
        (format!("1 (x y) {rest}"), None),
        ("garbage".to_owned(), None),
        (format!("1 (a) {rest} notanumber"), None),
    ];
    for (stat, want) in rows {
        assert_eq!(start_time(&stat), want, "{stat}");
    }
}

#[test]
fn an_ended_record_comes_back_with_any_event_but_end() {
    let f = fx();
    feed(&f.reg, &[("SessionStart", json!({}))]);
    f.reg.sweep(T0 + 1);
    assert_eq!(top(&f.reg).end_reason, Some(EndReason::ProcessGone));
    feed(&f.reg, &[("SessionEnd", json!({}))]);
    let s = top(&f.reg);
    assert_eq!(
        (s.end_reason, s.ended_at),
        (Some(EndReason::ProcessGone), Some(T0 + 1))
    );
    feed(&f.reg, &[("UserPromptSubmit", json!({"prompt": "again"}))]);
    let s = top(&f.reg);
    assert_eq!((s.ended_at, s.end_reason), (None, None));
    assert_eq!(s.state, State::Running);
}

#[test]
fn silence_ends_and_the_ended_are_dropped_after_a_while() {
    let f = fx();
    let silent = OBS_SILENT_END.as_millis() as u64;
    let keep = OBS_ENDED_KEEP.as_millis() as u64;
    let mut ev = claude("s1", T0, "SessionStart", json!({}));
    ev.as_object_mut().unwrap().remove("pid");
    f.reg.ingest(HOST, ev, NOW).unwrap();
    f.reg.drain();
    f.reg.sweep(T0 + silent - 1);
    assert_eq!(top(&f.reg).ended_at, None);
    f.reg.sweep(T0 + silent);
    assert_eq!(top(&f.reg).end_reason, Some(EndReason::Silent));
    f.reg.sweep(T0 + silent + keep - 1);
    assert_eq!(f.reg.list().len(), 1);
    f.reg.drain();
    f.reg.sweep(T0 + silent + keep);
    assert!(f.reg.list().is_empty());
    let changes = f.reg.drain();
    assert!(
        matches!(&changes[..], [Change::Gone { id, key }] if *id == id_of(key) && key == "devbox/claude/s1")
    );
    // A clock far ahead or behind does not overflow.
    for at in [0, u64::MAX] {
        let mut ev = claude("skew", at, "SessionStart", json!({}));
        ev.as_object_mut().unwrap().remove("pid");
        f.reg.ingest(HOST, ev, NOW).unwrap();
        f.reg.sweep(T0);
        f.reg.sweep(u64::MAX);
    }
}

#[test]
fn eviction_takes_the_oldest_ended_then_the_quietest_live() {
    let f = fx();
    for i in 0..OBS_SESSIONS_MAX as u64 {
        let mut ev = claude(&format!("s{i}"), T0 + 10 + i, "SessionStart", json!({}));
        ev.as_object_mut().unwrap().remove("pid");
        f.reg.ingest(HOST, ev, NOW).unwrap();
    }
    for (sid, at) in [("s20", T0 + 900), ("s10", T0 + 901)] {
        f.reg
            .ingest(HOST, claude(sid, at, "SessionEnd", json!({})), NOW)
            .unwrap();
    }
    f.reg.drain();
    let mut gone = Vec::new();
    for i in 0..3 {
        let mut ev = claude(&format!("new{i}"), T0 + 1000, "SessionStart", json!({}));
        ev.as_object_mut().unwrap().remove("pid");
        f.reg.ingest(HOST, ev, NOW).unwrap();
        assert_eq!(f.reg.list().len(), OBS_SESSIONS_MAX);
        for c in f.reg.drain() {
            if let Change::Gone { key, .. } = c {
                gone.push(key);
            }
        }
    }
    assert_eq!(
        gone,
        ["devbox/claude/s20", "devbox/claude/s10", "devbox/claude/s0"]
    );
}

#[test]
fn a_host_that_floods_pushes_out_its_own_records() {
    let f = fx();
    let start = |host: &str, sid: &str, at: u64| {
        let ev =
            json!({"harness": "pi", "at": at, "payload": {"session_id": sid, "kind": "start"}});
        f.reg.ingest(host, ev, NOW).unwrap();
    };
    // The quietest records of all are the other hosts'.
    for i in 0..10 {
        start("quiet", &format!("q{i}"), T0 + i);
    }
    start("alone", "a", T0);
    for i in 0..2000 {
        start("loud", &format!("l{i}"), T0 + 100 + i);
    }
    let all = f.reg.list();
    let of = |host: &str| all.iter().filter(|s| s.host == host).count();
    assert_eq!(
        (of("quiet"), of("alone"), of("loud")),
        (10, 1, OBS_SESSIONS_MAX)
    );
    assert!(all.iter().any(|s| s.session_id == "l1999"));
}

#[test]
fn a_record_nobody_was_told_of_goes_without_a_word() {
    let f = fx();
    let start = |sid: &str, at: u64| {
        let ev =
            json!({"harness": "pi", "at": at, "payload": {"session_id": sid, "kind": "start"}});
        f.reg.ingest(HOST, ev, NOW).unwrap();
    };
    start("told", T0);
    assert_eq!(f.reg.drain().len(), 1);
    for i in 0..2000 {
        start(&format!("flood-{i}"), T0 + 1 + i);
    }
    let changes = f.reg.drain();
    let gone: Vec<&str> = changes
        .iter()
        .filter_map(|c| match c {
            Change::Gone { key, .. } => Some(key.as_str()),
            Change::Upsert(_) => None,
        })
        .collect();
    assert_eq!(gone, ["devbox/pi/told"]);
    assert_eq!(changes.len(), 1 + OBS_SESSIONS_MAX);
    // A listing tells of every record it holds.
    f.reg.list();
    start("one-more", T0 + 5000);
    assert_eq!(f.reg.drain().len(), 2);
}

#[test]
fn a_record_dropped_twice_between_drains_is_still_reported_gone() {
    let f = fx();
    let start = |sid: &str, at: u64| {
        let ev =
            json!({"harness": "pi", "at": at, "payload": {"session_id": sid, "kind": "start"}});
        f.reg.ingest(HOST, ev, NOW).unwrap();
    };
    start("x", T0);
    for i in 1..OBS_SESSIONS_MAX as u64 {
        start(&format!("s{i}"), T0 + i);
    }
    f.reg.drain();
    // Dropped for `y`, back as the quietest record again, and dropped for `z`.
    start("y", T0 + 1000);
    start("x", T0);
    start("z", T0 + 1001);
    let gone: Vec<String> = f
        .reg
        .drain()
        .into_iter()
        .filter_map(|c| match c {
            Change::Gone { key, .. } => Some(key),
            Change::Upsert(_) => None,
        })
        .collect();
    assert_eq!(gone, ["devbox/pi/s1", "devbox/pi/x"]);
}

#[test]
fn a_session_and_a_subagent_never_share_a_record() {
    let f = fx();
    let ev = |payload: Value| json!({"harness": "pi", "at": T0, "payload": payload});
    f.reg
        .ingest(HOST, ev(json!({"session_id": "s:a", "kind": "start"})), NOW)
        .unwrap();
    f.reg
        .ingest(
            HOST,
            ev(json!({"session_id": "s", "agent_id": "a", "kind": "end"})),
            NOW,
        )
        .unwrap();
    f.reg
        .ingest(
            HOST,
            ev(json!({"session_id": "s", "agent_id": "a:b", "kind": "start"})),
            NOW,
        )
        .unwrap();
    f.reg
        .ingest(
            HOST,
            ev(json!({"session_id": "s:a", "agent_id": "b", "kind": "start"})),
            NOW,
        )
        .unwrap();
    let mut keys: Vec<String> = f.reg.list().into_iter().map(|s| s.key).collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "devbox/pi/s/a",
            "devbox/pi/s/a:b",
            "devbox/pi/s:a",
            "devbox/pi/s:a/b"
        ]
    );
    assert_eq!(by_key(&f.reg, "devbox/pi/s:a").ended_at, None);
}

#[test]
fn a_flood_of_sessions_stays_at_the_cap() {
    let f = fx();
    for i in 0..2000u64 {
        let ev = json!({"harness": "pi", "at": T0 + i, "payload": {"session_id": format!("flood-{i}"), "kind": "prompt", "text": "x"}});
        f.reg.ingest(HOST, ev, NOW).unwrap();
    }
    let all = f.reg.list();
    assert_eq!(all.len(), OBS_SESSIONS_MAX);
    assert_eq!(all[0].session_id, "flood-1999");
    assert_eq!(all.last().unwrap().session_id, "flood-1744");
}

#[test]
fn drain_reports_each_record_once_in_its_latest_state() {
    let f = fx();
    feed(
        &f.reg,
        &[
            ("SessionStart", json!({})),
            ("UserPromptSubmit", json!({"prompt": "go"})),
            (
                "SubagentStart",
                json!({"agent_id": "a1", "agent_type": "x"}),
            ),
        ],
    );
    let changes = f.reg.drain();
    let ups: Vec<(String, u64)> = changes
        .iter()
        .map(|c| match c {
            Change::Upsert(s) => (s.key.clone(), s.counts.events),
            Change::Gone { .. } => panic!("nothing was dropped"),
        })
        .collect();
    assert_eq!(
        ups,
        [
            ("devbox/claude/s1".to_owned(), 2),
            ("devbox/claude/s1/a1".to_owned(), 1)
        ]
    );
    assert!(f.reg.drain().is_empty());
}

#[test]
fn list_puts_live_first_then_newest() {
    let f = fx();
    for (sid, at) in [("a", T0 + 1), ("b", T0 + 3), ("c", T0 + 2)] {
        let mut ev = claude(sid, at, "SessionStart", json!({}));
        ev.as_object_mut().unwrap().remove("pid");
        f.reg.ingest(HOST, ev, NOW).unwrap();
    }
    f.reg
        .ingest(HOST, claude("b", T0 + 4, "SessionEnd", json!({})), NOW)
        .unwrap();
    let order: Vec<String> = f.reg.list().into_iter().map(|s| s.session_id).collect();
    assert_eq!(order, ["c", "a", "b"]);
    let b = f.reg.list().pop().unwrap();
    assert_eq!(f.reg.get(&b.id), Some(b));
    assert_eq!(f.reg.get("o_0000000000000000"), None);
}

#[test]
fn neutral_events_from_an_unknown_harness() {
    let f = fx();
    let ev = |kind: &str, extra: Value| {
        let mut payload = json!({"session_id": "pi.1", "kind": kind, "cwd": "/home/alice/proj/y"});
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        json!({"harness": "pi", "at": T0, "wbSession": "n_k3m9x2", "payload": payload})
    };
    f.reg
        .ingest(HOST, ev("start", json!({"model": "m1"})), NOW)
        .unwrap();
    f.reg
        .ingest(
            HOST,
            ev(
                "tool_start",
                json!({"tool": {"name": "read", "input": {"path": "a"}}}),
            ),
            T0,
        )
        .unwrap();
    let s = by_key(&f.reg, "devbox/pi/pi.1");
    assert_eq!(s.harness, "pi");
    assert_eq!(s.project, "y");
    assert_eq!(s.wb_session.as_deref(), Some("n_k3m9x2"));
    assert_eq!(s.model.as_deref(), Some("m1"));
    assert_eq!(s.title, "pi · y");
    assert_eq!(s.state, State::Running);
    f.reg
        .ingest(HOST, ev("turn_end", json!({"text": "bye"})), NOW)
        .unwrap();
    f.reg
        .ingest(HOST, ev("end", json!({"reason": "quit"})), NOW)
        .unwrap();
    let s = by_key(&f.reg, "devbox/pi/pi.1");
    assert_eq!(s.last_message.as_deref(), Some("bye"));
    assert_eq!(s.state, State::Exited);
}

#[test]
fn envelope_fields_are_untrusted() {
    let f = fx();
    let mut ev = claude("s1", T0, "SessionStart", json!({"host": "evil"}));
    ev["host"] = json!("evil");
    ev["wbSession"] = json!("../etc");
    ev["pid"] = json!(-1);
    ev["at"] = json!("soon");
    ev["projectRoot"] = json!(7);
    f.reg.ingest(HOST, ev, T0 + 5).unwrap();
    let s = top(&f.reg);
    assert_eq!(s.host, HOST);
    assert_eq!((s.wb_session, s.pid, s.project_root), (None, None, None));
    assert_eq!(s.started_at, T0 + 5);
    assert_eq!(s.project, "src");
}

#[test]
fn an_event_is_never_dated_after_the_servers_clock() {
    let f = fx();
    let ahead = claude("ahead", u64::MAX, "SessionStart", json!({}));
    f.reg.ingest(HOST, ahead, T0 + 5).unwrap();
    let behind = claude("behind", T0 - 9, "SessionStart", json!({"agent_id": "a"}));
    f.reg.ingest(HOST, behind, T0 + 5).unwrap();
    let at = |sid: &str| {
        let all = f.reg.list();
        all.iter().find(|s| s.session_id == sid).unwrap().last_at
    };
    assert_eq!((at("ahead"), at("behind")), (T0 + 5, T0 - 9));
}

#[test]
fn refusals_leave_the_registry_unchanged() {
    let f = fx();
    let rows = [
        (json!([]), "bad event"),
        (json!("x"), "bad event"),
        (json!({"payload": {"session_id": "s"}}), "bad harness"),
        (
            json!({"harness": "Claude", "payload": {"session_id": "s"}}),
            "bad harness",
        ),
        (
            json!({"harness": "x".repeat(33), "payload": {"session_id": "s"}}),
            "bad harness",
        ),
        (json!({"harness": "claude"}), "bad event"),
        (json!({"harness": "claude", "payload": []}), "bad event"),
        (
            json!({"harness": "claude", "payload": {"session_id": "a b"}}),
            "bad session_id",
        ),
        (
            json!({"harness": "pi", "payload": {"session_id": "s", "kind": "nap"}}),
            "unknown kind",
        ),
        (
            json!({"harness": "claude", "payload": {"session_id": "s", "agent_id": ""}}),
            "bad agent_id",
        ),
    ];
    for (ev, want) in &rows {
        assert_eq!(
            f.reg.ingest(HOST, ev.clone(), NOW),
            Err((*want).into()),
            "{ev}"
        );
    }
    assert!(f.reg.list().is_empty());
    assert!(f.reg.drain().is_empty());
    f.reg.save().unwrap();
    assert!(!f.dir.path().join(FILE).exists());

    feed(&f.reg, &[("SessionStart", json!({}))]);
    f.reg.save().unwrap();
    f.reg.drain();
    let before = f.reg.list();
    let refused = claude("s1", T0 + 9, "UserPromptSubmit", json!({"agent_id": "a/b"}));
    assert!(f.reg.ingest(HOST, refused, NOW).is_err());
    for (ev, _) in rows {
        assert!(f.reg.ingest(HOST, ev, NOW).is_err());
    }
    assert_eq!(f.reg.list(), before);
    assert!(f.reg.drain().is_empty());
    let saved = fs::metadata(f.dir.path().join(FILE)).unwrap().ino();
    f.reg.save().unwrap();
    assert_eq!(fs::metadata(f.dir.path().join(FILE)).unwrap().ino(), saved);
}

#[test]
fn save_and_load_round_trip() {
    let f = fx();
    f.process(PID, START);
    feed(
        &f.reg,
        &[
            ("UserPromptSubmit", json!({"prompt": "Ship it"})),
            ("PermissionRequest", edit()),
            ("PostToolUse", edit()),
            (
                "SubagentStart",
                json!({"agent_id": "a1", "agent_type": "x"}),
            ),
        ],
    );
    f.reg
        .ingest(HOST, claude("s2", T0, "Stop", json!({})), NOW)
        .unwrap();
    f.reg.save().unwrap();
    let path = f.dir.path().join(FILE);
    let meta = fs::metadata(&path).unwrap();
    assert_eq!(meta.mode() & 0o777, 0o600);
    let file: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(file["v"], 1);
    assert_eq!(file["sessions"].as_array().unwrap().len(), 3);

    // Nothing changed: no write.
    f.reg.save().unwrap();
    assert_eq!(fs::metadata(&path).unwrap().ino(), meta.ino());

    let again = f.reload(T0 + 10);
    assert_eq!(again.list(), f.reg.list());
    assert!(again.drain().is_empty());
    // The facts came back too: the turn, the title and the process start time.
    assert_eq!(top(&again).state, State::Running);
    again
        .ingest(
            HOST,
            claude(
                "s1",
                T0 + 11,
                "UserPromptSubmit",
                json!({"prompt": "other"}),
            ),
            T0,
        )
        .unwrap();
    assert_eq!(top(&again).title, "Ship it");
    f.process(PID, START + 1);
    again.sweep(T0 + 12);
    assert_eq!(top(&again).end_reason, Some(EndReason::ProcessGone));
}

#[test]
fn a_failed_save_is_retried() {
    let f = fx();
    feed(&f.reg, &[("SessionStart", json!({}))]);
    fs::create_dir(f.dir.path().join(FILE)).unwrap();
    assert!(f.reg.save().is_err());
    fs::remove_dir(f.dir.path().join(FILE)).unwrap();
    f.reg.save().unwrap();
    assert!(f.dir.path().join(FILE).is_file());
}

#[test]
fn an_unusable_file_is_quarantined() {
    let rows = [
        ("not json", "{".to_owned()),
        ("another version", r#"{"v":2,"sessions":[]}"#.to_owned()),
        (
            "a bad record",
            r#"{"v":1,"sessions":[{"id":1}]}"#.to_owned(),
        ),
        ("a bad state", {
            let f = fx();
            feed(&f.reg, &[("SessionStart", json!({}))]);
            f.reg.save().unwrap();
            fs::read_to_string(f.dir.path().join(FILE))
                .unwrap()
                .replace("\"idle\"", "\"sleepy\"")
        }),
    ];
    for (name, body) in rows {
        let f = fx();
        fs::write(f.dir.path().join(FILE), body.as_bytes()).unwrap();
        let reg = f.reload(T0 + 7);
        assert!(reg.list().is_empty(), "{name}");
        assert!(!f.dir.path().join(FILE).exists(), "{name}");
        let bad = f.dir.path().join(format!("{FILE}.bad-{}", T0 + 7));
        assert_eq!(fs::read_to_string(bad).unwrap(), body, "{name}");
    }
}

#[test]
fn load_sweeps_and_caps() {
    let f = fx();
    feed(&f.reg, &[("SessionStart", json!({}))]);
    f.reg.save().unwrap();
    // The process is not in the fake /proc, so the sweep after loading ends it.
    let again = f.reload(T0 + 1);
    assert_eq!(top(&again).end_reason, Some(EndReason::ProcessGone));

    let f = fx();
    for i in 0..OBS_SESSIONS_MAX as u64 + 5 {
        let mut ev = claude(&format!("s{i}"), T0 + i, "SessionStart", json!({}));
        ev.as_object_mut().unwrap().remove("pid");
        f.reg.ingest(HOST, ev, NOW).unwrap();
    }
    f.reg.save().unwrap();
    let path = f.dir.path().join(FILE);
    let mut file: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let mut extra = file["sessions"][0].clone();
    for i in 0..10 {
        extra["key"] = json!(format!("devbox/claude/extra{i}"));
        file["sessions"].as_array_mut().unwrap().push(extra.clone());
    }
    fs::write(&path, file.to_string()).unwrap();
    assert_eq!(f.reload(T0).list().len(), OBS_SESSIONS_MAX);
}
