//! `wb-fake-acp`: a scripted ACP agent for tests, registered as the agent `stub`
//! (DESIGN §9.2). It is test-only and never installed with the hub.
//!
//! ```text
//! wb-fake-acp [--scenario NAME] [--record FILE]
//! ```
//!
//! It speaks ACP v1 (one JSON-RPC object per line) on stdin and stdout, writes nothing
//! before `initialize` arrives, and exits 0 when stdin ends. Unless a scenario says
//! otherwise it advertises `loadSession`, `sessionCapabilities.resume` and two modes,
//! `default` and `plan`; `session/load` replays 50 history chunks and one
//! `available_commands_update` before it answers.
//!
//! **Without `--scenario`** (the ui and VM checks) a prompt runs the script of the first
//! keyword among its words, in this order:
//! - `ask-permission`: a permission request; once an option is selected, `PONG`;
//! - `perm`: a `tool_call`, then a permission request with `allow_once`, `allow_always`
//!   and `reject_once`; the tool call completes or fails with the answer;
//! - `form`: a form elicitation with a string enum (required), an integer (1..=10), a
//!   boolean and a multi-select; the reply quotes the content it received;
//! - `url`: a url elicitation for an https URL (`javascript:alert(1)` when the prompt
//!   also says `javascript`); after `accept`, `elicitation/complete` 1 s later;
//! - `tool`: a `tool_call` going pending, in progress, completed with a diff;
//! - `slow`: a chunk every 200 ms for a minute, so the turn can be cancelled;
//! - `stream`: three chunks of one message;
//! - anything else: one chunk echoing the prompt.
//!
//! The first prompt also titles the session (`session_info_update`), and
//! `session/set_mode` is followed by a `current_mode_update`.
//!
//! **With `--scenario NAME`** (the hub's cargo tests) it plays a script instead, see
//! [`SCENARIOS`]. A prompt in a scenario without its own prompt script streams three
//! chunks; `elicitation` prompts use the keywords.
//!
//! **`--record FILE`** appends one JSON object per line to FILE, each with this
//! process's `pid`: `{"recv": …}` for every line received, `{"sent": …}` for every
//! request sent (written before it is sent), and notes `{"note": "env",
//! "names": […], "SHELL": …, "WB_SESSION": …}` at start, `{"note": "stdin_eof"}`,
//! `{"note": "sigterm"}` and `{"note": "child", "childPid": …}`. Several processes may
//! append to one file.
#![forbid(unsafe_code)]

use std::fs::OpenOptions;
use std::io::{BufRead as _, Stdout, Write as _};
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};
use tokio::time::{Instant, timeout_at};
use wb_proto::limits::MAX_LINE;

const USAGE: &str = "usage: wb-fake-acp [--scenario NAME] [--record FILE]";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    Keywords,
    Basic,
    Noise,
    Permission,
    PermissionReconnect,
    AgentCancels,
    Elicitation,
    Cancel,
    CrashMidturn,
    Auth,
    AuthTerminal,
    ReviveResume,
    ReviveLoad,
    ReviveFail,
    Unknown,
    Version,
    Hang,
    SetMode,
    KillStubborn,
    ReplayLarge,
    CrashLeaveChild,
    SetsidChild,
}

