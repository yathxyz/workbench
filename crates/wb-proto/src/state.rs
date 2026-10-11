//! The display state of a session, derived from its [`Summary`].
//!
//! Only the web calls [`derive`]. It adds the result to every Summary it forwards, as
//! the field `state`, so these rules change with an ordinary web deploy and never need a
//! hub restart. The table in the tests below is normative.

use serde::Serialize;

use crate::hub::{AcpFacts, Activity, PendingKind, Summary};

/// What a card shows for its session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Idle,
    Running,
    WaitingPermission,
    WaitingInput,
    Done,
    Error,
    Exited,
    Detached,
}

/// The `last.outcome` values that make an unseen `last` an error.
const ERROR_OUTCOMES: [&str; 4] = ["error", "refusal", "max_tokens", "max_turn_requests"];

/// The state of `s`; the first matching rule wins.
///
/// - Any kind: a `fault` gives `error`.
/// - A Summary with an `acp` block follows the ACP rules:
///   1. a pending `permission` gives `waiting_permission`;
///   2. any other pending request gives `waiting_input`;
///   3. an unseen `last` (`last.seq > seenSeq`) whose outcome is `error`, `refusal`,
///      `max_tokens` or `max_turn_requests` gives `error`;
///   4. alive with an activity other than `none` gives `running`;
///   5. not alive and revivable gives `detached`;
///   6. not alive gives `exited`;
///   7. an unseen `last` with any outcome except `cancelled` gives `done`;
///   8. otherwise `idle`.
/// - Every other Summary follows the PTY rules: not alive gives `exited`; a foreground
///   process group that is not the child's own (`fg.leader == false`) gives `running`;
///   otherwise `idle`, which includes a live session whose `fg` is not known yet.
pub fn derive(s: &Summary) -> State {
    if s.fault.is_some() {
        return State::Error;
    }
    match &s.acp {
        Some(a) => acp(s.alive, a),
        None => pty(s),
    }
}

fn pty(s: &Summary) -> State {
    let fg = s.pty.as_ref().and_then(|p| p.fg.as_ref());
    if !s.alive {
        State::Exited
    } else if fg.is_some_and(|fg| !fg.leader) {
        State::Running
    } else {
        State::Idle
    }
}

