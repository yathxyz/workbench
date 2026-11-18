//! The registry of observed sessions (design §3.8.3): records of agent sessions built
//! from the hook events that hosts send, kept in memory and in `observed.json`.

mod normalize;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use wb_proto::state::State;

use crate::util::{atomic_write, now_ms};
use normalize::{Event, excerpt, normalize};

pub const OBS_SESSIONS_MAX: usize = 256;
pub const OBS_TEXT_MAX: usize = 2 << 10;
pub const OBS_TAIL: usize = 20;
pub const OBS_SWEEP: Duration = Duration::from_secs(10);
pub const OBS_SAVE_EVERY: Duration = Duration::from_secs(5);
pub const OBS_SILENT_END: Duration = Duration::from_secs(12 * 3600);
pub const OBS_ENDED_KEEP: Duration = Duration::from_secs(6 * 3600);
pub const OBS_PUSH_EVERY: Duration = Duration::from_millis(500);

/// Longest title, in bytes.
const TITLE_MAX: usize = 120;
const FILE: &str = "observed.json";
const FILE_VERSION: u32 = 1;

/// What one event is, once normalised.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObsKind {
    Start,
    Prompt,
    ToolStart,
    ToolEnd,
    ToolFail,
    Permission,
    PermissionDone,
    Question,
    TurnEnd,
    SubagentStart,
    SubagentEnd,
    Note,
    End,
}

impl ObsKind {
    /// The kind a neutral event names, exactly.
    fn parse(s: &str) -> Option<ObsKind> {
        serde_json::from_value(Value::String(s.to_owned())).ok()
    }
}

/// Why a record ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    SessionEnd,
    ProcessGone,
    Silent,
    Replaced,
    ParentEnded,
}

/// The tool a record is running, its input as an excerpt.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub input: Option<String>,
}

/// What a pending request asks for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingKind {
    Permission,
    Question,
}

/// A request that waits for the owner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pending {
    pub kind: PendingKind,
    pub tool: Option<String>,
    pub input: Option<String>,
    pub message: Option<String>,
    pub at: u64,
}

/// How many of each a record has seen.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub events: u64,
    pub prompts: u64,
    pub tools: u64,
    pub tool_failures: u64,
    pub subagents: u64,
}

/// One event in a record's tail.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TailLine {
    pub at: u64,
    pub kind: ObsKind,
    pub text: String,
}

/// How the owner can open the agent's existing terminal.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Attach {
    Claude { id: String },
    Tmux { socket: String, pane: u32 },
}

impl Attach {
    pub fn valid(&self) -> bool {
        match self {
            Self::Claude { id } => {
                id.len() == 8
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }
            Self::Tmux { socket, pane } => {
                (2..=201).contains(&socket.len())
                    && socket.starts_with('/')
                    && !socket.contains("..")
                    && socket.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-')
                    })
                    && *pane <= 999_999
            }
        }
    }

    /// Revalidate at the command boundary, including records loaded from disk.
    pub fn address(&self, host: &str) -> Option<String> {
        if !(1..=64).contains(&host.len())
            || host.contains("..")
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
            || !self.valid()
        {
            return None;
        }
        Some(match self {
            Self::Claude { id } => format!("{host}:claude:{id}"),
            Self::Tmux { socket, pane } => format!("{host}:tmux:{pane}:{socket}"),
        })
    }
}

