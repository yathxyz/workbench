//! ACP helpers for hub tests: `wb-fake-acp` agents in the hub's table, the journal and
//! the fake's record on disk, and `acp.*` requests.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use wb_proto::journal::{EventBody, JournalEvent};

use super::schema::{Checker, Side};
use super::{Client, Hub, PATIENCE};

/// Adds `wb-fake-acp` to `config`'s agent table as `name`, with `args` plus
/// `--record <dir>/<name>.rec` and the agent env `RUST_LOG=debug`.
pub fn stub(config: &mut Value, name: &str, args: &[&str]) {
    let state = PathBuf::from(config["stateDir"].as_str().unwrap());
    let record = state.parent().unwrap().join(format!("{name}.rec"));
    let mut argv = vec![env!("CARGO_BIN_EXE_wb-fake-acp").to_owned()];
    argv.extend(args.iter().map(|a| (*a).to_owned()));
    argv.extend(["--record".to_owned(), record.to_string_lossy().into_owned()]);
    config["agents"][name] = json!({"label": format!("Fake {name}"), "argv": argv,
                                    "env": {"RUST_LOG": "debug"}});
}

impl Hub {
    /// A hub with one agent per scenario, named after it, plus `stub` in keyword mode.
    pub fn with_scenarios(names: &[&str]) -> Hub {
        Hub::start_with(|config| {
            stub(config, "stub", &[]);
            for name in names {
                stub(config, name, &["--scenario", name]);
            }
        })
    }

    /// The home directory children get, which exists: a cwd for `acp.open`.
    pub fn home(&self) -> String {
        self.dir.join("home").to_string_lossy().into_owned()
    }

    /// `stateDir/acp/<file>`.
    pub fn acp_file(&self, file: &str) -> PathBuf {
        self.dir.join("state").join("acp").join(file)
    }

    /// Everything agent `agent` recorded, every process of it in one file.
    pub fn record(&self, agent: &str) -> Vec<Value> {
        fs::read_to_string(self.dir.join(format!("{agent}.rec")))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// The messages agent `agent` received from the hub, after checking every one
    /// against the schema (responses by the method of the fake's request).
    pub fn received(&self, agent: &str) -> Vec<Value> {
        let mut checker = Checker::default();
        let mut received = Vec::new();
        for entry in self.record(agent) {
            if let Some(sent) = entry.get("sent") {
                checker.check(Side::Agent, sent);
            } else if let Some(msg) = entry.get("recv") {
                checker.check(Side::Client, msg);
                received.push(msg.clone());
            }
        }
        received
    }

    /// The received messages with method `method`.
    pub fn received_calls(&self, agent: &str, method: &str) -> Vec<Value> {
        self.received(agent)
            .into_iter()
            .filter(|m| m["method"] == method)
            .collect()
    }

    /// The journal of `sid`, one value per line, after checking that every line is a
    /// known [`JournalEvent`] and that seqs run 1, 2, 3, … without a gap.
    pub fn journal(&self, sid: &str) -> Vec<Value> {
        let text = fs::read_to_string(self.acp_file(&format!("{sid}.jsonl"))).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        for (i, line) in lines.iter().enumerate() {
            let ev: JournalEvent = serde_json::from_value(line.clone())
                .unwrap_or_else(|e| panic!("journal line {}: {e}: {line}", i + 1));
            assert_ne!(ev.body, EventBody::Unknown, "{line}");
            assert_eq!(ev.seq, i as u64 + 1, "{line}");
        }
        lines
    }

    /// The `e` of every journal line of `sid`.
    pub fn kinds(&self, sid: &str) -> Vec<String> {
        self.journal(sid)
            .iter()
            .map(|l| l["e"].as_str().unwrap().to_owned())
            .collect()
    }

    pub fn stderr_log(&self, sid: &str) -> String {
        fs::read_to_string(self.acp_file(&format!("{sid}.stderr.log"))).unwrap_or_default()
    }
}

impl Client {
    /// The next message, waiting up to `within`; `None` once the hub closed the
    /// connection.
    pub fn next_within(&mut self, within: Duration) -> Option<Value> {
        if let Some(m) = self.pending.pop_front() {
            return Some(m);
        }
        self.read_line(Instant::now() + within)
    }

    /// `acp.open` creating `sid` with agent `agent` in `cwd`; the `ok`.
    pub fn acp_spawn(&mut self, sid: &str, agent: &str, cwd: &str) -> Value {
        self.ok(json!({"t": "acp.open", "sid": sid, "since": 0,
                       "spawn": {"agent": agent, "cwd": cwd}}))
    }

    /// `acp.open` without spawn fields; the reply.
    pub fn acp_open(&mut self, sid: &str, since: u64) -> Value {
        self.request(json!({"t": "acp.open", "sid": sid, "since": since}))
    }