/// The scenarios by name. What each one does differently:
/// - `basic`: nothing; a prompt streams three chunks of one message;
/// - `noise`: before the `initialize` response, stdout gets an ANSI tracing line, a line
///   that is not UTF-8, a line of `MAX_LINE` + 1 MiB and a JSON array; the response
///   itself ends in CRLF;
/// - `permission`, `cancel`: a prompt runs the `perm` script;
/// - `permission-reconnect`: a prompt streams 116 chunks, asks a permission, streams 80
///   more while it is pending (so a fresh session puts it at seq 120 of 200), then waits
///   for the answer;
/// - `agent-cancels`: a prompt asks a permission (string id `perm-<turn>`), withdraws it
///   with `$/cancel_request` and waits for the answer;
/// - `elicitation`: `session/new` needs authentication by the agent-handled method
///   `fake-login`; `authenticate` asks a request-scoped form elicitation (no
///   `sessionId`) and succeeds after `accept`; prompts use the keywords;
/// - `crash-midturn`: a prompt asks a permission, prints `boom` to stderr and exits 1;
/// - `auth`: `session/new` needs authentication by `fake-login` first;
/// - `auth-terminal`: `session/new` always needs authentication; the only method is
///   `type: "terminal"`;
/// - `revive-resume`: the default capabilities;
/// - `revive-load`: no `sessionCapabilities.resume`;
/// - `revive-fail`: `session/resume` and `session/load` fail with -32002;
/// - `unknown`: a prompt sends an unknown `sessionUpdate` variant, asks
///   `fs/read_text_file` (and waits for the answer) and sends an unknown notification;
/// - `version`: `initialize` answers `protocolVersion: 2`;
/// - `hang`: `initialize` is never answered;
/// - `set-mode`: `session/set_mode` sends no `current_mode_update`;
/// - `kill-stubborn`: SIGTERM and the end of stdin are ignored, and a prompt never ends;
/// - `replay-large`: a prompt streams 200 messages of 20 chunks of 5 KiB (about
///   20 MiB), asking a permission after the tenth message; then, until it is answered,
///   an `agent_thought_chunk` "tick" every 50 ms (one minute at most);
/// - `crash-leave-child`: a prompt starts `sleep 1000` in the agent's process group,
///   with the agent's stdout and stderr, and exits 1;
/// - `setsid-child`: a prompt starts `sleep 1000` in a process group of its own, with
///   no stdio, and exits 1.
const SCENARIOS: [(&str, Scenario); 21] = [
    ("basic", Scenario::Basic),
    ("noise", Scenario::Noise),
    ("permission", Scenario::Permission),
    ("permission-reconnect", Scenario::PermissionReconnect),
    ("agent-cancels", Scenario::AgentCancels),
    ("elicitation", Scenario::Elicitation),
    ("cancel", Scenario::Cancel),
    ("crash-midturn", Scenario::CrashMidturn),
    ("auth", Scenario::Auth),
    ("auth-terminal", Scenario::AuthTerminal),
    ("revive-resume", Scenario::ReviveResume),
    ("revive-load", Scenario::ReviveLoad),
    ("revive-fail", Scenario::ReviveFail),
    ("unknown", Scenario::Unknown),
    ("version", Scenario::Version),
    ("hang", Scenario::Hang),
    ("set-mode", Scenario::SetMode),
    ("kill-stubborn", Scenario::KillStubborn),
    ("replay-large", Scenario::ReplayLarge),
    ("crash-leave-child", Scenario::CrashLeaveChild),
    ("setsid-child", Scenario::SetsidChild),
];

const MODES: [(&str, &str, &str); 2] = [
    ("default", "Default", "Asks before acting"),
    ("plan", "Plan", "Plans without acting"),
];

/// Pause between the steps of a `tool` call.
const STEP: Duration = Duration::from_millis(100);
/// `replay-large`: messages, chunks per message, bytes per chunk.
const LARGE_MESSAGES: usize = 200;
const LARGE_CHUNKS: usize = 20;
const LARGE_CHUNK: usize = 5 << 10;
/// `replay-large`: the permission is asked after this many messages.
const LARGE_PIN_AFTER: usize = 10;
/// `replay-large`: interval and number of ticks while the permission is pending.
const TICK: Duration = Duration::from_millis(50);
const LARGE_TICKS: usize = 1200;

struct Args {
    scenario: Scenario,
    record: Option<PathBuf>,
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let mut parsed = Args {
        scenario: Scenario::Keywords,
        record: None,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--scenario" => {
                let name = args.next().ok_or("--scenario needs a name")?;
                parsed.scenario = SCENARIOS
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, s)| *s)
                    .ok_or_else(|| format!("unknown scenario {name:?}"))?;
            }
            "--record" => parsed.record = Some(args.next().ok_or("--record needs a file")?.into()),
            other => return Err(format!("unknown argument {other:?}")),
        }
    }
    Ok(parsed)
}

/// The `--record` file, if any.
#[derive(Clone)]
struct Recorder(Option<PathBuf>);