/// One observed session, as the API shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservedSession {
    pub id: String,
    pub key: String,
    pub host: String,
    pub harness: String,
    pub session_id: String,
    pub parent: Option<String>,
    pub agent_type: Option<String>,
    pub wb_session: Option<String>,
    #[serde(default)]
    pub attach: Option<Attach>,
    pub pid: Option<u32>,
    pub transcript_path: Option<String>,
    pub cwd: Option<String>,
    pub project_root: Option<String>,
    pub project: String,
    #[serde(default, deserialize_with = "de_metadata")]
    pub repo_root: Option<String>,
    #[serde(default, deserialize_with = "de_metadata")]
    pub repo: Option<String>,
    #[serde(default, deserialize_with = "de_metadata")]
    pub worktree: Option<String>,
    #[serde(default, deserialize_with = "de_metadata")]
    pub branch: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub title: String,
    #[serde(deserialize_with = "de_state")]
    pub state: State,
    pub started_at: u64,
    pub last_at: u64,
    pub ended_at: Option<u64>,
    pub end_reason: Option<EndReason>,
    pub tool: Option<Tool>,
    pub pending: Option<Pending>,
    pub last_prompt: Option<String>,
    pub last_message: Option<String>,
    pub counts: Counts,
    pub tail: Vec<TailLine>,
}

/// Persisted metadata is untrusted too; invalid optional fields do not lose a record.
fn de_metadata<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = Value::deserialize(d)?;
    Ok(value
        .as_str()
        .filter(|s| s.len() <= OBS_TEXT_MAX)
        .map(str::to_owned))
}

/// `State` by its §3.4.6 name; wb-proto only serialises it.
fn de_state<'de, D: Deserializer<'de>>(d: D) -> Result<State, D::Error> {
    Ok(match String::deserialize(d)?.as_str() {
        "idle" => State::Idle,
        "running" => State::Running,
        "waiting_permission" => State::WaitingPermission,
        "waiting_input" => State::WaitingInput,
        "done" => State::Done,
        "error" => State::Error,
        "exited" => State::Exited,
        "detached" => State::Detached,
        other => return Err(de::Error::custom(format!("unknown state {other}"))),
    })
}

/// What changed since the last `drain`.
#[derive(Clone)]
pub enum Change {
    Upsert(Box<ObservedSession>),
    Gone { id: String, key: String },
}

/// Changes a slow subscriber may fall behind by before it lags.
const CHANGES_CAPACITY: usize = 1024;

/// The registry and the broadcast of its changes; present when web.json has `api`.
#[derive(Clone)]
pub struct Observed {
    pub registry: Registry,
    pub changes: broadcast::Sender<Change>,
}

impl Observed {
    /// Loads the registry from `state_dir`, which is created if need be.
    pub fn load(state_dir: &Path, host: &str) -> Result<Observed> {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(state_dir)
            .with_context(|| format!("cannot create {}", state_dir.display()))?;
        Ok(Observed {
            registry: Registry::load(state_dir, host, Path::new("/proc"), now_ms()),
            changes: broadcast::channel(CHANGES_CAPACITY).0,
        })
    }
}

/// Where a record is in its turn.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Turn {
    #[default]
    None,
    Running,
    Ended,
}

/// What the fold keeps beyond the API record; saved with it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Facts {
    pid_start: Option<u64>,
    turn: Turn,
    /// The title came from a prompt.
    titled: bool,
}

/// A record and its facts, saved as one flat object.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Entry {
    #[serde(flatten)]
    s: ObservedSession,
    #[serde(flatten)]
    facts: Facts,
}

impl Entry {
    fn is_live(&self) -> bool {
        self.s.ended_at.is_none()
    }

    /// Recomputes `project`, the fallback title and `state`.
    fn refresh(&mut self) {
        let s = &mut self.s;
        s.project = s
            .project_root
            .as_deref()
            .or(s.cwd.as_deref())
            .map_or_else(|| "(no cwd)".to_owned(), basename);
        if !self.facts.titled {
            s.title = excerpt(
                &s.agent_type
                    .clone()
                    .unwrap_or_else(|| format!("{} · {}", s.harness, s.project)),
                TITLE_MAX,
            );
        }
        self.s.state = derive(&self.s, self.facts.turn);
    }

