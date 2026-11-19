//! The fold over an ACP journal. `Facts::apply` is the only fold, used both live and
//! at startup, so the folded journal and the live facts agree by construction.

use serde_json::{Value, json};
use wb_proto::hub::{Activity, Last, LastError, Pending, PendingKind};
use wb_proto::journal::{EventBody, JournalEvent, ResolvedBy, SetupErrorCode, TurnErrorCode};
use wb_proto::policy::Policy;

use super::config::{valid_options, within_limits};
use crate::snapshot::PENDING_TITLE_CHARS;

/// What the journal says about a session (DESIGN §3.4.5 "Facts", 10 §7.8 "Fold").
#[derive(Clone, Debug, PartialEq)]
pub struct Facts {
    /// Seq of the last event applied, unknown kinds included.
    pub head_seq: u64,
    pub activity: Activity,
    pub agent_session_id: Option<String>,
    /// Unresolved agent requests in ascending `req` order.
    pub pending: Vec<Pending>,
    pub last: Option<Last>,
    pub title: Option<String>,
    pub mode_id: Option<String>,
    pub modes: Option<Value>,
    pub config_options: Option<Value>,
    pub task: Option<String>,
    pub policy: Option<Policy>,
    pub available_commands: Option<Value>,
    pub plan: Option<Value>,
    pub usage: Option<Value>,
    /// A `spawn` has no later `exit`.
    pub running: bool,
    /// A `setup_error{revive_failed}` came after the last `session` (H-12).
    pub revive_failed: bool,
}

impl Default for Facts {
    fn default() -> Self {
        Facts {
            head_seq: 0,
            activity: Activity::None,
            agent_session_id: None,
            pending: Vec::new(),
            last: None,
            title: None,
            mode_id: None,
            modes: None,
            config_options: None,
            task: None,
            policy: None,
            available_commands: None,
            plan: None,
            usage: None,
            running: false,
            revive_failed: false,
        }
    }
}