    /// After an `acp.open` `ok`: the replayed events of `sid`, and the `acp.replayed`.
    pub fn replay(&mut self, sid: &str) -> (Vec<Value>, Value) {
        let mut evs = Vec::new();
        loop {
            let m = self.next().expect("closed during the replay");
            if m["sid"] != sid {
                continue;
            }
            match m["t"].as_str() {
                Some("acp.ev") => evs.push(m["ev"].clone()),
                Some("acp.replayed") => return (evs, m),
                _ => {}
            }
        }
    }

    /// The journal events of `sid` until one of kind `e` (included), waiting up to
    /// `within` for each message.
    pub fn events_until_within(&mut self, sid: &str, e: &str, within: Duration) -> Vec<Value> {
        let mut evs = Vec::new();
        loop {
            let m = self
                .next_within(within)
                .unwrap_or_else(|| panic!("closed while waiting for {e}"));
            if m["t"] == "acp.ev" && m["sid"] == sid {
                evs.push(m["ev"].clone());
                if m["ev"]["e"] == e {
                    return evs;
                }
            }
        }
    }

    /// [`events_until_within`](Self::events_until_within) with [`PATIENCE`].
    pub fn events_until(&mut self, sid: &str, e: &str) -> Vec<Value> {
        self.events_until_within(sid, e, PATIENCE)
    }

    /// The next journal event of `sid` of kind `e`.
    pub fn event(&mut self, sid: &str, e: &str) -> Value {
        self.events_until(sid, e).pop().unwrap()
    }

    /// The Summary of `sid` from `list`.
    pub fn summary(&mut self, sid: &str) -> Value {
        let reply = self.ok(json!({"t": "list"}));
        reply["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sid"] == sid)
            .unwrap_or_else(|| panic!("{sid} not in {reply}"))
            .clone()
    }

    /// Polls `list` until the Summary of `sid` satisfies `cond`; that Summary.
    pub fn summary_until(&mut self, sid: &str, what: &str, cond: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let s = self.summary(sid);
            if cond(&s) {
                return s;
            }
            assert!(Instant::now() < deadline, "{what}: {s}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// `acp.prompt` with one text block; the reply.
    pub fn acp_prompt(&mut self, sid: &str, text: &str) -> Value {
        self.request(json!({"t": "acp.prompt", "sid": sid,
                            "prompt": [{"type": "text", "text": text}]}))
    }
}

/// "Fold == live": kills every live agent, then compares each Summary from `list` and
/// each `AcpSessionInfo` from `acp.open` before and after a SIGTERM and restart of the
/// hub. Only `viewers` and `updatedAt` may differ; with no agent alive, startup
/// normalisation has nothing to add.
pub fn fold_equals_live(hub: &mut Hub) {
    let before = settled_state(hub);
    hub.terminate();
    hub.restart();
    let after = settled_state(hub);
    assert_eq!(
        before, after,
        "the state folded at startup differs from the live one"
    );
}

/// Every session's Summary (without `viewers` and `updatedAt`) and, for ACP, its
/// `AcpSessionInfo`, once no agent is alive.
fn settled_state(hub: &Hub) -> Vec<(Value, Value)> {
    let mut c = hub.connect();
    let sessions = c.ok(json!({"t": "list"}))["sessions"].clone();
    for s in sessions.as_array().unwrap() {
        if s["kind"] == "acp" && s["alive"] == true {
            c.ok(json!({"t": "acp.kill", "sid": s["sid"], "forget": false}));
            c.summary_until(s["sid"].as_str().unwrap(), "the agent exits", |s| {
                s["alive"] == false
            });
        }
    }
    let sessions = c.ok(json!({"t": "list"}))["sessions"].clone();
    let mut state = Vec::new();
    for s in sessions.as_array().unwrap() {
        let sid = s["sid"].as_str().unwrap();
        let mut summary = s.clone();
        summary.as_object_mut().unwrap().remove("viewers");
        summary.as_object_mut().unwrap().remove("updatedAt");
        let mut info = Value::Null;
        if s["kind"] == "acp" {
            let head = s["acp"]["headSeq"].as_u64().unwrap();
            info = c.ok(json!({"t": "acp.open", "sid": sid, "since": head}))["session"].clone();
            c.replay(sid);
            c.ok(json!({"t": "acp.detach", "sid": sid}));
        }
        state.push((summary, info));
    }
    state.sort_by(|a, b| a.0["sid"].as_str().cmp(&b.0["sid"].as_str()));
    state
}

/// The live (non-zombie) members of process group `pgid`, from `/proc/*/stat`.
pub fn group_members(pgid: u32) -> Vec<u32> {
    let mut members = Vec::new();
    for entry in fs::read_dir("/proc").unwrap().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // After the parenthesised comm: state, ppid, pgrp, …
        let Some((_, rest)) = stat.rsplit_once(')') else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() > 2 && fields[0] != "Z" && fields[2] == pgid.to_string() {
            members.push(pid);
        }
    }
    members
}
