//! The test harness: the real wb-web binary, a client that plays Caddy in front of it,
//! and a fake hub speaking the hub protocol on a unix socket.
// Each test crate uses a different part of this module.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex, mpsc as std_mpsc};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, Stream, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpSocket, TcpStream, UnixListener, UnixStream};
use tokio::sync::{mpsc, watch};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{WebSocketStream, client_async};
use tokio_util::codec::{FramedRead, LinesCodec};
use wb_proto::hub::{
    Agent, CaptureReply, ErrorCode, Exit, ExitReason, Fg, HubMessage, HubRequest, Kind, PROTO,
    PtyFacts, PtyOpenReply, SessionsReply, Summary,
};
use wb_proto::limits::MAX_LINE;
use wb_proto::line;

pub const SECRET: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
pub const HOST: &str = "wb.example.org";
pub const ORIGIN: &str = "http://wb.example.org";
/// The fake hub's default shell; never run, the fake hub only records the argv.
pub const DEFAULT_SHELL: &str = "bash";
pub const INDEX: &str = "<!doctype html><title>t</title>";
pub const CONSOLE: &str = "<!doctype html><title>Edwin</title>";
pub const SCM: &str = "(define (f x) x)\n";
pub const WAIT: Duration = Duration::from_secs(10);

pub type Ws = WebSocketStream<TcpStream>;

/// A config for a wb-web under `dir`, with the secret file and web root written.
pub fn fixture(dir: &Path, hub_socket: &Path) -> Value {
    std::fs::write(dir.join("secret"), format!("{SECRET}\n")).unwrap();
    std::fs::create_dir(dir.join("web")).unwrap();
    std::fs::write(dir.join("web/index.html"), INDEX).unwrap();
    std::fs::write(dir.join("web/app.js"), "let x = 1;\n").unwrap();
    // The Edwin console as nix/web.nix lays it out (edwind spec R9.19).
    std::fs::create_dir_all(dir.join("web/edwin/scm")).unwrap();
    std::fs::create_dir_all(dir.join("web/edwin/src")).unwrap();
    std::fs::write(dir.join("web/edwin/index.html"), CONSOLE).unwrap();
    std::fs::write(dir.join("web/edwin/src/scheme.js"), "let s = 2;\n").unwrap();
    std::fs::write(dir.join("web/edwin/scm/emacs.scm"), SCM).unwrap();
    json!({
        "listen": "127.0.0.1:0",
        "publicOrigin": ORIGIN,
        "trustedProxy": "127.0.0.1",
        "proxySecretFile": dir.join("secret"),
        "hubSocket": hub_socket,
        "stateDir": dir.join("state"),
        "webRoot": dir.join("web"),
        "boardsDir": dir.join("boards"),
        "notesDir": dir.join("notes"),
        "host": "testhost",
    })
}