    /// Whether `self` is a live subagent of the top-level record `top`.
    fn is_live_child_of(&self, top: &ObservedSession) -> bool {
        self.is_live()
            && self.s.parent.is_some()
            && self.s.host == top.host
            && self.s.harness == top.harness
            && self.s.session_id == top.session_id
    }
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

/// §3.8.3 State, first match wins.
fn derive(s: &ObservedSession, turn: Turn) -> State {
    match (&s.ended_at, &s.pending, turn) {
        (Some(_), _, _) => State::Exited,
        (_, Some(p), _) if p.kind == PendingKind::Permission => State::WaitingPermission,
        (_, Some(_), _) => State::WaitingInput,
        (_, _, Turn::Running) => State::Running,
        (_, _, Turn::Ended) => State::Done,
        _ => State::Idle,
    }
}

/// `"o_"` and the first 16 hex digits of sha256(`key`).
fn id_of(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("o_{hex}")
}

/// The envelope fields of an event; wrong types count as absent values.
struct Envelope {
    at: u64,
    wb_session: Option<String>,
    attach: Option<Attach>,
    pid: Option<u32>,
    pid_start: Option<u64>,
    project_root: Option<String>,
    git_metadata_present: bool,
    repo_root: Option<String>,
    repo: Option<String>,
    worktree: Option<String>,
    branch: Option<String>,
}

impl Envelope {
    fn read(body: &Map<String, Value>, now_ms: u64) -> Envelope {
        let str_of = |k: &str| body.get(k).and_then(Value::as_str);
        Envelope {
            // Never later than this clock: a sender cannot date its records ahead of
            // the others'.
            at: body
                .get("at")
                .and_then(Value::as_u64)
                .map_or(now_ms, |at| at.min(now_ms)),
            wb_session: str_of("wbSession")
                .filter(|s| crate::util::sanitize_sid(s) == *s && !s.is_empty())
                .map(str::to_owned),
            attach: body
                .get("attach")
                .and_then(|v| Attach::deserialize(v).ok())
                .filter(Attach::valid),
            pid: body
                .get("pid")
                .and_then(Value::as_u64)
                .filter(|p| (1..=i32::MAX as u64).contains(p))
                .map(|p| p as u32),
            pid_start: body.get("pidStart").and_then(Value::as_u64),
            project_root: str_of("projectRoot").map(|s| excerpt(s, OBS_TEXT_MAX)),
            git_metadata_present: ["repoRoot", "repo", "worktree", "branch"]
                .iter()
                .any(|key| body.contains_key(*key)),
            // Reject oversized metadata rather than turn it into a different name.
            repo_root: str_of("repoRoot")
                .filter(|s| s.len() <= OBS_TEXT_MAX)
                .map(str::to_owned),
            repo: str_of("repo")
                .filter(|s| s.len() <= OBS_TEXT_MAX)
                .map(str::to_owned),
            worktree: str_of("worktree")
                .filter(|s| s.len() <= OBS_TEXT_MAX)
                .map(str::to_owned),
            branch: str_of("branch")
                .filter(|s| s.len() <= OBS_TEXT_MAX)
                .map(str::to_owned),
        }
    }
}

/// Whether `harness` matches `^[a-z0-9-]{1,32}$`.
fn valid_harness(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Default)]
struct Inner {
    /// By key, so a parent sorts right before its subagents.
    records: BTreeMap<String, Entry>,
    /// Keys changed since the last drain.
    changed: BTreeSet<String>,
    /// Keys dropped since the last drain, with their ids.
    gone: BTreeMap<String, String>,
    /// Keys a drain or a listing has given out: only these are reported when dropped,
    /// so records that come and go between two drains cost a stream nothing.
    told: BTreeSet<String>,
    unsaved: bool,
}

impl Inner {
    fn touch(&mut self, key: &str) {
        // A record that comes back before its drop was reported is still one a stream
        // may hold.
        if self.gone.remove(key).is_some() {
            self.told.insert(key.to_owned());
        }
        self.changed.insert(key.to_owned());
        self.unsaved = true;
    }