impl Recorder {
    /// Appends `entry` with this process's pid as one line. Best effort: a test that
    /// needs the record finds out when it reads it.
    fn note(&self, mut entry: Value) {
        let Some(path) = &self.0 else { return };
        entry["pid"] = std::process::id().into();
        let mut line = entry.to_string();
        line.push('\n');
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
}

/// Reads stdin line by line on a thread of its own, so stdin is drained while a script
/// waits or a write blocks. The receiver yields `None` once stdin has ended.
fn read_stdin(rec: Recorder) -> UnboundedReceiver<Value> {
    let (tx, rx) = unbounded_channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut line = Vec::new();
        while matches!(stdin.read_until(b'\n', &mut line), Ok(n) if n > 0) {
            let msg = serde_json::from_slice(&line)
                .unwrap_or_else(|_| json!({"unparsed": String::from_utf8_lossy(&line)}));
            line.clear();
            rec.note(json!({"recv": msg}));
            if tx.send(msg).is_err() {
                return;
            }
        }
        rec.note(json!({"note": "stdin_eof"}));
    });
    rx
}

/// Notes and otherwise ignores every SIGTERM.
fn ignore_sigterm(rec: Recorder) {
    let mut term = signal(SignalKind::terminate()).expect("a SIGTERM handler");
    tokio::spawn(async move {
        while term.recv().await.is_some() {
            rec.note(json!({"note": "sigterm"}));
        }
    });
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(e) => {
            eprintln!("wb-fake-acp: {e}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let rec = Recorder(args.record);
    let mut names: Vec<String> = std::env::vars_os()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect();
    names.sort();
    rec.note(
        json!({"note": "env", "names": names, "SHELL": std::env::var("SHELL").ok(),
                    "WB_SESSION": std::env::var("WB_SESSION").ok()}),
    );
    if args.scenario == Scenario::KillStubborn {
        ignore_sigterm(rec.clone());
    }
    let mut fake = Fake {
        scenario: args.scenario,
        inbox: read_stdin(rec.clone()),
        rec,
        out: std::io::stdout(),
        last_id: 0,
        session: String::new(),
        cwd: "/".to_owned(),
        mode: MODES[0].0.to_owned(),
        authenticated: false,
        titled: false,
        cancelled: false,
        turn: 0,
    };
    loop {
        let msg = fake.recv().await;
        fake.dispatch(msg).await;
    }
}

struct Fake {
    scenario: Scenario,
    rec: Recorder,
    inbox: UnboundedReceiver<Value>,
    out: Stdout,
    /// The id of this agent's last request.
    last_id: u64,
    /// The ACP session: from `session/new`, or adopted from `session/resume`, `load`
    /// or `prompt`.
    session: String,
    cwd: String,
    mode: String,
    authenticated: bool,
    /// The keyword mode titles the session on its first prompt.
    titled: bool,
    /// `session/cancel` arrived during the current turn.
    cancelled: bool,
    /// Prompts so far; names each turn's message, tool call and elicitation ids.
    turn: u64,
}

impl Fake {
    /// The next message; at the end of stdin the process exits (or, `kill-stubborn`,
    /// waits to be killed).
    async fn recv(&mut self) -> Value {
        match self.inbox.recv().await {
            Some(msg) => msg,
            None if self.scenario == Scenario::KillStubborn => std::future::pending().await,
            None => std::process::exit(0),
        }
    }

    /// Serves a message that arrived outside a turn.
    async fn dispatch(&mut self, msg: Value) {
        // Notifications (`session/cancel` with no turn) and stray responses need nothing.
        let (Some(method), Some(id)) = (msg["method"].as_str(), msg.get("id").cloned()) else {
            return;
        };
        let params = &msg["params"];
        match method {
            "initialize" => self.initialize(id),
            "session/new" => self.new_session(id, params),
            "session/load" => self.load(id, params),
            "session/resume" => self.resume(id, params),
            "session/prompt" => {
                let stop = self.prompt(params).await;
                self.reply(id, json!({"stopReason": stop}));
            }
            "session/set_mode" => self.set_mode(id, params),
            "authenticate" => self.authenticate(id, params).await,
            _ => self.error(id, -32601, "Method not found"),
        }
    }

    /// Serves a message that arrived while a script waits.
    fn background(&mut self, msg: Value) {
        match (msg["method"].as_str(), msg.get("id").cloned()) {
            (Some("session/cancel"), None) => self.cancelled = true,
            (Some("session/set_mode"), Some(id)) => self.set_mode(id, &msg["params"]),
            (Some(method), Some(id)) => {
                self.error(id, -32603, &format!("{method} while busy"));
            }
            _ => {}
        }
    }

    fn initialize(&mut self, id: Value) {
        match self.scenario {
            Scenario::Hang => return,
            Scenario::Noise => self.noise(),
            _ => {}
        }
        let mut caps = json!({
            "loadSession": true,
            "promptCapabilities": {"image": false, "audio": false, "embeddedContext": false},
            "sessionCapabilities": {"resume": {}},
        });
        if self.scenario == Scenario::ReviveLoad {
            caps["sessionCapabilities"] = json!({});
        }
        let auth_methods = match self.scenario {
            Scenario::Auth | Scenario::Elicitation => {
                json!([{"id": "fake-login", "name": "Fake login", "description": "Lets anyone in"}])
            }
            Scenario::AuthTerminal => {
                json!([{"id": "fake-terminal", "name": "Log in from a terminal",
                                              "type": "terminal", "args": ["--login"]}])
            }
            _ => json!([]),
        };
        let version = if self.scenario == Scenario::Version {
            2
        } else {
            1
        };
        let result = json!({
            "protocolVersion": version,
            "agentCapabilities": caps,
            "authMethods": auth_methods,
            "agentInfo": {"name": "wb-fake-acp", "title": "Fake agent", "version": env!("CARGO_PKG_VERSION")},
        });
        let mut line = json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string();
        line.push_str(if self.scenario == Scenario::Noise {
            "\r\n"
        } else {
            "\n"
        });
        self.write(line.as_bytes());
    }

    /// The junk `noise` writes before its `initialize` response.
    fn noise(&mut self) {
        self.write(b"\x1b[2m2026-10-11T00:00:00.000Z\x1b[0m \x1b[32m INFO\x1b[0m wb_fake_acp: starting up\n");
        self.write(b"\xff\xfe not UTF-8 \xc3\x28\n");
        let mut huge = vec![b'x'; MAX_LINE + (1 << 20)];
        huge.push(b'\n');
        self.write(&huge);
        self.write(b"[{\"jsonrpc\":\"2.0\",\"method\":\"_fake/batched\"}]\n");
    }

    fn new_session(&mut self, id: Value, params: &Value) {
        self.cwd = params["cwd"].as_str().unwrap_or("/").to_owned();
        let locked = match self.scenario {
            Scenario::Auth | Scenario::Elicitation => !self.authenticated,
            Scenario::AuthTerminal => true,
            _ => false,
        };
        if locked {
            return self.error(id, -32000, "Authentication required");
        }
        self.session = format!("fake-session-{}", std::process::id());
        let result = json!({"sessionId": self.session, "modes": self.modes()});
        self.reply(id, result);
    }

    fn load(&mut self, id: Value, params: &Value) {
        if self.scenario == Scenario::ReviveFail {
            return self.error(id, -32002, "Session not found");
        }
        self.adopt(params);
        for i in 1..=25 {
            self.chunk(
                "user_message_chunk",
                &format!("history-user-{i}"),
                &format!("question {i}"),
            );
            self.chunk(
                "agent_message_chunk",
                &format!("history-agent-{i}"),
                &format!("answer {i}"),
            );
        }
        self.update(json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                {"name": "review", "description": "Review the working tree"},
                {"name": "test", "description": "Run the tests", "input": {"hint": "a test filter"}},
            ],
        }));
        let result = json!({"modes": self.modes()});
        self.reply(id, result);
    }

    fn resume(&mut self, id: Value, params: &Value) {
        if self.scenario == Scenario::ReviveFail {
            return self.error(id, -32002, "Session not found");
        }
        self.adopt(params);
        let result = json!({"modes": self.modes()});
        self.reply(id, result);
    }

    fn adopt(&mut self, params: &Value) {
        if let Some(session) = params["sessionId"].as_str() {
            self.session = session.to_owned();
        }
        if let Some(cwd) = params["cwd"].as_str() {
            self.cwd = cwd.to_owned();
        }
    }

    fn set_mode(&mut self, id: Value, params: &Value) {
        let Some(mode) = params["modeId"]
            .as_str()
            .filter(|m| MODES.iter().any(|(id, _, _)| id == m))
        else {
            return self.error(id, -32602, "Unknown mode");
        };
        self.mode = mode.to_owned();
        self.reply(id, json!({}));
        if self.scenario == Scenario::Keywords {
            let mode = self.mode.clone();
            self.update(json!({"sessionUpdate": "current_mode_update", "currentModeId": mode}));
        }
    }

    async fn authenticate(&mut self, id: Value, params: &Value) {
        let known = params["methodId"] == "fake-login";
        match self.scenario {
            Scenario::Auth if known => {
                self.authenticated = true;
                self.reply(id, json!({}));
            }
            Scenario::Elicitation if known => {
                let answer = self
                    .ask(
                        "elicitation/create",
                        json!({
                            "mode": "form",
                            "requestId": id,
                            "message": "Sign in to the fake agent",
                            "requestedSchema": {
                                "type": "object",
                                "properties": {"token": {"type": "string", "title": "Token", "minLength": 1}},
                                "required": ["token"],
                            },
                        }),
                    )
                    .await;
                if answer["result"]["action"] == "accept" {
                    self.authenticated = true;
                    self.reply(id, json!({}));
                } else {
                    self.error(id, -32000, "Authentication declined");
                }
            }
            _ => self.error(id, -32602, "Unknown authentication method"),
        }
    }

    /// Runs one turn and returns its stop reason.
    async fn prompt(&mut self, params: &Value) -> &'static str {
        self.turn += 1;
        self.cancelled = false;
        if let Some(session) = params["sessionId"].as_str() {
            self.session = session.to_owned();
        }
        let text = prompt_text(&params["prompt"]);
        let stop = match self.scenario {
            Scenario::Keywords | Scenario::Elicitation => self.keyword_turn(&text).await,
            Scenario::Permission | Scenario::Cancel => self.permission_turn().await,
            Scenario::PermissionReconnect => self.reconnect_turn().await,
            Scenario::AgentCancels => self.agent_cancels_turn().await,
            Scenario::CrashMidturn => self.crash_turn(),
            Scenario::Unknown => self.unknown_turn().await,
            Scenario::KillStubborn => self.stubborn_turn().await,
            Scenario::ReplayLarge => self.large_turn().await,
            Scenario::CrashLeaveChild => self.leave_child(false),
            Scenario::SetsidChild => self.leave_child(true),
            _ => self.stream_turn(),
        };
        if self.cancelled { "cancelled" } else { stop }
    }

    async fn keyword_turn(&mut self, text: &str) -> &'static str {
        if self.scenario == Scenario::Keywords && !self.titled {
            self.titled = true;
            let title: String = text.lines().next().unwrap_or("").chars().take(60).collect();
            self.update(json!({"sessionUpdate": "session_info_update", "title": title}));
        }
        let words = words(text);
        let has = |k: &str| words.iter().any(|w| w == k);
        if has("ask-permission") {
            self.ask_permission_turn().await
        } else if has("perm") {
            self.permission_turn().await
        } else if has("form") {
            self.form_turn().await
        } else if has("url") {
            self.url_turn(has("javascript")).await
        } else if has("tool") {
            self.tool_turn().await
        } else if has("slow") {
            self.slow_turn().await
        } else if has("stream") {
            self.stream_turn()
        } else {
            let reply = format!("echo: {text}");
            self.say(&reply);
            "end_turn"
        }
    }

    fn stream_turn(&mut self) -> &'static str {
        let id = self.message_id();
        for part in ["Streaming ", "three ", "chunks."] {
            self.chunk("agent_message_chunk", &id, part);
        }
        "end_turn"
    }

    async fn tool_turn(&mut self) -> &'static str {
        let call = format!("tool-{}", self.turn);
        let path = format!("{}/notes.txt", self.cwd.trim_end_matches('/'));
        self.update(json!({
            "sessionUpdate": "tool_call", "toolCallId": call, "title": "Edit notes.txt",
            "kind": "edit", "status": "pending", "locations": [{"path": path}], "rawInput": {"path": path},
        }));
        self.pause(STEP).await;
        self.update(json!({"sessionUpdate": "tool_call_update", "toolCallId": call, "status": "in_progress"}));
        self.pause(STEP).await;
        self.update(json!({
            "sessionUpdate": "tool_call_update", "toolCallId": call, "status": "completed",
            "content": [{"type": "diff", "path": path,
                         "oldText": "alpha\nbeta\ngamma\n", "newText": "alpha\nBETA\ngamma\ndelta\n"}],
        }));
        self.say("Edited notes.txt.");
        "end_turn"
    }

    async fn permission_turn(&mut self) -> &'static str {
        let call = format!("call-{}", self.turn);
        let tool = json!({"toolCallId": call, "title": "Run `rm -rf build`", "kind": "execute", "status": "pending"});
        let mut announce = tool.clone();
        announce["sessionUpdate"] = "tool_call".into();
        announce["rawInput"] = json!({"command": "rm -rf build"});
        self.update(announce);
        let params = self.permission_params(tool);
        let answer = self.ask("session/request_permission", params).await;
        let (status, text, stop) = match selected(&answer) {
            Some("allow-once" | "allow-always") => ("completed", "Ran `rm -rf build`.", "end_turn"),
            Some(_) => ("failed", "Did not run `rm -rf build`.", "end_turn"),
            None => ("failed", "Cancelled.", "cancelled"),
        };
        self.update(
            json!({"sessionUpdate": "tool_call_update", "toolCallId": call, "status": status}),
        );
        self.say(text);
        stop
    }

    async fn ask_permission_turn(&mut self) -> &'static str {
        let tool = json!({"toolCallId": format!("call-{}", self.turn), "title": "Reply with PONG",
                          "kind": "think", "status": "pending"});
        let params = self.permission_params(tool);
        let answer = self.ask("session/request_permission", params).await;
        if selected(&answer).is_none() {
            return "cancelled";
        }
        self.say("PONG");
        "end_turn"
    }

    async fn form_turn(&mut self) -> &'static str {
        let params = json!({
            "sessionId": self.session,
            "mode": "form",
            "message": "Pick the build settings",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "colour": {"type": "string", "title": "Colour", "enum": ["red", "green", "blue"]},
                    "count": {"type": "integer", "title": "Count", "minimum": 1, "maximum": 10},
                    "verbose": {"type": "boolean", "title": "Verbose"},
                    "targets": {"type": "array", "title": "Targets",
                                "items": {"type": "string", "enum": ["x86_64", "aarch64", "riscv64"]}},
                },
                "required": ["colour"],
            },
        });
        let answer = self.ask("elicitation/create", params).await;
        let result = &answer["result"];
        let text = match result["action"].as_str() {
            Some("accept") => format!("form accept: {}", result["content"]),
            Some(action) => format!("form {action}"),
            None => format!("form failed: {}", answer["error"]),
        };
        self.say(&text);
        "end_turn"
    }

    async fn url_turn(&mut self, hostile: bool) -> &'static str {
        let id = format!("elicit-{}", self.turn);
        let url = if hostile {
            "javascript:alert(1)"
        } else {
            "https://example.org/wb-fake-acp/consent"
        };
        let params = json!({"sessionId": self.session, "mode": "url", "elicitationId": id,
                            "url": url, "message": "Open the consent page"});
        let answer = self.ask("elicitation/create", params).await;
        let action = answer["result"]["action"]
            .as_str()
            .unwrap_or("failed")
            .to_owned();
        if action == "accept" {
            self.pause(Duration::from_secs(1)).await;
            self.notify("elicitation/complete", json!({"elicitationId": id}));
        }
        self.say(&format!("url {action}"));
        "end_turn"
    }

    async fn slow_turn(&mut self) -> &'static str {
        let id = self.message_id();
        for i in 1..=300 {
            if self.cancelled {
                break;
            }
            self.chunk("agent_message_chunk", &id, &format!("slow {i}. "));
            self.pause(Duration::from_millis(200)).await;
        }
        "end_turn"
    }

    async fn reconnect_turn(&mut self) -> &'static str {
        for i in 1..=116 {
            self.chunk(
                "agent_message_chunk",
                &format!("m{i}"),
                &format!("before {i}"),
            );
        }
        let tool = json!({"toolCallId": format!("call-{}", self.turn), "title": "Run `make check`",
                          "kind": "execute", "status": "pending"});
        let params = self.permission_params(tool);
        let id = self.request("session/request_permission", params);
        for i in 117..=196 {
            self.chunk(
                "agent_message_chunk",
                &format!("m{i}"),
                &format!("after {i}"),
            );
        }
        let answer = self.await_response(&id).await;
        if selected(&answer).is_none() {
            return "cancelled";
        }
        "end_turn"
    }

    async fn agent_cancels_turn(&mut self) -> &'static str {
        let id = json!(format!("perm-{}", self.turn));
        let tool = json!({"toolCallId": format!("call-{}", self.turn), "title": "Delete the cache",
                          "kind": "delete", "status": "pending"});
        let params = self.permission_params(tool);
        self.request_as(id.clone(), "session/request_permission", params);
        self.notify("$/cancel_request", json!({"requestId": id}));
        self.await_response(&id).await;
        self.say("Withdrew the question.");
        "end_turn"
    }

    fn crash_turn(&mut self) -> &'static str {
        let tool = json!({"toolCallId": format!("call-{}", self.turn), "title": "Run `make`",
                          "kind": "execute", "status": "pending"});
        let params = self.permission_params(tool);
        self.request("session/request_permission", params);
        eprintln!("boom");
        std::process::exit(1)
    }

    async fn unknown_turn(&mut self) -> &'static str {
        self.update(json!({"sessionUpdate": "fake_future_update", "detail": {"answer": 42}}));
        let path = format!("{}/README.md", self.cwd.trim_end_matches('/'));
        let params = json!({"sessionId": self.session, "path": path});
        let answer = self.ask("fs/read_text_file", params).await;
        self.notify("_fake/unknown_notice", json!({"note": "drop me"}));
        self.say(&format!("fs/read_text_file: {}", answer["error"]["code"]));
        "end_turn"
    }

    async fn stubborn_turn(&mut self) -> &'static str {
        self.say("Working; this turn never ends.");
        loop {
            let msg = self.recv().await;
            self.background(msg);
        }
    }

    async fn large_turn(&mut self) -> &'static str {
        let mut asked = None;
        for m in 0..LARGE_MESSAGES {
            if m == LARGE_PIN_AFTER {
                let tool = json!({"toolCallId": format!("call-{}", self.turn), "title": "Run `make dist`",
                                  "kind": "execute", "status": "pending"});
                let params = self.permission_params(tool);
                asked = Some(self.request("session/request_permission", params));
            }
            let id = format!("big-{m}");
            for c in 0..LARGE_CHUNKS {
                self.chunk("agent_message_chunk", &id, &large_text(m, c));
            }
        }
        let asked = asked.expect("LARGE_PIN_AFTER < LARGE_MESSAGES");
        for _ in 0..LARGE_TICKS {
            match timeout_at(Instant::now() + TICK, self.inbox.recv()).await {
                Err(_) => self.chunk("agent_thought_chunk", "tick", "."),
                Ok(Some(msg)) if is_response(&msg, &asked) => {
                    return if selected(&msg).is_some() {
                        "end_turn"
                    } else {
                        "cancelled"
                    };
                }
                Ok(Some(msg)) => self.background(msg),
                Ok(None) => {
                    self.recv().await;
                }
            }
        }
        "end_turn"
    }

    fn leave_child(&self, own_group: bool) -> &'static str {
        let mut cmd = Command::new("sleep");
        cmd.arg("1000").stdin(Stdio::null());
        if own_group {
            cmd.process_group(0)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
        }
        match cmd.spawn() {
            Ok(child) => self
                .rec
                .note(json!({"note": "child", "childPid": child.id()})),
            Err(e) => eprintln!("wb-fake-acp: sleep: {e}"),
        }
        std::process::exit(1)
    }

    fn modes(&self) -> Value {
        let available: Vec<Value> = MODES
            .iter()
            .map(|(id, name, description)| json!({"id": id, "name": name, "description": description}))
            .collect();
        json!({"currentModeId": self.mode, "availableModes": available})
    }

    fn permission_params(&self, tool: Value) -> Value {
        json!({
            "sessionId": self.session,
            "toolCall": tool,
            "options": [
                {"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
                {"optionId": "allow-always", "name": "Always allow", "kind": "allow_always"},
                {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
            ],
        })
    }

    fn message_id(&self) -> String {
        format!("msg-{}", self.turn)
    }

    /// One chunk of this turn's agent message.
    fn say(&mut self, text: &str) {
        let id = self.message_id();
        self.chunk("agent_message_chunk", &id, text);
    }

    fn chunk(&mut self, kind: &str, message_id: &str, text: &str) {
        self.update(json!({"sessionUpdate": kind, "messageId": message_id,
                           "content": {"type": "text", "text": text}}));
    }

    /// Waits `d` while serving other messages; returns early once the turn is
    /// cancelled.
    async fn pause(&mut self, d: Duration) {
        let deadline = Instant::now() + d;
        while !self.cancelled {
            match timeout_at(deadline, self.inbox.recv()).await {
                Err(_) => return,
                Ok(Some(msg)) => self.background(msg),
                Ok(None) => {
                    self.recv().await;
                }
            }
        }
    }

    /// Sends a request and waits for its response, serving other messages meanwhile.
    async fn ask(&mut self, method: &str, params: Value) -> Value {
        let id = self.request(method, params);
        self.await_response(&id).await
    }

    /// Sends a request with the next integer id and returns the id.
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.last_id += 1;
        let id = json!(self.last_id);
        self.request_as(id.clone(), method, params);
        id
    }

    /// Sends and records a request with the given id.
    fn request_as(&mut self, id: Value, method: &str, params: Value) {
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        self.rec.note(json!({"sent": msg}));
        self.send(msg);
    }

    async fn await_response(&mut self, id: &Value) -> Value {
        loop {
            let msg = self.recv().await;
            if is_response(&msg, id) {
                return msg;
            }
            self.background(msg);
        }
    }

    fn update(&mut self, update: Value) {
        let params = json!({"sessionId": self.session, "update": update});
        self.notify("session/update", params);
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    fn reply(&mut self, id: Value, result: Value) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn error(&mut self, id: Value, code: i64, message: &str) {
        self.send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    }

    fn send(&mut self, msg: Value) {
        let mut line = msg.to_string();
        line.push('\n');
        self.write(line.as_bytes());
    }

    /// Writes and flushes, blocking while the pipe is full as a real agent would; a
    /// closed stdout ends the process.
    fn write(&mut self, bytes: &[u8]) {
        let mut out = self.out.lock();
        if out.write_all(bytes).is_err() || out.flush().is_err() {
            std::process::exit(0);
        }
    }
}

fn is_response(msg: &Value, id: &Value) -> bool {
    msg.get("method").is_none() && msg.get("id") == Some(id)
}

/// The option a permission answer selected; `None` for cancelled or an error.
fn selected(answer: &Value) -> Option<&str> {
    let outcome = &answer["result"]["outcome"];
    if outcome["outcome"] == "selected" {
        outcome["optionId"].as_str()
    } else {
        None
    }
}

/// The text blocks of a prompt, one per line.
fn prompt_text(blocks: &Value) -> String {
    blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The words of a prompt, lowercased, without surrounding punctuation (hyphens kept).
fn words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-')
                .to_lowercase()
        })
        .collect()
}

/// `replay-large`: chunk `c` of message `m`, `LARGE_CHUNK` bytes starting `[mmm.cc]`.
fn large_text(m: usize, c: usize) -> String {
    let mut text = format!("[{m:03}.{c:02}]");
    text.extend(std::iter::repeat_n('x', LARGE_CHUNK - text.len()));
    text
}