impl Facts {
    /// Folds one event into the facts. Pure: no I/O, no clock. Returns whether a
    /// field other than `head_seq` may have changed.
    pub fn apply(&mut self, ev: &JournalEvent) -> bool {
        self.head_seq = ev.seq;
        match &ev.body {
            EventBody::Spawn { .. } => {
                self.activity = Activity::Setup;
                self.running = true;
            }
            EventBody::Session {
                session_id,
                modes,
                config_options,
                ..
            } => {
                self.activity = Activity::None;
                self.agent_session_id = Some(session_id.clone());
                self.mode_id = modes
                    .as_ref()
                    .and_then(|m| m.get("currentModeId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                self.modes = modes.clone();
                match config_options {
                    None => self.config_options = None,
                    Some(options) => self.set_config_options(options),
                }
                self.revive_failed = false;
            }
            EventBody::SetupError { code, message, .. } => {
                self.activity = Activity::None;
                self.last = Some(error_last(ev, wire(code), message));
                if *code == SetupErrorCode::ReviveFailed {
                    self.revive_failed = true;
                }
            }
            EventBody::Authenticate { .. } => self.activity = Activity::Setup,
            EventBody::Prompt { .. } => self.activity = Activity::Turn,
            EventBody::Update { update, .. } => return self.apply_update(update),
            EventBody::TurnEnd { stop_reason } => {
                self.activity = Activity::None;
                self.last = Some(Last {
                    seq: ev.seq,
                    ts: ev.ts,
                    outcome: stop_reason.clone(),
                    error: None,
                });
            }
            EventBody::TurnError { code, message, .. } => {
                self.activity = Activity::None;
                self.last = Some(error_last(ev, wire(code), message));
            }
            EventBody::Permission { tool_call, .. } => {
                self.pending.push(Pending {
                    req: ev.seq,
                    kind: PendingKind::Permission,
                    title: cut(tool_call.get("title")),
                    ts: ev.ts,
                });
            }
            EventBody::Elicitation { request } => {
                self.pending.push(Pending {
                    req: ev.seq,
                    kind: PendingKind::Elicitation,
                    title: cut(request.get("message")),
                    ts: ev.ts,
                });
            }
            EventBody::PermissionResolved { req, .. }
            | EventBody::ElicitationResolved { req, .. } => {
                self.pending.retain(|p| p.req != *req);
            }
            EventBody::Mode { mode_id } => self.set_mode(mode_id),
            EventBody::Config { config_options } => self.set_config_options(config_options),
            EventBody::Task { task } => self.task.clone_from(task),
            EventBody::Policy { policy } => {
                self.policy =
                    (policy.validate().is_ok() && !policy.rules.is_empty()).then(|| policy.clone());
            }
            EventBody::Exit { .. } => {
                self.activity = Activity::None;
                self.running = false;
            }
            EventBody::ElicitationComplete { .. }
            | EventBody::PermissionAuto { .. }
            | EventBody::Notice { .. }
            | EventBody::Unknown => return false,
        }
        true
    }

    /// Whether `acp.revive` may run (DESIGN §3.4.6, H-12): the session has an agent
    /// session id, the last `initialize` result (`meta.init`) advertised `loadSession`
    /// or `sessionCapabilities.resume`, and no revive failed since the last `session`.
    pub fn revivable(&self, init: Option<&Value>) -> bool {
        let caps = init.and_then(|i| i.get("agentCapabilities"));
        let load = caps.and_then(|c| c.get("loadSession")) == Some(&Value::Bool(true));
        let resume = caps
            .and_then(|c| c.get("sessionCapabilities"))
            .and_then(|s| s.get("resume"))
            .is_some_and(|r| !r.is_null());
        self.agent_session_id.is_some() && (load || resume) && !self.revive_failed
    }

    /// Steps 1 and 2 of the death invariant (DESIGN §3.4.4, 10 §7.10) for an agent that
    /// is gone: a `*_resolved{by:"hub"}` per pending request in ascending `req`, then a
    /// `turn_error` or `setup_error` if a turn or setup was running. The code is
    /// `interrupted` for a kill, a hub stop or a hub restart, else `agent_exited`. The
    /// caller appends a `notice` and the `exit` after these.
    pub fn death_lines(&self, interrupted: bool, message: &str) -> Vec<EventBody> {
        let mut lines: Vec<EventBody> = self
            .pending
            .iter()
            .map(|p| match p.kind {
                PendingKind::Permission => EventBody::PermissionResolved {
                    req: p.req,
                    outcome: json!({"outcome": "cancelled"}),
                    by: ResolvedBy::Hub,
                },
                PendingKind::Elicitation | PendingKind::Unknown => EventBody::ElicitationResolved {
                    req: p.req,
                    response: json!({"action": "cancel"}),
                    by: ResolvedBy::Hub,
                },
            })
            .collect();
        let message = message.to_owned();
        match self.activity {
            Activity::Turn => lines.push(EventBody::TurnError {
                code: if interrupted {
                    TurnErrorCode::Interrupted
                } else {
                    TurnErrorCode::AgentExited
                },
                message,
                rpc: None,
            }),
            Activity::Setup => lines.push(EventBody::SetupError {
                code: if interrupted {
                    SetupErrorCode::Interrupted
                } else {
                    SetupErrorCode::AgentExited
                },
                message,
                rpc: None,
            }),
            Activity::None | Activity::Unknown => {}
        }
        lines
    }

    fn set_config_options(&mut self, options: &Value) {
        if valid_options(options) {
            self.config_options = Some(options.clone());
        } else if !within_limits(options) {
            // Old journals can contain offerings too large to publish safely.
            self.config_options = None;
        }
    }

    fn apply_update(&mut self, update: &Value) -> bool {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("session_info_update") => match update.get("title") {
                Some(Value::String(t)) => self.title = Some(t.clone()),
                Some(Value::Null) => self.title = None,
                _ => {}
            },
            Some("current_mode_update") => {
                if let Some(id) = update.get("currentModeId").and_then(Value::as_str) {
                    self.set_mode(id);
                }
            }
            Some("config_option_update") => {
                if let Some(options) = update.get("configOptions") {
                    self.set_config_options(options);
                }
            }
            Some("plan") => self.plan = Some(without_tag(update)),
            Some("available_commands_update") => {
                self.available_commands = update.get("availableCommands").cloned();
            }
            Some("usage_update") => self.usage = Some(without_tag(update)),
            _ => return false,
        }
        true
    }

    /// Sets the mode id, and the current mode id inside `modes`, which
    /// `AcpSessionInfo.modes` carries.
    fn set_mode(&mut self, id: &str) {
        self.mode_id = Some(id.to_owned());
        if let Some(Value::Object(m)) = &mut self.modes {
            m.insert("currentModeId".into(), Value::String(id.to_owned()));
        }
    }
}

fn error_last(ev: &JournalEvent, code: String, message: &str) -> Last {
    Last {
        seq: ev.seq,
        ts: ev.ts,
        outcome: "error".into(),
        error: Some(LastError {
            code,
            message: message.to_owned(),
        }),
    }
}

/// The wire string of an error code enum.
fn wire<T: serde::Serialize>(code: &T) -> String {
    match serde_json::to_value(code) {
        Ok(Value::String(s)) => s,
        _ => "unknown".into(),
    }
}

/// A title cut to `PENDING_TITLE_CHARS` characters; empty if absent or not a string.
fn cut(v: Option<&Value>) -> String {
    v.and_then(Value::as_str)
        .map(|s| s.chars().take(PENDING_TITLE_CHARS).collect())
        .unwrap_or_default()
}

/// The update without its `sessionUpdate` tag: `{entries}` for a plan, `{used, size,
/// cost}` for usage (00 §2.6).
fn without_tag(update: &Value) -> Value {
    let mut v = update.clone();
    if let Value::Object(m) = &mut v {
        m.remove("sessionUpdate");
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use wb_proto::hub::ExitReason;
    use wb_proto::journal::{NoticeLevel, SessionVia, SpawnVia};

    fn ev(seq: u64, body: EventBody) -> JournalEvent {
        JournalEvent {
            seq,
            ts: 1000 + seq,
            body,
        }
    }

    fn fold(bodies: Vec<EventBody>) -> Facts {
        let mut f = Facts::default();
        for (i, b) in bodies.into_iter().enumerate() {
            f.apply(&ev(i as u64 + 1, b));
        }
        f
    }

    #[test]
    fn invalid_policy_events_clear_policy_until_a_later_valid_event() {
        let good: Policy = serde_json::from_value(json!({"rules":[{"action":"allow"}]})).unwrap();
        let oversized: Policy = serde_json::from_value(json!({"rules":[
            {"action":"allow", "roots":vec![format!("/{}", "r".repeat(4095));64]}
        ]}))
        .unwrap();
        let malformed: Policy = serde_json::from_value(json!({"rules":[
            {"action":"allow", "command":{"matches":["["]}}
        ]}))
        .unwrap();
        let too_big: Policy = serde_json::from_value(json!({"rules":[
            {"action":"allow", "command":{"matches":[r"\w+\s+\w+"]}}
        ]}))
        .unwrap();
        assert!(serde_json::to_vec(&oversized).unwrap().len() > wb_proto::limits::POLICY_MAX);
        for invalid in [oversized, malformed, too_big] {
            let bad = EventBody::Policy { policy: invalid };
            assert_eq!(fold(vec![bad.clone()]).policy, None);
            let mut facts = fold(vec![EventBody::Policy {
                policy: good.clone(),
            }]);
            facts.apply(&ev(2, bad));
            assert_eq!(facts.policy, None);
            assert_eq!(facts.head_seq, 2);
            facts.apply(&ev(
                3,
                EventBody::Policy {
                    policy: good.clone(),
                },
            ));
            assert_eq!(facts.policy.as_ref(), Some(&good));
            facts.apply(&ev(
                4,
                EventBody::Policy {
                    policy: Policy::default(),
                },
            ));
            assert_eq!(facts.policy, None);
        }
    }

    fn spawn() -> EventBody {
        EventBody::Spawn {
            pid: 42,
            via: SpawnVia::New,
        }
    }

    fn session(id: &str, modes: Option<Value>) -> EventBody {
        EventBody::Session {
            via: SessionVia::New,
            session_id: id.into(),
            modes,
            config_options: None,
        }
    }

    fn update(v: Value) -> EventBody {
        EventBody::Update {
            update: v,
            session_id: None,
        }
    }

    fn prompt() -> EventBody {
        EventBody::Prompt {
            prompt: vec![json!({"type": "text", "text": "hi"})],
        }
    }

    fn permission(title: &str) -> EventBody {
        EventBody::Permission {
            tool_call: json!({"toolCallId": "t1", "title": title}),
            options: vec![json!({"optionId": "allow", "kind": "allow_once"})],
        }
    }

    fn elicitation(message: &str) -> EventBody {
        EventBody::Elicitation {
            request: json!({"mode": "form", "message": message}),
        }
    }

    fn exit() -> EventBody {
        EventBody::Exit {
            code: Some(0),
            signal: None,
            reason: ExitReason::Exited,
        }
    }

    #[test]
    fn default_is_empty() {
        let f = Facts::default();
        assert_eq!(f.head_seq, 0);
        assert_eq!(f.activity, Activity::None);
        assert!(f.pending.is_empty() && f.last.is_none() && !f.running && !f.revive_failed);
    }

    #[test]
    fn spawn_starts_setup_and_running() {
        let f = fold(vec![spawn()]);
        assert_eq!(
            (f.head_seq, f.activity, f.running),
            (1, Activity::Setup, true)
        );
    }

    #[test]
    fn session_sets_the_agent_session_and_modes() {
        let modes = json!({"currentModeId": "default", "availableModes": [{"id": "default"}, {"id": "plan"}]});
        let f = fold(vec![spawn(), session("s-1", Some(modes.clone()))]);
        assert_eq!(f.activity, Activity::None);
        assert_eq!(f.agent_session_id.as_deref(), Some("s-1"));
        assert_eq!(f.mode_id.as_deref(), Some("default"));
        assert_eq!(f.modes, Some(modes));
        assert!(f.running);
    }

    #[test]
    fn config_folds_initial_updates_results_and_absent_session_reset() {
        let initial = json!([{"id": "model", "name": "Model", "type": "select", "currentValue": "small",
                              "options": [{"value": "small", "name": "Small"}]}]);
        let changed = json!([{"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": true}]);
        let mut f = fold(vec![
            spawn(),
            EventBody::Session {
                via: SessionVia::New,
                session_id: "s".into(),
                modes: None,
                config_options: Some(initial.clone()),
            },
        ]);
        assert_eq!(f.config_options, Some(initial));
        f.apply(&ev(
            3,
            update(json!({"sessionUpdate": "config_option_update", "configOptions": changed})),
        ));
        assert_eq!(f.config_options, Some(changed));
        f.apply(&ev(
            4,
            EventBody::Config {
                config_options: json!([]),
            },
        ));
        assert_eq!(f.config_options, Some(json!([])));
        f.apply(&ev(5, session("s", None)));
        assert_eq!(f.config_options, None);
    }

    #[test]
    fn task_events_only_change_the_reference_and_head() {
        let before = fold(vec![spawn(), session("s", None), prompt()]);
        let mut f = before.clone();
        for (seq, value) in [(4, Some("issue 44")), (5, Some(" task ")), (6, None)] {
            let task = value.map(str::to_owned);
            f.apply(&ev(seq, EventBody::Task { task: task.clone() }));
            assert_eq!(
                f,
                Facts {
                    head_seq: seq,
                    task,
                    ..before.clone()
                }
            );
        }
    }

    #[test]
    fn malformed_old_journal_config_lists_preserve_the_preceding_good_state() {
        let initial = json!([{"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": true}]);
        let mut f = fold(vec![EventBody::Config {
            config_options: initial.clone(),
        }]);
        let mut seq = 1;
        for invalid in [
            json!(false),
            json!("options"),
            json!({}),
            json!([null]),
            json!([{"id": "model", "currentValue": "small"}]),
            json!([{"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": "true"}]),
            json!([{"id": "model", "name": "Model", "type": "select", "currentValue": "small",
                    "options": [{"group": "local", "name": "Local", "options": [null]}]}]),
            json!([initial[0].clone(), null]),
        ] {
            for mut body in [
                json!({"e": "session", "via": "resume", "sessionId": "old", "configOptions": invalid}),
                json!({"e": "config", "configOptions": invalid}),
                json!({"e": "update", "update": {
                    "sessionUpdate": "config_option_update", "configOptions": invalid
                }}),
            ] {
                seq += 1;
                body["seq"] = json!(seq);
                body["ts"] = json!(1000 + seq);
                let event: JournalEvent = serde_json::from_value(body).unwrap();
                f.apply(&event);
                assert_eq!(f.config_options.as_ref(), Some(&initial), "{event:?}");
                assert_eq!(f.head_seq, seq);
            }
        }
        assert_eq!(f.agent_session_id.as_deref(), Some("old"));
    }

    #[test]
    fn invalid_config_does_not_create_state_and_explicit_invalid_some_keeps_state() {
        let initial = json!([{"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": false}]);
        for invalid in [json!(null), json!([null])] {
            for body in [
                EventBody::Session {
                    via: SessionVia::Resume,
                    session_id: "s".into(),
                    modes: None,
                    config_options: Some(invalid.clone()),
                },
                EventBody::Config {
                    config_options: invalid.clone(),
                },
                update(json!({"sessionUpdate": "config_option_update", "configOptions": invalid})),
            ] {
                assert_eq!(fold(vec![body.clone()]).config_options, None);
                let mut f = fold(vec![EventBody::Config {
                    config_options: initial.clone(),
                }]);
                f.apply(&ev(2, body));
                assert_eq!(f.config_options.as_ref(), Some(&initial));
                assert_eq!(f.head_seq, 2);
            }
        }
    }

    #[test]
    fn empty_config_lists_legitimately_replace_preceding_state_in_every_event() {
        let initial = json!([{"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": true}]);
        for mut body in [
            json!({"e": "session", "via": "load", "sessionId": "s", "configOptions": []}),
            json!({"e": "config", "configOptions": []}),
            json!({"e": "update", "update": {
                "sessionUpdate": "config_option_update", "configOptions": []
            }}),
        ] {
            let mut f = fold(vec![EventBody::Config {
                config_options: initial.clone(),
            }]);
            body["seq"] = json!(2);
            body["ts"] = json!(1002);
            f.apply(&serde_json::from_value::<JournalEvent>(body).unwrap());
            assert_eq!(f.config_options, Some(json!([])));
            assert_eq!(f.head_seq, 2);
        }
    }

    #[test]
    fn oversized_journal_offerings_clear_previous_options_in_every_event_kind() {
        use wb_proto::limits::{ACP_CONFIG_OPTIONS_BYTES, ACP_CONFIG_OPTIONS_MAX};

        let option = json!({"id": "thinking", "name": "Thinking", "type": "boolean",
                            "currentValue": false});
        let initial = json!([option]);
        let mut large = option.clone();
        large["description"] = json!("x".repeat(ACP_CONFIG_OPTIONS_BYTES));
        for options in [
            json!([large]),
            json!(vec![option.clone(); ACP_CONFIG_OPTIONS_MAX + 1]),
        ] {
            for body in [
                EventBody::Session {
                    via: SessionVia::Resume,
                    session_id: "s".into(),
                    modes: None,
                    config_options: Some(options.clone()),
                },
                EventBody::Config {
                    config_options: options.clone(),
                },
                update(json!({"sessionUpdate": "config_option_update", "configOptions": options})),
            ] {
                let mut f = fold(vec![EventBody::Config {
                    config_options: initial.clone(),
                }]);
                f.apply(&ev(2, body));
                assert_eq!(f.config_options, None);
                f.apply(&ev(
                    3,
                    EventBody::Config {
                        config_options: initial.clone(),
                    },
                ));
                assert_eq!(f.config_options.as_ref(), Some(&initial));
            }
        }
    }

    #[test]
    fn setup_error_ends_setup_with_an_error_last() {
        let f = fold(vec![
            spawn(),
            EventBody::SetupError {
                code: SetupErrorCode::AuthRequired,
                message: "log in".into(),
                rpc: Some(json!({"code": -32000})),
            },
        ]);
        assert_eq!(f.activity, Activity::None);
        assert_eq!(
            f.last,
            Some(Last {
                seq: 2,
                ts: 1002,
                outcome: "error".into(),
                error: Some(LastError {
                    code: "auth_required".into(),
                    message: "log in".into()
                }),
            })
        );
        assert!(f.running, "auth_required keeps the process");
        assert!(!f.revive_failed);
    }

    #[test]
    fn authenticate_reenters_setup() {
        let f = fold(vec![
            spawn(),
            EventBody::SetupError {
                code: SetupErrorCode::AuthRequired,
                message: "log in".into(),
                rpc: None,
            },
            EventBody::Authenticate {
                method_id: "oauth".into(),
            },
        ]);
        assert_eq!(f.activity, Activity::Setup);
    }

    #[test]
    fn prompt_and_turn_end() {
        let mut f = fold(vec![spawn(), session("s", None), prompt()]);
        assert_eq!(f.activity, Activity::Turn);
        f.apply(&ev(
            4,
            EventBody::TurnEnd {
                stop_reason: "end_turn".into(),
            },
        ));
        assert_eq!(f.activity, Activity::None);
        assert_eq!(
            f.last,
            Some(Last {
                seq: 4,
                ts: 1004,
                outcome: "end_turn".into(),
                error: None
            })
        );
    }

    #[test]
    fn turn_error_is_an_error_last() {
        let f = fold(vec![
            spawn(),
            session("s", None),
            prompt(),
            EventBody::TurnError {
                code: TurnErrorCode::AgentError,
                message: "boom".into(),
                rpc: None,
            },
        ]);
        assert_eq!(f.activity, Activity::None);
        let last = f.last.unwrap();
        assert_eq!((last.seq, last.outcome.as_str()), (4, "error"));
        assert_eq!(last.error.unwrap().code, "agent_error");
    }

    #[test]
    fn requests_are_pending_in_ascending_order_until_resolved() {
        let long = "x".repeat(300);
        let mut f = fold(vec![
            spawn(),
            session("s", None),
            prompt(),
            permission("Run `ls`"),
            elicitation(&long),
        ]);
        assert_eq!(
            f.pending,
            vec![
                Pending {
                    req: 4,
                    kind: PendingKind::Permission,
                    title: "Run `ls`".into(),
                    ts: 1004
                },
                Pending {
                    req: 5,
                    kind: PendingKind::Elicitation,
                    title: "x".repeat(200),
                    ts: 1005
                },
            ]
        );
        f.apply(&ev(
            6,
            EventBody::PermissionResolved {
                req: 4,
                outcome: json!({"outcome": "selected", "optionId": "allow"}),
                by: ResolvedBy::User,
            },
        ));
        assert_eq!(f.pending.iter().map(|p| p.req).collect::<Vec<_>>(), [5]);
        f.apply(&ev(
            7,
            EventBody::ElicitationResolved {
                req: 5,
                response: json!({"action": "decline"}),
                by: ResolvedBy::Agent,
            },
        ));
        assert!(f.pending.is_empty());
        assert_eq!(
            f.activity,
            Activity::Turn,
            "a request does not end the turn"
        );
    }

    #[test]
    fn titles_are_cut_by_characters_and_default_to_empty() {
        let wide = "é".repeat(250);
        let f = fold(vec![
            permission(&wide),
            EventBody::Permission {
                tool_call: json!({"toolCallId": "t2"}),
                options: vec![],
            },
        ]);
        assert_eq!(f.pending[0].title, "é".repeat(200));
        assert_eq!(f.pending[1].title, "");
    }

    #[test]
    fn state_updates_materialise() {
        let f = fold(vec![
            update(json!({"sessionUpdate": "session_info_update", "title": "Fix the build"})),
            update(
                json!({"sessionUpdate": "plan", "entries": [{"content": "a", "priority": "high", "status": "pending"}]}),
            ),
            update(
                json!({"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "init", "description": "d"}]}),
            ),
            update(json!({"sessionUpdate": "usage_update", "used": 5, "size": 100, "cost": null})),
            update(json!({"sessionUpdate": "config_option_update", "configOptions": []})),
            update(
                json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hi"}}),
            ),
            update(json!({"sessionUpdate": "brand_new_variant", "x": 1})),
        ]);
        assert_eq!(f.head_seq, 7);
        assert_eq!(f.title.as_deref(), Some("Fix the build"));
        assert_eq!(
            f.plan,
            Some(json!({"entries": [{"content": "a", "priority": "high", "status": "pending"}]}))
        );
        assert_eq!(
            f.available_commands,
            Some(json!([{"name": "init", "description": "d"}]))
        );
        assert_eq!(f.usage, Some(json!({"used": 5, "size": 100, "cost": null})));
        assert_eq!(f.activity, Activity::None);
    }

    #[test]
    fn session_info_title_absent_keeps_and_null_clears() {
        let mut f = fold(vec![update(
            json!({"sessionUpdate": "session_info_update", "title": "T"}),
        )]);
        f.apply(&ev(
            2,
            update(json!({"sessionUpdate": "session_info_update", "updatedAt": "now"})),
        ));
        assert_eq!(f.title.as_deref(), Some("T"));
        f.apply(&ev(
            3,
            update(json!({"sessionUpdate": "session_info_update", "title": null})),
        ));
        assert_eq!(f.title, None);
    }

    #[test]
    fn mode_changes_update_mode_id_and_modes() {
        let modes = json!({"currentModeId": "default", "availableModes": [{"id": "default"}, {"id": "plan"}]});
        let mut f = fold(vec![spawn(), session("s", Some(modes))]);
        f.apply(&ev(
            3,
            update(json!({"sessionUpdate": "current_mode_update", "currentModeId": "plan"})),
        ));
        assert_eq!(f.mode_id.as_deref(), Some("plan"));
        assert_eq!(f.modes.as_ref().unwrap()["currentModeId"], "plan");
        f.apply(&ev(
            4,
            EventBody::Mode {
                mode_id: "default".into(),
            },
        ));
        assert_eq!(f.mode_id.as_deref(), Some("default"));
        assert_eq!(f.modes.as_ref().unwrap()["currentModeId"], "default");
    }

    #[test]
    fn exit_ends_running_and_activity() {
        let f = fold(vec![spawn(), session("s", None), prompt(), exit()]);
        assert!(!f.running);
        assert_eq!(f.activity, Activity::None);
        assert_eq!(f.agent_session_id.as_deref(), Some("s"));
    }

    #[test]
    fn notice_and_elicitation_complete_touch_only_the_head() {
        let before = fold(vec![spawn(), session("s", None), prompt()]);
        let mut after = before.clone();
        after.apply(&ev(
            4,
            EventBody::Notice {
                level: NoticeLevel::Info,
                text: "revived via session/resume".into(),
            },
        ));
        after.apply(&ev(
            5,
            EventBody::ElicitationComplete {
                elicitation_id: "e1".into(),
            },
        ));
        assert_eq!(after.head_seq, 5);
        assert_eq!(
            Facts {
                head_seq: 3,
                ..after
            },
            before
        );
    }

    #[test]
    fn unknown_is_skipped_but_advances_the_head() {
        let before = fold(vec![spawn(), session("s", None), prompt()]);
        let mut after = before.clone();
        after.apply(&ev(4, EventBody::Unknown));
        assert_eq!(after.head_seq, 4);
        assert_eq!(
            Facts {
                head_seq: 3,
                ..after
            },
            before
        );
    }

    fn init(load: Option<bool>, resume: Option<Value>) -> Value {
        let mut caps = serde_json::Map::new();
        if let Some(l) = load {
            caps.insert("loadSession".into(), Value::Bool(l));
        }
        if let Some(r) = resume {
            caps.insert("sessionCapabilities".into(), json!({"resume": r}));
        }
        json!({"protocolVersion": 1, "agentCapabilities": caps})
    }

    #[test]
    fn revivable_from_init() {
        let f = fold(vec![spawn(), session("s", None), exit()]);
        assert!(f.revivable(Some(&init(Some(true), None))));
        assert!(f.revivable(Some(&init(None, Some(json!({}))))));
        assert!(!f.revivable(Some(&init(Some(false), None))));
        assert!(!f.revivable(Some(&init(None, Some(Value::Null)))));
        assert!(!f.revivable(Some(&init(None, None))));
        assert!(!f.revivable(None));
    }

    #[test]
    fn revivable_needs_an_agent_session_id() {
        let f = fold(vec![
            spawn(),
            EventBody::SetupError {
                code: SetupErrorCode::AuthRequired,
                message: "logged out".into(),
                rpc: None,
            },
            exit(),
        ]);
        assert!(!f.revivable(Some(&init(Some(true), Some(json!({}))))));
    }

    #[test]
    fn revive_failed_makes_revivable_false_until_the_next_session() {
        let caps = init(Some(true), Some(json!({})));
        let mut f = fold(vec![spawn(), session("s", None), exit()]);
        let revive = |f: &mut Facts, seq: u64| {
            f.apply(&ev(
                seq,
                EventBody::Spawn {
                    pid: 43,
                    via: SpawnVia::Revive,
                },
            ));
        };
        revive(&mut f, 4);
        f.apply(&ev(
            5,
            EventBody::SetupError {
                code: SetupErrorCode::ReviveFailed,
                message: "neither resume nor load worked".into(),
                rpc: None,
            },
        ));
        f.apply(&ev(6, exit()));
        assert!(f.revive_failed);
        assert!(!f.revivable(Some(&caps)));

        revive(&mut f, 7);
        assert!(!f.revivable(Some(&caps)), "a spawn does not clear it");
        f.apply(&ev(
            8,
            EventBody::Session {
                via: SessionVia::Load,
                session_id: "s".into(),
                modes: None,
                config_options: None,
            },
        ));
        assert!(!f.revive_failed);
        assert!(f.revivable(Some(&caps)));
    }

    #[test]
    fn death_lines_resolve_pending_then_end_the_turn() {
        let f = fold(vec![
            spawn(),
            session("s", None),
            prompt(),
            permission("p"),
            elicitation("e"),
        ]);
        assert_eq!(
            f.death_lines(true, "stopped"),
            vec![
                EventBody::PermissionResolved {
                    req: 4,
                    outcome: json!({"outcome": "cancelled"}),
                    by: ResolvedBy::Hub,
                },
                EventBody::ElicitationResolved {
                    req: 5,
                    response: json!({"action": "cancel"}),
                    by: ResolvedBy::Hub
                },
                EventBody::TurnError {
                    code: TurnErrorCode::Interrupted,
                    message: "stopped".into(),
                    rpc: None
                },
            ]
        );
        assert_eq!(
            f.death_lines(false, "agent exited").last(),
            Some(&EventBody::TurnError {
                code: TurnErrorCode::AgentExited,
                message: "agent exited".into(),
                rpc: None
            })
        );
    }

    #[test]
    fn death_lines_end_a_setup_and_are_empty_when_idle() {
        let setup = fold(vec![spawn()]);
        assert_eq!(
            setup.death_lines(false, "agent exited"),
            vec![EventBody::SetupError {
                code: SetupErrorCode::AgentExited,
                message: "agent exited".into(),
                rpc: None
            }]
        );
        let idle = fold(vec![spawn(), session("s", None)]);
        assert!(idle.death_lines(true, "stopped").is_empty());
    }

    #[test]
    fn applying_the_death_lines_leaves_nothing_outstanding() {
        let mut f = fold(vec![spawn(), session("s", None), prompt(), permission("p")]);
        let mut seq = f.head_seq;
        for body in f.death_lines(true, "stopped") {
            seq += 1;
            f.apply(&ev(seq, body));
        }
        assert!(f.pending.is_empty());
        assert_eq!(f.activity, Activity::None);
        assert_eq!(f.last.as_ref().unwrap().outcome, "error");
    }
}