    fn drop_record(&mut self, key: &str) {
        if let Some(e) = self.records.remove(key) {
            self.changed.remove(key);
            if self.told.remove(key) {
                self.gone.insert(key.to_owned(), e.s.id);
            }
            self.unsaved = true;
        }
    }

    /// The record of `host` to drop first: its oldest ended one, else its live one
    /// quiet longest.
    fn victim(&self, host: &str) -> Option<String> {
        let of_host = || self.records.iter().filter(|(_, e)| e.s.host == host);
        let ended = of_host()
            .filter_map(|(k, e)| e.s.ended_at.map(|t| (t, k)))
            .min();
        ended
            .or_else(|| of_host().map(|(k, e)| (e.s.last_at, k)).min())
            .map(|(_, k)| k.clone())
    }

    /// Drops records of `host` until it has at most `max`. A host makes room among
    /// its own records only, so one that sends a flood loses nothing but its own.
    fn shrink(&mut self, host: &str, max: usize) {
        let mut held = self.records.values().filter(|e| e.s.host == host).count();
        while held > max
            && let Some(k) = self.victim(host)
        {
            self.drop_record(&k);
            held -= 1;
        }
    }

    /// Ends the live record `key`, and with a top-level one its live subagents.
    fn end(&mut self, key: &str, reason: EndReason, at: u64) {
        let Some(e) = self.records.get_mut(key).filter(|e| e.is_live()) else {
            return;
        };
        e.s.ended_at = Some(at);
        e.s.end_reason = Some(reason);
        e.s.pending = None;
        e.s.tool = None;
        e.facts.turn = Turn::None;
        e.refresh();
        let top = (e.s.parent.is_none()).then(|| e.s.clone());
        self.touch(key);
        if let Some(top) = top {
            let children: Vec<String> = self
                .records
                .iter()
                .filter(|(_, c)| c.is_live_child_of(&top))
                .map(|(k, _)| k.clone())
                .collect();
            for k in children {
                self.end(&k, EndReason::ParentEnded, at);
            }
        }
    }