/// Runs wb-web with `args` to completion; returns its status and stderr.
pub fn run_to_exit(args: &[&str]) -> (ExitStatus, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_wb-web"))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (
        out.status,
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

/// A running wb-web.
pub struct Web {
    child: Child,
    pub addr: SocketAddr,
    pub dir: tempfile::TempDir,
    log: Arc<Mutex<String>>,
}

impl Web {
    pub fn start(hub_socket: &Path) -> Web {
        Web::start_with(hub_socket, |_| {})
    }

    /// Starts wb-web with the fixture config after `edit`, and waits until it listens.
    pub fn start_with(hub_socket: &Path, edit: impl FnOnce(&mut Value)) -> Web {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = fixture(dir.path(), hub_socket);
        edit(&mut cfg);
        let cfg_path = dir.path().join("web.json");
        std::fs::write(&cfg_path, cfg.to_string()).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_wb-web"))
            .arg("--config")
            .arg(&cfg_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stderr = child.stderr.take().unwrap();
        let log = Arc::new(Mutex::new(String::new()));
        let (tx, rx) = std_mpsc::channel();
        let sink = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if let Some(addr) = line.split("listening on ").nth(1) {
                    let _ = tx.send(addr.trim().to_owned());
                }
                let mut log = sink.lock().unwrap();
                log.push_str(&line);
                log.push('\n');
            }
        });
        let addr = match rx.recv_timeout(WAIT) {
            Ok(addr) => addr.parse().unwrap(),
            Err(_) => {
                let _ = child.kill();
                panic!("wb-web did not start:\n{}", log.lock().unwrap());
            }
        };
        Web {
            child,
            addr,
            dir,
            log,
        }
    }

    /// Everything wb-web wrote to stderr so far.
    pub fn log(&self) -> String {
        self.log.lock().unwrap().clone()
    }

    /// Waits until stderr holds `n` lines containing `needle`; returns all of stderr.
    pub async fn wait_log(&self, needle: &str, n: usize) -> String {
        let started = Instant::now();
        loop {
            let log = self.log();
            if log.lines().filter(|l| l.contains(needle)).count() >= n {
                return log;
            }
            assert!(
                started.elapsed() < WAIT,
                "{needle:?} not logged {n} times:\n{log}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn sigterm(&self) {
        let pid = rustix::process::Pid::from_child(&self.child);
        rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
    }

    /// Waits for wb-web to exit by itself.
    pub async fn wait_exit(&mut self) -> ExitStatus {
        let started = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(started.elapsed() < WAIT, "wb-web did not exit");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// A request as Caddy forwards it: secret and Host set, and Origin on anything but
    /// GET and HEAD.
    pub fn req(&self, method: &str, path: &str) -> Req {
        let mut headers = vec![
            ("Host".to_owned(), HOST.to_owned()),
            ("X-Workbench-Proxy-Secret".to_owned(), SECRET.to_owned()),
        ];
        if method != "GET" && method != "HEAD" {
            headers.push(("Origin".to_owned(), ORIGIN.to_owned()));
        }
        Req {
            addr: self.addr,
            method: method.to_owned(),
            path: path.to_owned(),
            headers,
            body: Vec::new(),
            source: None,
        }
    }

    /// Opens a WebSocket with the headers Caddy and a browser would send.
    pub async fn ws(&self, path: &str) -> Ws {
        self.ws_with(path, &[]).await.unwrap()
    }

    /// Opens a WebSocket; each `(name, None)` removes a default header, each
    /// `(name, Some(v))` sets one.
    pub async fn ws_with(&self, path: &str, edits: &[(&str, Option<&str>)]) -> Result<Ws, WsError> {
        let mut req = format!("ws://{HOST}{path}").into_client_request().unwrap();
        let h = req.headers_mut();
        h.insert("origin", ORIGIN.parse().unwrap());
        h.insert("x-workbench-proxy-secret", SECRET.parse().unwrap());
        for (name, value) in edits {
            let name = HeaderName::from_bytes(name.as_bytes()).unwrap();
            match value {
                Some(v) => {
                    h.insert(name, v.parse().unwrap());
                }
                None => {
                    h.remove(name);
                }
            }
        }
        let tcp = TcpStream::connect(self.addr).await.unwrap();
        let (ws, _) = timeout(WAIT, client_async(req, tcp)).await.unwrap()?;
        Ok(ws)
    }

    /// Waits until `/rpc` reports the hub with `status`; returns that message.
    pub async fn wait_hub(&self, status: &str) -> Value {
        let mut rpc = self.ws("/rpc").await;
        loop {
            let msg = next_json(&mut rpc).await;
            if msg["t"] == "hub" && msg["status"] == status {
                return msg;
            }
        }
    }
}

impl Drop for Web {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A raw HTTP/1.1 request, so tests control every header and the target form.
pub struct Req {
    addr: SocketAddr,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    source: Option<IpAddr>,
}

impl Req {
    /// Replaces every header named `name`.
    pub fn set(self, name: &str, value: &str) -> Req {
        self.without(name).add(name, value)
    }

    /// Adds a header, keeping any of the same name.
    pub fn add(mut self, name: &str, value: &str) -> Req {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn without(mut self, name: &str) -> Req {
        self.headers.retain(|(n, _)| !n.eq_ignore_ascii_case(name));
        self
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Req {
        self.body = body.into();
        self
    }

    /// Connects from `ip` instead of 127.0.0.1.
    pub fn from(mut self, ip: &str) -> Req {
        self.source = Some(ip.parse().unwrap());
        self
    }

    pub async fn send(self) -> Resp {
        let mut stream = match self.source {
            Some(ip) => {
                let socket = TcpSocket::new_v4().unwrap();
                socket.bind(SocketAddr::new(ip, 0)).unwrap();
                socket.connect(self.addr).await.unwrap()
            }
            None => TcpStream::connect(self.addr).await.unwrap(),
        };
        let mut head = format!("{} {} HTTP/1.1\r\n", self.method, self.path);
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str(&format!(
            "Content-Length: {}\r\nConnection: close\r\n\r\n",
            self.body.len()
        ));
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(&self.body).await.unwrap();
        let mut raw = Vec::new();
        timeout(WAIT, stream.read_to_end(&mut raw))
            .await
            .unwrap()
            .unwrap();
        Resp::parse(&raw)
    }
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Resp {
    fn parse(raw: &[u8]) -> Resp {
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or_else(|| panic!("no header end in {:?}", String::from_utf8_lossy(raw)));
        let head = std::str::from_utf8(&raw[..split]).unwrap();
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers: Vec<(String, String)> = lines
            .map(|l| {
                let (n, v) = l.split_once(':').unwrap();
                (n.to_ascii_lowercase(), v.trim().to_owned())
            })
            .collect();
        assert!(
            !headers.iter().any(|(n, _)| n == "transfer-encoding"),
            "chunked responses are not parsed"
        );
        Resp {
            status,
            headers,
            body: raw[split + 4..].to_vec(),
        }
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|e| panic!("{e}: {:?}", String::from_utf8_lossy(&self.body)))
    }
}

pub async fn send_json(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into())).await.unwrap();
}

/// The next text message as JSON; pings and pongs are skipped.
pub async fn next_json<S>(ws: &mut S) -> Value
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    loop {
        match timeout(WAIT, ws.next()).await.expect("no message") {
            Some(Ok(Message::Text(t))) => return serde_json::from_str(t.as_str()).unwrap(),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("expected a text message, got {other:?}"),
        }
    }
}

/// Reads up to the close frame and returns its code; text messages before it are
/// returned too.
pub async fn read_to_close<S>(ws: &mut S) -> (u16, Vec<Value>)
where
    S: Stream<Item = Result<Message, WsError>> + Unpin,
{
    let mut texts = Vec::new();
    loop {
        match timeout(WAIT, ws.next()).await.expect("no close frame") {
            Some(Ok(Message::Close(Some(frame)))) => return (frame.code.into(), texts),
            Some(Ok(Message::Text(t))) => texts.push(serde_json::from_str(t.as_str()).unwrap()),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}

/// A PTY Summary: `running` puts a non-leader group in front, so the state is
/// `running`, else `idle`; a dead one is `exited`.
pub fn pty_summary(sid: &str, epoch: u64, alive: bool, running: bool) -> Summary {
    Summary {
        sid: sid.into(),
        kind: Kind::Pty,
        host: "testhost".into(),
        created_at: epoch,
        updated_at: epoch + 1,
        alive,
        viewers: 0,
        cwd: "/home/alice".into(),
        fault: None,
        pty: Some(PtyFacts {
            argv: vec!["/bin/bash".into(), "-i".into()],
            pid: alive.then_some(4242),
            fg: (alive && running).then(|| Fg {
                comm: "make".into(),
                pgid: 4300,
                leader: false,
            }),
            exit: (!alive).then_some(Exit {
                code: Some(0),
                signal: None,
                reason: ExitReason::Exited,
                at: epoch + 1,
            }),
        }),
        acp: None,
    }
}

/// What the fake hub's hello announces.
#[derive(Clone)]
pub struct Hello {
    pub proto: u32,
    pub version: String,
    pub build: Option<String>,
    pub agents: Vec<Agent>,
    pub shells: Vec<String>,
    pub default_shell: String,
}

impl Default for Hello {
    fn default() -> Hello {
        Hello {
            proto: PROTO,
            version: "0.1.0".into(),
            build: None,
            agents: Vec::new(),
            shells: vec![DEFAULT_SHELL.into(), "zsh".into()],
            default_shell: DEFAULT_SHELL.into(),
        }
    }
}

/// What the fake hub answers to the next `pty.capture`; `Ok("")` when nothing was
/// scripted.
pub type CaptureResult = Result<&'static str, (ErrorCode, &'static str)>;

/// What the fake hub answers to the next `pty.open`.
pub enum OpenReply {
    Ok(PtyOpenReply),
    Err(ErrorCode, &'static str),
    /// The reply, after a pause in which the connection reads nothing.
    Late(Duration, PtyOpenReply),
}

/// The reply to an open when nothing else was scripted: a fresh spawn.
pub fn spawned() -> PtyOpenReply {
    PtyOpenReply {
        new: true,
        pid: Some(4242),
        cwd: "/home/alice".into(),
        exit: None,
        epoch: 1_700_000_000_000,
        stream: 1,
        out: 0,
        resumed: false,
        replay: None,
    }
}

enum Inject {
    Line(HubMessage),
    Close,
}

type Requests = watch::Sender<Vec<(usize, HubRequest)>>;

/// The scripted answers every connection shares.
#[derive(Default)]
struct Script {
    sessions: Mutex<Vec<Summary>>,
    opens: Mutex<VecDeque<OpenReply>>,
    captures: Mutex<VecDeque<CaptureResult>>,
}

/// A hub on a unix socket. Connections are numbered from 0 in accept order; every
/// request is recorded with its connection number.
pub struct FakeHub {
    pub path: PathBuf,
    _dir: tempfile::TempDir,
    requests: watch::Receiver<Vec<(usize, HubRequest)>>,
    conns: Arc<Mutex<Vec<mpsc::UnboundedSender<Inject>>>>,
    script: Arc<Script>,
    accept: tokio::task::JoinHandle<()>,
}

impl FakeHub {
    pub fn start() -> FakeHub {
        FakeHub::start_with(Hello::default())
    }

    /// A hub whose hello announces `proto`.
    pub fn start_with_proto(proto: u32) -> FakeHub {
        FakeHub::start_with(Hello {
            proto,
            ..Hello::default()
        })
    }

    /// A hub whose hello says `hello`.
    pub fn start_with(hello: Hello) -> FakeHub {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hub.sock");
        FakeHub::listen(dir, path, hello)
    }

    /// A hub on a path chosen before it starts, for a web that is already running.
    pub fn start_at(dir: tempfile::TempDir, path: PathBuf) -> FakeHub {
        FakeHub::listen(dir, path, Hello::default())
    }

    fn listen(dir: tempfile::TempDir, path: PathBuf, hello: Hello) -> FakeHub {
        let listener = UnixListener::bind(&path).unwrap();
        let (record, requests) = watch::channel(Vec::new());
        let record = Arc::new(record);
        let conns = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(Script::default());
        let accept = tokio::spawn({
            let conns = conns.clone();
            let script = script.clone();
            async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    let (tx, rx) = mpsc::unbounded_channel();
                    let id = {
                        let mut conns = conns.lock().unwrap();
                        conns.push(tx);
                        conns.len() - 1
                    };
                    let conn = serve(
                        id,
                        stream,
                        hello.clone(),
                        record.clone(),
                        rx,
                        script.clone(),
                    );
                    tokio::spawn(conn);
                }
            }
        });
        FakeHub {
            path,
            _dir: dir,
            requests,
            conns,
            script,
            accept,
        }
    }

    /// Every request so far.
    pub fn requests(&self) -> Vec<(usize, HubRequest)> {
        self.requests.borrow().clone()
    }

    /// Waits until `n` recorded requests match `pred`; returns all that match.
    pub async fn wait_count(
        &self,
        n: usize,
        pred: impl Fn(&HubRequest) -> bool,
    ) -> Vec<(usize, HubRequest)> {
        let mut rx = self.requests.clone();
        let matching = |all: &Vec<(usize, HubRequest)>| -> Vec<(usize, HubRequest)> {
            all.iter().filter(|(_, r)| pred(r)).cloned().collect()
        };
        let all = timeout(WAIT, rx.wait_for(|all| matching(all).len() >= n))
            .await
            .expect("hub requests did not arrive")
            .unwrap()
            .clone();
        matching(&all)
    }

    /// Waits for the first request matching `pred`.
    pub async fn wait_for(&self, pred: impl Fn(&HubRequest) -> bool) -> (usize, HubRequest) {
        self.wait_count(1, pred).await.remove(0)
    }

    pub fn send(&self, conn: usize, msg: HubMessage) {
        self.conns.lock().unwrap()[conn]
            .send(Inject::Line(msg))
            .unwrap();
    }

    /// Closes connection `conn` from the hub side.
    pub fn close(&self, conn: usize) {
        let _ = self.conns.lock().unwrap()[conn].send(Inject::Close);
    }

    /// Scripts the reply to the next `pty.open`.
    pub fn reply_next_open(&self, reply: OpenReply) {
        self.script.opens.lock().unwrap().push_back(reply);
    }

    /// Scripts the reply to the next `pty.capture`.
    pub fn reply_next_capture(&self, reply: CaptureResult) {
        self.script.captures.lock().unwrap().push_back(reply);
    }

    /// The sessions later `watch` and `list` replies carry.
    pub fn set_sessions(&self, sessions: Vec<Summary>) {
        *self.script.sessions.lock().unwrap() = sessions;
    }

    /// Stops accepting and closes every connection; the socket file is removed.
    pub fn stop(&self) {
        self.accept.abort();
        for conn in self.conns.lock().unwrap().iter() {
            let _ = conn.send(Inject::Close);
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for FakeHub {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn serve(
    id: usize,
    stream: UnixStream,
    hello: Hello,
    record: Arc<Requests>,
    mut inject: mpsc::UnboundedReceiver<Inject>,
    script: Arc<Script>,
) {
    let (rx, mut tx) = stream.into_split();
    let mut lines = FramedRead::new(rx, LinesCodec::new_with_max_length(MAX_LINE));
    let hello = HubMessage::Hello {
        proto: hello.proto,
        server: "wb-hub".into(),
        version: hello.version,
        build: hello.build,
        host: "testhost".into(),
        pid: 1,
        started_at: 1_700_000_000_000,
        agents: hello.agents,
        shells: hello.shells,
        default_shell: hello.default_shell,
    };
    if tx.write_all(&line::encode(&hello)).await.is_err() {
        return;
    }
    loop {
        let reply = tokio::select! {
            line = lines.next() => {
                let Some(Ok(line)) = line else { return };
                let req: HubRequest = serde_json::from_str(&line).unwrap();
                record.send_modify(|all| all.push((id, req.clone())));
                match req {
                    HubRequest::Watch { rid } | HubRequest::List { rid } => {
                        let sessions = script.sessions.lock().unwrap().clone();
                        HubMessage::ok(rid, &SessionsReply { sessions })
                    }
                    HubRequest::PtyCapture { rid, .. } => {
                        let scripted = script.captures.lock().unwrap().pop_front();
                        match scripted.unwrap_or(Ok("")) {
                            Ok(text) => HubMessage::ok(rid, &CaptureReply { text: text.into() }),
                            Err((code, message)) => HubMessage::Err {
                                rid: Some(rid),
                                sid: None,
                                code,
                                message: message.into(),
                            },
                        }
                    }
                    HubRequest::PtyOpen { rid, .. } => {
                        let scripted = script.opens.lock().unwrap().pop_front();
                        match scripted {
                            Some(OpenReply::Err(code, message)) => HubMessage::Err {
                                rid: Some(rid),
                                sid: None,
                                code,
                                message: message.into(),
                            },
                            Some(OpenReply::Ok(reply)) => HubMessage::ok(rid, &reply),
                            Some(OpenReply::Late(pause, reply)) => {
                                tokio::time::sleep(pause).await;
                                HubMessage::ok(rid, &reply)
                            }
                            None => HubMessage::ok(rid, &spawned()),
                        }
                    }
                    HubRequest::PtyDetach { rid, .. } | HubRequest::PtyKill { rid, .. } => {
                        HubMessage::ok(rid, &json!({}))
                    }
                    _ => continue,
                }
            }
            msg = inject.recv() => match msg {
                Some(Inject::Line(msg)) => msg,
                Some(Inject::Close) | None => return,
            },
        };
        if tx.write_all(&line::encode(&reply)).await.is_err() {
            return;
        }
    }
}

/// What the fake edwind's `status` command answers unless a test scripts another.
pub fn edit_status() -> Value {
    json!({
        "version": "0.1.0", "build": "0.1.0", "boot": "boot1", "uptimeMs": 1000,
        "clients": 1, "buffers": 2, "journalBytes": 4096, "imageGen": 3, "imageEpoch": "epoch1",
        "loopLagP95Ms": 1.5, "ackP95Ms": 0.5,
        "notesExists": true, "notesGen": 7,
        "sample": true, "models": {"default": "tier-default", "quick": "tier-quick"},
    })
}

enum EditInject {
    Line(Value),
    Close,
}

type EditRequests = watch::Sender<Vec<(usize, Value)>>;

/// An edwind on a unix socket speaking the edit protocol's framing: `welcome` to
/// `hello`, `pong` to `ping`, and to `call{cmd}` the scripted answer for `cmd`.
/// Connections are numbered from 0 in accept order; every message after `hello` is
/// recorded with its connection number.
pub struct FakeEdit {
    pub path: PathBuf,
    _dir: tempfile::TempDir,
    requests: watch::Receiver<Vec<(usize, Value)>>,
    hellos: Arc<Mutex<Vec<Value>>>,
    conns: Arc<Mutex<Vec<mpsc::UnboundedSender<EditInject>>>>,
    answers: Arc<Mutex<std::collections::HashMap<String, Value>>>,
    accept: tokio::task::JoinHandle<()>,
}

impl FakeEdit {
    pub fn start() -> FakeEdit {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("edit.sock");
        FakeEdit::start_at(dir, path)
    }

    /// An edwind on a path chosen before it starts, for a web that is already running.
    pub fn start_at(dir: tempfile::TempDir, path: PathBuf) -> FakeEdit {
        let listener = UnixListener::bind(&path).unwrap();
        let (record, requests) = watch::channel(Vec::new());
        let record = Arc::new(record);
        let hellos = Arc::new(Mutex::new(Vec::new()));
        let conns = Arc::new(Mutex::new(Vec::new()));
        let answers = Arc::new(Mutex::new(std::collections::HashMap::new()));
        answers
            .lock()
            .unwrap()
            .insert("status".to_owned(), json!({"value": edit_status()}));
        let accept = tokio::spawn({
            let conns = conns.clone();
            let answers = answers.clone();
            let hellos = hellos.clone();
            async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    let (tx, rx) = mpsc::unbounded_channel();
                    let id = {
                        let mut conns = conns.lock().unwrap();
                        conns.push(tx);
                        conns.len() - 1
                    };
                    tokio::spawn(serve_edit(
                        id,
                        stream,
                        record.clone(),
                        hellos.clone(),
                        rx,
                        answers.clone(),
                    ));
                }
            }
        });
        FakeEdit {
            path,
            _dir: dir,
            requests,
            hellos,
            conns,
            answers,
            accept,
        }
    }

    /// Scripts the answer to `call{cmd}`: the fields merged into `result{rid}`, such as
    /// `{"value": …}` or `{"error": {"condition", "report"}}`, or a whole
    /// `{"t": "error", "code", "msg"}` for a protocol refusal.
    pub fn answer(&self, cmd: &str, reply: Value) {
        self.answers.lock().unwrap().insert(cmd.to_owned(), reply);
    }

    /// Every `hello` received so far.
    pub fn hellos(&self) -> Vec<Value> {
        self.hellos.lock().unwrap().clone()
    }

    /// Every message after `hello` so far.
    pub fn requests(&self) -> Vec<(usize, Value)> {
        self.requests.borrow().clone()
    }

    /// Waits until `n` recorded messages match `pred`; returns all that match.
    pub async fn wait_count(&self, n: usize, pred: impl Fn(&Value) -> bool) -> Vec<(usize, Value)> {
        let mut rx = self.requests.clone();
        let matching = |all: &Vec<(usize, Value)>| -> Vec<(usize, Value)> {
            all.iter().filter(|(_, r)| pred(r)).cloned().collect()
        };
        let all = timeout(WAIT, rx.wait_for(|all| matching(all).len() >= n))
            .await
            .unwrap_or_else(|_| panic!("edwind messages did not arrive:\n{:#?}", self.requests()))
            .unwrap()
            .clone();
        matching(&all)
    }

    /// Waits for the first message matching `pred`.
    pub async fn wait_for(&self, pred: impl Fn(&Value) -> bool) -> (usize, Value) {
        self.wait_count(1, pred).await.remove(0)
    }

    /// Waits for the first `call` of `cmd`, returning its `args`.
    pub async fn wait_call(&self, cmd: &str) -> Value {
        let (_, call) = self.wait_for(|m| m["t"] == "call" && m["cmd"] == cmd).await;
        call["args"].clone()
    }

    /// Pushes a line to connection `conn`.
    pub fn send(&self, conn: usize, msg: Value) {
        self.conns.lock().unwrap()[conn]
            .send(EditInject::Line(msg))
            .unwrap();
    }

    /// Closes connection `conn` from the edwind side.
    pub fn close(&self, conn: usize) {
        let _ = self.conns.lock().unwrap()[conn].send(EditInject::Close);
    }

    /// Stops accepting and closes every connection; the socket file is removed.
    pub fn stop(&self) {
        self.accept.abort();
        for conn in self.conns.lock().unwrap().iter() {
            let _ = conn.send(EditInject::Close);
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for FakeEdit {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn serve_edit(
    id: usize,
    stream: UnixStream,
    record: Arc<EditRequests>,
    hellos: Arc<Mutex<Vec<Value>>>,
    mut inject: mpsc::UnboundedReceiver<EditInject>,
    answers: Arc<Mutex<std::collections::HashMap<String, Value>>>,
) {
    let (rx, mut tx) = stream.into_split();
    let mut lines = FramedRead::new(rx, LinesCodec::new_with_max_length(MAX_LINE));
    loop {
        let reply = tokio::select! {
            line = lines.next() => {
                let Some(Ok(line)) = line else { return };
                let msg: Value = serde_json::from_str(&line).unwrap();
                match msg["t"].as_str().unwrap() {
                    "hello" => {
                        hellos.lock().unwrap().push(msg);
                        json!({"t": "welcome", "proto": 1, "build": "0.1.0", "boot": "boot1",
                               "imageEpoch": "epoch1", "gen": 3, "caps": {}})
                    }
                    "ping" => json!({"t": "pong", "rid": msg["rid"]}),
                    "call" => {
                        record.send_modify(|all| all.push((id, msg.clone())));
                        let cmd = msg["cmd"].as_str().unwrap_or_default();
                        let scripted = answers.lock().unwrap().get(cmd).cloned();
                        let mut reply = match scripted {
                            Some(reply) => reply,
                            None => json!({"t": "error", "code": "bad_request",
                                           "msg": format!("unknown command {cmd}")}),
                        };
                        if reply["t"] != "error" {
                            reply["t"] = "result".into();
                        }
                        reply["rid"] = msg["rid"].clone();
                        reply
                    }
                    _ => {
                        record.send_modify(|all| all.push((id, msg)));
                        continue;
                    }
                }
            }
            msg = inject.recv() => match msg {
                Some(EditInject::Line(msg)) => msg,
                Some(EditInject::Close) | None => return,
            },
        };
        let mut line = reply.to_string().into_bytes();
        line.push(b'\n');
        if tx.write_all(&line).await.is_err() {
            return;
        }
    }
}