fn acp(alive: bool, a: &AcpFacts) -> State {
    let unseen = a.last.as_ref().filter(|l| l.seq > a.seen_seq);
    if a.pending.iter().any(|p| p.kind == PendingKind::Permission) {
        State::WaitingPermission
    } else if !a.pending.is_empty() {
        State::WaitingInput
    } else if unseen.is_some_and(|l| ERROR_OUTCOMES.contains(&l.outcome.as_str())) {
        State::Error
    } else if alive && a.activity != Activity::None {
        State::Running
    } else if !alive && a.revivable {
        State::Detached
    } else if !alive {
        State::Exited
    } else if unseen.is_some_and(|l| l.outcome != "cancelled") {
        State::Done
    } else {
        State::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{
        Exit, ExitReason, Fault, FaultCode, Fg, Kind, Last, LastError, Pending, PtyFacts,
    };

    use State::*;

    fn summary(kind: Kind, alive: bool) -> Summary {
        Summary {
            sid: "n_1".into(),
            kind,
            host: "example".into(),
            created_at: 1,
            updated_at: 2,
            alive,
            viewers: 1,
            cwd: "/home/alice".into(),
            fault: None,
            pty: None,
            acp: None,
        }
    }

    /// A PTY session; `leader` is `fg.leader`, `None` when `fg` is absent.
    fn pty(alive: bool, leader: Option<bool>) -> Summary {
        Summary {
            pty: Some(PtyFacts {
                argv: vec!["/bin/bash".into()],
                pid: alive.then_some(10),
                fg: leader.map(|leader| Fg {
                    comm: if leader { "bash" } else { "make" }.into(),
                    pgid: if leader { 10 } else { 11 },
                    leader,
                }),
                exit: (!alive).then_some(Exit {
                    code: Some(0),
                    signal: None,
                    reason: ExitReason::Exited,
                    at: 3,
                }),
            }),
            ..summary(Kind::Pty, alive)
        }
    }

    /// A PTY corpse left by a hub restart.
    fn pty_hub_restart() -> Summary {
        let mut s = pty(false, None);
        s.pty.as_mut().unwrap().exit = Some(Exit {
            code: None,
            signal: None,
            reason: ExitReason::HubRestart,
            at: 3,
        });
        s
    }

    /// An ACP session that is idle with nothing unseen, changed by `edit`.
    fn acp(alive: bool, edit: impl FnOnce(&mut AcpFacts)) -> Summary {
        let mut facts = AcpFacts {
            agent: "claude".into(),
            agent_session_id: Some("c0ffee".into()),
            revivable: true,
            activity: Activity::None,
            pending: Vec::new(),
            last: None,
            head_seq: 10,
            seen_seq: 10,
            title: None,
            mode_id: None,
        };
        edit(&mut facts);
        Summary {
            acp: Some(facts),
            ..summary(Kind::Acp, alive)
        }
    }

    fn faulted(s: Summary) -> Summary {
        Summary {
            fault: Some(Fault {
                code: FaultCode::JournalWrite,
                message: "No space left on device".into(),
            }),
            ..s
        }
    }

    fn pending(req: u64, kind: PendingKind) -> Pending {
        Pending {
            req,
            kind,
            title: "Run `make`".into(),
            ts: 5,
        }
    }

    /// `last` at seq 9 with `outcome`.
    fn last(outcome: &str) -> Option<Last> {
        Some(Last {
            seq: 9,
            ts: 6,
            outcome: outcome.into(),
            error: (outcome == "error").then(|| LastError {
                code: "interrupted".into(),
                message: "hub restart".into(),
            }),
        })
    }

    /// `last` with `outcome`, not yet seen.
    fn unseen(a: &mut AcpFacts, outcome: &str) {
        a.last = last(outcome);
        a.seen_seq = 8;
    }

    /// `last` with `outcome`, already seen.
    fn seen(a: &mut AcpFacts, outcome: &str) {
        a.last = last(outcome);
        a.seen_seq = 9;
    }

    #[test]
    fn derive_table() {
        let rows: Vec<(&str, Summary, State)> = vec![
            // Rule 0, both kinds.
            (
                "pty fault while running",
                faulted(pty(true, Some(false))),
                Error,
            ),
            ("pty fault beats exited", faulted(pty(false, None)), Error),
            (
                "acp fault beats a pending permission",
                faulted(acp(true, |a| {
                    a.activity = Activity::Turn;
                    a.pending = vec![pending(9, PendingKind::Permission)];
                })),
                Error,
            ),
            (
                "acp fault beats detached",
                faulted(acp(false, |_| {})),
                Error,
            ),
            (
                "acp load fault: dead, not revivable, nothing else",
                faulted(acp(false, |a| {
                    a.agent_session_id = None;
                    a.revivable = false;
                })),
                Error,
            ),
            // PTY.
            ("pty dead", pty(false, None), Exited),
            ("pty dead after a hub restart", pty_hub_restart(), Exited),
            ("pty foreground job", pty(true, Some(false)), Running),
            ("pty shell in front", pty(true, Some(true)), Idle),
            ("pty fg not polled yet", pty(true, None), Idle),
            ("no facts block, alive", summary(Kind::Unknown, true), Idle),
            (
                "no facts block, dead",
                summary(Kind::Unknown, false),
                Exited,
            ),
            // ACP rule 1.
            (
                "permission pending",
                acp(true, |a| {
                    a.activity = Activity::Turn;
                    a.pending = vec![pending(9, PendingKind::Permission)];
                }),
                WaitingPermission,
            ),
            (
                "permission after an elicitation",
                acp(true, |a| {
                    a.activity = Activity::Turn;
                    a.pending = vec![
                        pending(8, PendingKind::Elicitation),
                        pending(9, PendingKind::Permission),
                    ];
                }),
                WaitingPermission,
            ),
            (
                "permission beats an unseen error",
                acp(true, |a| {
                    unseen(a, "error");
                    a.pending = vec![pending(9, PendingKind::Permission)];
                }),
                WaitingPermission,
            ),
            // ACP rule 2.
            (
                "elicitation pending",
                acp(true, |a| {
                    a.activity = Activity::Turn;
                    a.pending = vec![pending(9, PendingKind::Elicitation)];
                }),
                WaitingInput,
            ),
            (
                "pending of an unknown kind",
                acp(true, |a| a.pending = vec![pending(9, PendingKind::Unknown)]),
                WaitingInput,
            ),
            (
                "elicitation beats an unseen error",
                acp(true, |a| {
                    unseen(a, "refusal");
                    a.pending = vec![pending(9, PendingKind::Elicitation)];
                }),
                WaitingInput,
            ),
            (
                "pending beats dead",
                acp(false, |a| {
                    a.pending = vec![pending(9, PendingKind::Elicitation)]
                }),
                WaitingInput,
            ),
            // ACP rule 3.
            ("unseen error", acp(true, |a| unseen(a, "error")), Error),
            ("unseen refusal", acp(true, |a| unseen(a, "refusal")), Error),
            (
                "unseen max_tokens",
                acp(true, |a| unseen(a, "max_tokens")),
                Error,
            ),
            (
                "unseen max_turn_requests",
                acp(true, |a| unseen(a, "max_turn_requests")),
                Error,
            ),
            (
                "unseen error beats running",
                acp(true, |a| {
                    unseen(a, "error");
                    a.activity = Activity::Setup;
                }),
                Error,
            ),
            (
                "unseen error beats detached",
                acp(false, |a| unseen(a, "error")),
                Error,
            ),
            ("seen error", acp(true, |a| seen(a, "error")), Idle),
            // ACP rule 4.
            ("turn", acp(true, |a| a.activity = Activity::Turn), Running),
            (
                "setup",
                acp(true, |a| a.activity = Activity::Setup),
                Running,
            ),
            (
                "unknown activity counts as running",
                acp(true, |a| a.activity = Activity::Unknown),
                Running,
            ),
            (
                "running beats an unseen end_turn",
                acp(true, |a| {
                    unseen(a, "end_turn");
                    a.activity = Activity::Turn;
                }),
                Running,
            ),
            // ACP rule 5.
            ("dead and revivable", acp(false, |_| {}), Detached),
            (
                "detached beats an unseen end_turn",
                acp(false, |a| unseen(a, "end_turn")),
                Detached,
            ),
            // ACP rule 6.
            (
                "dead, not revivable",
                acp(false, |a| a.revivable = false),
                Exited,
            ),
            (
                "never got an agent session",
                acp(false, |a| {
                    a.agent_session_id = None;
                    a.revivable = false;
                }),
                Exited,
            ),
            (
                "exited beats an unseen end_turn",
                acp(false, |a| {
                    unseen(a, "end_turn");
                    a.revivable = false;
                }),
                Exited,
            ),
            // ACP rule 7.
            (
                "unseen end_turn",
                acp(true, |a| unseen(a, "end_turn")),
                Done,
            ),
            (
                "unseen unknown stop reason",
                acp(true, |a| unseen(a, "paused_for_review")),
                Done,
            ),
            // ACP rule 8.
            (
                "done clears once seen",
                acp(true, |a| seen(a, "end_turn")),
                Idle,
            ),
            (
                "unseen cancelled",
                acp(true, |a| unseen(a, "cancelled")),
                Idle,
            ),
            (
                "fresh session",
                acp(true, |a| {
                    a.head_seq = 0;
                    a.seen_seq = 0;
                }),
                Idle,
            ),
            // A hub restart during setup or a turn ends in setup_error or turn_error
            // {interrupted}: error until seen, then exited or detached.
            (
                "interrupted setup, unseen",
                acp(false, |a| {
                    unseen(a, "error");
                    a.agent_session_id = None;
                    a.revivable = false;
                }),
                Error,
            ),
            (
                "interrupted setup, seen",
                acp(false, |a| {
                    seen(a, "error");
                    a.agent_session_id = None;
                    a.revivable = false;
                }),
                Exited,
            ),
            (
                "interrupted turn, seen, revivable",
                acp(false, |a| seen(a, "error")),
                Detached,
            ),
        ];
        let failures: Vec<String> = rows
            .iter()
            .filter(|(_, s, want)| derive(s) != *want)
            .map(|(name, s, want)| format!("{name}: want {want:?}, got {:?}", derive(s)))
            .collect();
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn states_serialize_as_snake_case() {
        let all = [
            Idle,
            Running,
            WaitingPermission,
            WaitingInput,
            Done,
            Error,
            Exited,
            Detached,
        ];
        assert_eq!(
            serde_json::to_value(all).unwrap(),
            serde_json::json!([
                "idle",
                "running",
                "waiting_permission",
                "waiting_input",
                "done",
                "error",
                "exited",
                "detached"
            ])
        );
    }
}