    fn apply(&mut self, host: &str, harness: &str, env: Envelope, mut ev: Event) {
        let top_key = format!("{host}/{harness}/{}", ev.session_id);
        let (key, parent_key) = match &ev.agent_id {
            // Neither id holds a `/`, so no two records share a key.
            Some(a) => (format!("{top_key}/{a}"), Some(top_key)),
            None => (top_key, None),
        };
        let at = env.at;
        if !self.records.contains_key(&key) {
            self.shrink(host, OBS_SESSIONS_MAX - 1);
            let s = ObservedSession {
                id: id_of(&key),
                key: key.clone(),
                host: host.to_owned(),
                harness: harness.to_owned(),
                session_id: ev.session_id.clone(),
                parent: parent_key.as_deref().map(id_of),
                agent_type: None,
                wb_session: None,
                attach: None,
                pid: None,
                transcript_path: None,
                cwd: None,
                project_root: None,
                repo_root: None,
                repo: None,
                worktree: None,
                branch: None,
                project: String::new(),
                model: None,
                permission_mode: None,
                title: String::new(),
                state: State::Idle,
                started_at: at,
                last_at: at,
                ended_at: None,
                end_reason: None,
                tool: None,
                pending: None,
                last_prompt: None,
                last_message: None,
                counts: Counts::default(),
                tail: Vec::new(),
            };
            let facts = Facts::default();
            self.records.insert(key.clone(), Entry { s, facts });
        }
        let Some(e) = self.records.get_mut(&key) else {
            return;
        };
        if ev.prompt_notice && e.s.pending.is_some() {
            ev.kind = ObsKind::Note;
        }
        let s = &mut e.s;
        s.last_at = at;
        s.counts.events += 1;
        let take = |slot: &mut Option<String>, v: Option<String>| {
            if v.is_some() {
                *slot = v;
            }
        };
        take(&mut s.cwd, ev.cwd);
        take(&mut s.transcript_path, ev.transcript_path);
        take(&mut s.model, ev.model);
        take(&mut s.permission_mode, ev.permission_mode);
        take(&mut s.agent_type, ev.agent_type);
        take(&mut s.wb_session, env.wb_session);
        take(&mut s.project_root, env.project_root);
        // Reporters send a complete set; older events without any keys retain it.
        if env.git_metadata_present {
            s.repo_root = env.repo_root;
            s.repo = env.repo;
            s.worktree = env.worktree;
            s.branch = env.branch;
        }
        if env.attach.is_some() {
            s.attach = env.attach;
        }
        if env.pid.is_some() {
            s.pid = env.pid;
            e.facts.pid_start = env.pid_start;
        }
        if ev.kind != ObsKind::End && s.ended_at.is_some() {
            s.ended_at = None;
            s.end_reason = None;
        }
        if !matches!(ev.kind, ObsKind::Note | ObsKind::Permission) {
            s.pending = None;
        }
        let mut end = false;
        match ev.kind {
            ObsKind::Start | ObsKind::Note | ObsKind::PermissionDone => {}
            ObsKind::Prompt => {
                e.facts.turn = Turn::Running;
                s.counts.prompts += 1;
                if !e.facts.titled
                    && let Some(line) = ev
                        .text
                        .as_deref()
                        .and_then(|t| t.lines().map(str::trim).find(|l| !l.is_empty()))
                {
                    s.title = excerpt(line, TITLE_MAX);
                    e.facts.titled = true;
                }
                s.last_prompt = ev.text;
            }
            ObsKind::ToolStart => {
                s.tool = ev.tool;
                e.facts.turn = Turn::Running;
            }
            ObsKind::ToolEnd | ObsKind::ToolFail => {
                s.tool = None;
                s.counts.tools += 1;
                if ev.kind == ObsKind::ToolFail {
                    s.counts.tool_failures += 1;
                }
            }
            ObsKind::Permission | ObsKind::Question => {
                let permission = ev.kind == ObsKind::Permission;
                s.pending = Some(Pending {
                    kind: if permission {
                        PendingKind::Permission
                    } else {
                        PendingKind::Question
                    },
                    tool: ev.tool.as_ref().map(|t| t.name.clone()),
                    input: ev.tool.and_then(|t| t.input),
                    message: ev.text,
                    at,
                });
            }
            ObsKind::TurnEnd => {
                e.facts.turn = Turn::Ended;
                s.tool = None;
                take(&mut s.last_message, ev.text);
            }
            ObsKind::SubagentStart => e.facts.turn = Turn::Running,
            ObsKind::SubagentEnd => {
                take(&mut s.last_message, ev.text);
                end = true;
            }
            ObsKind::End => end = true,
        }
        s.tail.push(TailLine {
            at,
            kind: ev.kind,
            text: ev.tail,
        });
        if s.tail.len() > OBS_TAIL {
            let extra = s.tail.len() - OBS_TAIL;
            s.tail.drain(..extra);
        }
        e.refresh();
        let replaces = (ev.kind == ObsKind::Start && e.s.parent.is_none())
            .then(|| e.s.pid.zip(e.facts.pid_start))
            .flatten();
        self.touch(&key);
        if end {
            self.end(&key, EndReason::SessionEnd, at);
        }
        if let Some((pid, start)) = replaces {
            let old: Vec<String> = self
                .records
                .iter()
                .filter(|(k, o)| {
                    **k != key
                        && o.is_live()
                        && o.s.parent.is_none()
                        && o.s.host == host
                        && o.s.harness == harness
                        && o.s.pid == Some(pid)
                        && o.facts.pid_start == Some(start)
                })
                .map(|(k, _)| k.clone())
                .collect();
            for k in old {
                self.end(&k, EndReason::Replaced, at);
            }
        }
        if let Some(pk) = parent_key
            && let Some(p) = self.records.get_mut(&pk)
        {
            p.s.last_at = at;
            if ev.kind == ObsKind::SubagentStart {
                p.s.counts.subagents += 1;
            }
            self.touch(&pk);
        }
    }

    fn sweep(&mut self, host: &str, proc_root: &Path, now_ms: u64) {
        let silent = OBS_SILENT_END.as_millis() as u64;
        let ending: Vec<(String, EndReason)> = self
            .records
            .iter()
            .filter(|(_, e)| e.is_live())
            .filter_map(|(k, e)| {
                let gone = e.s.host == host
                    && e.s
                        .pid
                        .is_some_and(|pid| process_gone(proc_root, pid, e.facts.pid_start));
                if gone {
                    Some((k.clone(), EndReason::ProcessGone))
                } else if now_ms.saturating_sub(e.s.last_at) >= silent {
                    Some((k.clone(), EndReason::Silent))
                } else {
                    None
                }
            })
            .collect();
        for (k, reason) in ending {
            self.end(&k, reason, now_ms);
        }
        let keep = OBS_ENDED_KEEP.as_millis() as u64;
        let expired: Vec<String> = self
            .records
            .iter()
            .filter(|(_, e)| {
                e.s.ended_at
                    .is_some_and(|t| now_ms.saturating_sub(t) >= keep)
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in expired {
            self.drop_record(&k);
        }
    }
}

/// Whether `<proc_root>/<pid>/stat` is gone, or names another start time than `start`.
/// A file that cannot be read for another reason, or parsed, says nothing.
fn process_gone(proc_root: &Path, pid: u32, start: Option<u64>) -> bool {
    match fs::read_to_string(proc_root.join(pid.to_string()).join("stat")) {
        Ok(stat) => start.is_some_and(|start| start_time(&stat).is_some_and(|t| t != start)),
        Err(e) => {
            e.kind() == io::ErrorKind::NotFound
                || e.raw_os_error() == Some(rustix::io::Errno::SRCH.raw_os_error())
        }
    }
}

/// Field 22 of a `/proc/<pid>/stat` line; the command name may hold anything but is
/// closed by the last `)`.
fn start_time(stat: &str) -> Option<u64> {
    let rest = &stat[stat.rfind(')')? + 1..];
    rest.split_whitespace().nth(19)?.parse().ok()
}

#[derive(Deserialize)]
struct FileIn {
    v: u32,
    sessions: Vec<Entry>,
}

#[derive(Serialize)]
struct FileOut<'a> {
    v: u32,
    sessions: Vec<&'a Entry>,
}

struct Shared {
    inner: Mutex<Inner>,
    /// Held across a save, so saves reach the disk in order.
    io: Mutex<()>,
    path: PathBuf,
    host: String,
    proc_root: PathBuf,
}

/// The registry; clones share it.
#[derive(Clone)]
pub struct Registry(Arc<Shared>);

impl Registry {
    /// Loads `<state_dir>/observed.json`, quarantining one that does not parse or has another `v`
    /// (rename to `observed.json.bad-<ms>`, warn, start empty), then runs a sweep at `now_ms`.
    /// `host` is the registry's own host (pid liveness applies only to records of this host);
    /// `proc_root` is `/proc` in production and a fake directory in tests.
    pub fn load(state_dir: &Path, host: &str, proc_root: &Path, now_ms: u64) -> Registry {
        let path = state_dir.join(FILE);
        let mut inner = Inner::default();
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<FileIn>(&bytes) {
                Ok(file) if file.v == FILE_VERSION => {
                    for mut e in file.sessions {
                        e.s.id = id_of(&e.s.key);
                        e.refresh();
                        inner.records.insert(e.s.key.clone(), e);
                    }
                }
                _ => {
                    let bad = state_dir.join(format!("{FILE}.bad-{now_ms}"));
                    match fs::rename(&path, &bad) {
                        Ok(()) => tracing::warn!(
                            "observed: {} is unusable, moved to {}",
                            path.display(),
                            bad.display()
                        ),
                        Err(e) => tracing::warn!(
                            "observed: {} is unusable and could not be moved: {e}",
                            path.display()
                        ),
                    }
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("observed: cannot read {}: {e}", path.display()),
        }
        let hosts: BTreeSet<String> = inner.records.values().map(|e| e.s.host.clone()).collect();
        for host in hosts {
            inner.shrink(&host, OBS_SESSIONS_MAX);
        }
        inner.changed.clear();
        inner.gone.clear();
        let reg = Registry(Arc::new(Shared {
            inner: Mutex::new(inner),
            io: Mutex::new(()),
            path,
            host: host.to_owned(),
            proc_root: proc_root.to_owned(),
        }));
        reg.sweep(now_ms);
        reg
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Folds one event (the whole POST body, already parsed JSON) filed under `host`.
    /// `Err(message)` means 400 with that message and the registry unchanged.
    pub fn ingest(&self, host: &str, event: Value, now_ms: u64) -> Result<(), String> {
        let Value::Object(body) = event else {
            return Err("bad event".into());
        };
        let harness = match body.get("harness").and_then(Value::as_str) {
            Some(h) if valid_harness(h) => h,
            _ => return Err("bad harness".into()),
        };
        let Some(Value::Object(payload)) = body.get("payload") else {
            return Err("bad event".into());
        };
        let ev = normalize(harness, payload)?;
        let env = Envelope::read(&body, now_ms);
        self.lock().apply(host, harness, env, ev);
        Ok(())
    }

    /// Live records first, then by `lastAt`, newest first.
    pub fn list(&self) -> Vec<ObservedSession> {
        let mut inner = self.lock();
        let keys: Vec<String> = inner.records.keys().cloned().collect();
        inner.told.extend(keys);
        let mut all: Vec<ObservedSession> = inner.records.values().map(|e| e.s.clone()).collect();
        drop(inner);
        all.sort_by(|a, b| {
            (a.ended_at.is_some(), b.last_at, &a.id).cmp(&(b.ended_at.is_some(), a.last_at, &b.id))
        });
        all
    }

    pub fn get(&self, id: &str) -> Option<ObservedSession> {
        self.lock()
            .records
            .values()
            .find(|e| e.s.id == id)
            .map(|e| e.s.clone())
    }

    /// The ending rules of §3.8.3.
    pub fn sweep(&self, now_ms: u64) {
        self.lock().sweep(&self.0.host, &self.0.proc_root, now_ms);
    }

    /// The records changed, and those dropped, since the last call (each record at most once, latest state).
    pub fn drain(&self) -> Vec<Change> {
        let mut inner = self.lock();
        let gone = std::mem::take(&mut inner.gone);
        let changed = std::mem::take(&mut inner.changed);
        let mut out: Vec<Change> = gone
            .into_iter()
            .map(|(key, id)| Change::Gone { id, key })
            .collect();
        for key in changed {
            if let Some(e) = inner.records.get(&key) {
                out.push(Change::Upsert(Box::new(e.s.clone())));
                inner.told.insert(key);
            }
        }
        out
    }

    /// Writes `<state_dir>/observed.json` (0600, atomic) if anything changed since the
    /// last save.
    pub fn save(&self) -> io::Result<()> {
        let _io = self.0.io.lock().unwrap_or_else(|e| e.into_inner());
        let data = {
            let mut inner = self.lock();
            if !inner.unsaved {
                return Ok(());
            }
            let file = FileOut {
                v: FILE_VERSION,
                sessions: inner.records.values().collect(),
            };
            let data = serde_json::to_vec(&file).map_err(io::Error::other)?;
            inner.unsaved = false;
            data
        };
        atomic_write(&self.0.path, &data)
            .map(|_| ())
            .inspect_err(|_| {
                self.lock().unsaved = true;
            })
    }
}

#[cfg(test)]
mod tests;
