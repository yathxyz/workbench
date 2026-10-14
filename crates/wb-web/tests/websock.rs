//! `web.sock` and the leader policy (design §3.3, W-4): the handshake, the peer check,
//! the socket file, and a `wb` command routed to the leader page on `/rpc` and its
//! answer carried back.

mod common;

use std::fs::Permissions;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use common::{WAIT, Web, Ws, next_json, send_json};
use futures_util::StreamExt;
use futures_util::future::select_all;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

const VERSION: &str = env!("CARGO_PKG_VERSION");
/// No hub runs there; `/rpc` works without one.
const NO_HUB: &str = "/nonexistent-wb-test/hub.sock";
/// How long a tab must stay without a `cmd` to count as never getting one.
const QUIET: Duration = Duration::from_millis(300);

fn web() -> Web {
    Web::start(Path::new(NO_HUB))
}

/// A `wb` client on `web.sock`.
struct Cli {
    rd: Lines<BufReader<OwnedReadHalf>>,
    wr: OwnedWriteHalf,
}

impl Cli {
    async fn connect(path: &Path) -> Cli {
        let (rd, wr) = UnixStream::connect(path).await.unwrap().into_split();
        Cli {
            rd: BufReader::new(rd).lines(),
            wr,
        }
    }

    /// Connected to `web`, past both hellos.
    async fn open(web: &Web) -> Cli {
        let mut cli = Cli::connect(&web.socket()).await;
        assert_eq!(cli.recv().await["t"], "hello");
        cli.send(json!({"t": "hello", "proto": 1, "client": "wb/test"}))
            .await;
        cli
    }

    async fn send_line(&mut self, line: &str) {
        self.wr
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn send(&mut self, v: Value) {
        self.send_line(&v.to_string()).await;
    }

    async fn recv(&mut self) -> Value {
        let line = timeout(WAIT, self.rd.next_line())
            .await
            .expect("no line from web.sock")
            .unwrap()
            .expect("web.sock closed");
        serde_json::from_str(&line).unwrap()
    }

    /// Asserts that the server closes without another line.
    async fn closed(&mut self) {
        match timeout(WAIT, self.rd.next_line())
            .await
            .expect("web.sock not closed")
        {
            Ok(None) | Err(_) => {}
            Ok(Some(line)) => panic!("expected the end, got {line}"),
        }
    }

    /// Sends `read_node{path: x}` as `rid` with `extra` fields merged in.
    async fn cmd(&mut self, rid: u64, extra: Value) {
        let mut cmd = json!({"t": "cmd", "rid": rid, "tool": "read_node", "input": {"path": "x"}});
        for (k, v) in extra.as_object().unwrap() {
            cmd[k] = v.clone();
        }
        self.send(cmd).await;
    }
}

/// A page on `/rpc`. It is registered once its first message has arrived.
async fn tab(web: &Web) -> Ws {
    let mut ws = web.ws("/rpc").await;
    assert_eq!(next_json(&mut ws).await["t"], "hub");
    ws
}

static SYNC: AtomicU64 = AtomicU64::new(0);

/// Returns once wb-web has handled everything `ws` sent so far: `/rpc` reads a tab's
/// messages in order, and `limits` is answered.
async fn sync(ws: &mut Ws) {
    let id = format!("sync{}", SYNC.fetch_add(1, Ordering::Relaxed));
    send_json(ws, json!({"t": "limits", "id": id})).await;
    loop {
        let msg = next_json(ws).await;
        assert_ne!(msg["t"], "cmd", "unexpected {msg}");
        if msg["t"] == "ok" && msg["id"] == id.as_str() {
            return;
        }
    }
}

/// `active{ago}`, handled before this returns.
async fn active(ws: &mut Ws, ago: Value) {
    send_json(ws, json!({"t": "active", "ago": ago})).await;
    sync(ws).await;
}

/// The next `cmd` the page gets; other messages are skipped.
async fn next_cmd(ws: &mut Ws) -> Value {
    loop {
        let msg = next_json(ws).await;
        if msg["t"] == "cmd" {
            return msg;
        }
    }
}

/// Asserts that `ws` gets no `cmd` for `QUIET`.
async fn no_cmd(ws: &mut Ws) {
    let end = tokio::time::Instant::now() + QUIET;
    loop {
        match tokio::time::timeout_at(end, ws.next()).await {
            Err(_) => return,
            Ok(Some(Ok(Message::Text(t)))) => {
                let msg: Value = serde_json::from_str(t.as_str()).unwrap();
                assert_ne!(msg["t"], "cmd", "unexpected {msg}");
            }
            Ok(Some(Ok(_))) => {}
            Ok(other) => panic!("the tab closed: {other:?}"),
        }
    }
}

async fn answer(ws: &mut Ws, cmd: &Value, result: Value) {
    send_json(
        ws,
        json!({"t": "cmd_result", "id": cmd["id"], "result": result}),
    )
    .await;
}

/// Closes a tab and waits until wb-web has dropped it.
async fn close(mut ws: Ws) {
    ws.close(None).await.unwrap();
    while let Ok(Some(Ok(_))) = timeout(WAIT, ws.next()).await {}
    // The close handshake ends just before the socket's task drops its page.
    tokio::time::sleep(Duration::from_millis(100)).await;
}

/// Sends `read_node` as `rid` and returns the index of the tab that ran it. Only that
/// tab gets the `cmd`; it answers `tab<i>`, which is what the CLI gets.
async fn leader(cli: &mut Cli, rid: u64, tabs: &mut [&mut Ws]) -> usize {
    cli.cmd(rid, json!({})).await;
    let (cmd, i, _) = select_all(tabs.iter_mut().map(|ws| Box::pin(next_cmd(ws)))).await;
    let id = cmd["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with('w'), "{cmd}");
    assert_eq!(
        cmd,
        json!({"t": "cmd", "id": id, "tool": "read_node", "input": {"path": "x"}})
    );
    answer(tabs[i], &cmd, json!(format!("tab{i}"))).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "ok", "rid": rid, "result": format!("tab{i}")})
    );
    for (j, ws) in tabs.iter_mut().enumerate() {
        if j != i {
            no_cmd(ws).await;
        }
    }
    i
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hello_exchange_and_bad_hellos() {
    let web = web();
    let mut cli = Cli::connect(&web.socket()).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "hello", "proto": 1, "server": "wb-web", "version": VERSION})
    );
    cli.send(json!({"t": "hello", "proto": 1, "client": "wb/0.1.0"}))
        .await;
    cli.cmd(1, json!({})).await;
    assert_eq!(cli.recv().await["code"], "no_page");

    let bad = [
        (
            r#"{"t":"cmd","rid":1,"tool":"read_node","input":{}}"#,
            "expected hello",
        ),
        (
            r#"{"t":"hello","proto":2,"client":"wb/9"}"#,
            "this server speaks proto 1, not 2",
        ),
        ("not json", "expected hello"),
        (r#"{"t":"hello","proto":1}"#, "expected hello"),
    ];
    for (line, message) in bad {
        let mut cli = Cli::connect(&web.socket()).await;
        assert_eq!(cli.recv().await["t"], "hello");
        cli.send_line(line).await;
        assert_eq!(
            cli.recv().await,
            json!({"t": "err", "code": "bad_request", "message": message}),
            "{line}"
        );
        cli.closed().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_page_while_no_tab_is_open() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    cli.cmd(7, json!({})).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "err", "rid": 7, "code": "no_page", "message": "no Workbench page is open"})
    );
    // A tab that came and went leaves no page behind.
    let mut a = tab(&web).await;
    assert_eq!(leader(&mut cli, 8, &mut [&mut a]).await, 0);
    close(a).await;
    cli.cmd(9, json!({})).await;
    assert_eq!(cli.recv().await["code"], "no_page");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_leader_is_the_tab_active_last() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    let mut b = tab(&web).await;
    // A was active at T1 and B never was: A, though B is the newer connection.
    active(&mut a, json!(0)).await;
    assert_eq!(leader(&mut cli, 1, &mut [&mut a, &mut b]).await, 0);
    // B active later: B.
    tokio::time::sleep(Duration::from_millis(20)).await;
    active(&mut b, json!(0)).await;
    assert_eq!(leader(&mut cli, 2, &mut [&mut a, &mut b]).await, 1);
    // A active later still: A, though it is the older connection.
    tokio::time::sleep(Duration::from_millis(20)).await;
    active(&mut a, json!(0)).await;
    assert_eq!(leader(&mut cli, 3, &mut [&mut a, &mut b]).await, 0);
    // `ago` counts back from the receive time: A last focused a minute ago is behind B.
    active(&mut a, json!(60_000)).await;
    assert_eq!(leader(&mut cli, 4, &mut [&mut a, &mut b]).await, 1);
    // A fractional `ago` is fine.
    tokio::time::sleep(Duration::from_millis(20)).await;
    active(&mut a, json!(0.5)).await;
    assert_eq!(leader(&mut cli, 5, &mut [&mut a, &mut b]).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn equal_last_active_goes_to_the_newer_connection() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    let mut b = tab(&web).await;
    // An `ago` older than the epoch saturates, so both have the same lastActive even
    // though A sent its `active` last.
    active(&mut b, json!(1e15)).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    active(&mut a, json!(u64::MAX)).await;
    assert_eq!(leader(&mut cli, 1, &mut [&mut a, &mut b]).await, 1);
    // A newest tab that never sent `active` still ranks below both.
    let mut c = tab(&web).await;
    assert_eq!(leader(&mut cli, 2, &mut [&mut a, &mut b, &mut c]).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reconnect_without_active_ranks_below() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    let mut b = tab(&web).await;
    active(&mut a, json!(0)).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    active(&mut b, json!(0)).await;
    assert_eq!(leader(&mut cli, 1, &mut [&mut a, &mut b]).await, 1);
    // B reconnects and says nothing yet: A leads.
    close(b).await;
    let mut b = tab(&web).await;
    assert_eq!(leader(&mut cli, 2, &mut [&mut a, &mut b]).await, 0);
    // Invalid `ago` values change nothing.
    for ago in [json!(-5), json!("0"), Value::Null, json!({})] {
        active(&mut b, ago).await;
    }
    send_json(&mut b, json!({"t": "active"})).await;
    sync(&mut b).await;
    assert_eq!(leader(&mut cli, 3, &mut [&mut a, &mut b]).await, 0);
    // Its first valid `active` puts it back in front.
    tokio::time::sleep(Duration::from_millis(20)).await;
    active(&mut b, json!(0)).await;
    assert_eq!(leader(&mut cli, 4, &mut [&mut a, &mut b]).await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_leaders_cmd_result_counts() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    let mut b = tab(&web).await;
    active(&mut b, json!(0)).await;
    cli.cmd(1, json!({})).await;
    let cmd = next_cmd(&mut b).await;
    // The other tab answers the same id first: ignored.
    answer(&mut a, &cmd, json!("from a")).await;
    send_json(
        &mut a,
        json!({"t": "cmd_result", "id": cmd["id"], "error": "from a"}),
    )
    .await;
    sync(&mut a).await;
    // The leader's answers to other ids, or without one: ignored.
    answer(&mut b, &json!({"id": "w999"}), json!("wrong id")).await;
    send_json(&mut b, json!({"t": "cmd_result", "result": "no id"})).await;
    sync(&mut b).await;
    // A non-string result reaches the CLI as its JSON text.
    answer(&mut b, &cmd, json!({"n": 1})).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "ok", "rid": 1, "result": "{\"n\":1}"})
    );
    // A second answer to the same id is ignored too; the next command gets its own.
    answer(&mut b, &cmd, json!("again")).await;
    sync(&mut b).await;
    cli.cmd(2, json!({})).await;
    let next = next_cmd(&mut b).await;
    assert_ne!(next["id"], cmd["id"]);
    answer(&mut b, &next, json!("two")).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "ok", "rid": 2, "result": "two"})
    );
    no_cmd(&mut a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_leader_closing_first_is_page_gone_and_never_resent() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    let mut b = tab(&web).await;
    active(&mut a, json!(0)).await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    active(&mut b, json!(0)).await;
    cli.cmd(1, json!({})).await;
    let cmd = next_cmd(&mut b).await;
    drop(b);
    assert_eq!(
        cli.recv().await,
        json!({"t": "err", "rid": 1, "code": "page_gone",
               "message": "the page closed before answering"})
    );
    no_cmd(&mut a).await;
    // The next command on the same connection goes to A, under a new id.
    cli.cmd(2, json!({})).await;
    let next = next_cmd(&mut a).await;
    assert_ne!(next["id"], cmd["id"]);
    answer(&mut a, &next, json!("a")).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "ok", "rid": 2, "result": "a"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silent_page_times_out() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    // 0 is raised to the 1 s minimum.
    let started = Instant::now();
    cli.cmd(1, json!({"timeout": 0})).await;
    let cmd = next_cmd(&mut a).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "err", "rid": 1, "code": "timeout",
               "message": "the page did not answer in 1 s"})
    );
    let waited = started.elapsed();
    assert!(
        (Duration::from_millis(900)..Duration::from_secs(5)).contains(&waited),
        "{waited:?}"
    );
    // The late answer is dropped, and the connection takes the next command.
    answer(&mut a, &cmd, json!("late")).await;
    sync(&mut a).await;
    cli.cmd(2, json!({"timeout": 2})).await;
    let next = next_cmd(&mut a).await;
    answer(&mut a, &next, json!("on time")).await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "ok", "rid": 2, "result": "on time"})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tool_error_is_code_tool() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    cli.send(json!({"t": "cmd", "rid": 3, "tool": "nope", "input": {}}))
        .await;
    let cmd = next_cmd(&mut a).await;
    assert_eq!(cmd["tool"], "nope");
    let message = "unknown tool nope (wb tools lists them)";
    send_json(
        &mut a,
        json!({"t": "cmd_result", "id": cmd["id"], "error": message}),
    )
    .await;
    assert_eq!(
        cli.recv().await,
        json!({"t": "err", "rid": 3, "code": "tool", "message": message})
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_cmds_are_bad_request_and_never_reach_a_page() {
    let web = web();
    let mut cli = Cli::open(&web).await;
    let mut a = tab(&web).await;
    active(&mut a, json!(0)).await;
    let input = "input must be a JSON object";
    let with_rid = [
        (
            json!({"t": "cmd", "rid": 1, "tool": "read_node", "input": [1]}),
            input,
        ),
        (
            json!({"t": "cmd", "rid": 2, "tool": "read_node", "input": "x"}),
            input,
        ),
        (
            json!({"t": "cmd", "rid": 3, "tool": "read_node", "input": null}),
            input,
        ),
        (json!({"t": "cmd", "rid": 4, "tool": "read_node"}), input),
        (
            json!({"t": "cmd", "rid": 5, "tool": "", "input": {}}),
            "tool must be a non-empty string",
        ),
        (
            json!({"t": "cmd", "rid": 6, "input": {}}),
            "tool must be a non-empty string",
        ),
        (
            json!({"t": "cmd", "rid": 7, "tool": "read_node", "input": {}, "timeout": "5"}),
            "timeout must be a number of seconds",
        ),
        (json!({"t": "hello", "rid": 8, "proto": 1}), "expected cmd"),
    ];
    for (line, message) in with_rid {
        cli.send(line.clone()).await;
        assert_eq!(
            cli.recv().await,
            json!({"t": "err", "rid": line["rid"], "code": "bad_request", "message": message}),
            "{line}"
        );
    }
    let without_rid = [
        (
            r#"{"t":"cmd","tool":"read_node","input":{}}"#,
            "rid must be a non-negative integer",
        ),
        (
            r#"{"t":"cmd","rid":-1,"tool":"read_node","input":{}}"#,
            "rid must be a non-negative integer",
        ),
        (r#"[1]"#, "expected a JSON object"),
        (r#"{"t":"hello","proto":1,"client":"wb/x"}"#, "expected cmd"),
    ];
    for (line, message) in without_rid {
        cli.send_line(line).await;
        assert_eq!(
            cli.recv().await,
            json!({"t": "err", "code": "bad_request", "message": message}),
            "{line}"
        );
    }
    cli.send_line("not json").await;
    let reply = cli.recv().await;
    assert_eq!(
        (&reply["code"], reply.get("rid")),
        (&json!("bad_request"), None)
    );
    assert!(reply["message"].as_str().unwrap().starts_with("not JSON"));
    // None of those reached the tab; a valid line on the same connection does.
    no_cmd(&mut a).await;
    assert_eq!(leader(&mut cli, 9, &mut [&mut a]).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn web_sock_is_0600_replaces_only_a_stale_socket_and_goes_at_exit() {
    let mut web = web();
    let meta = std::fs::symlink_metadata(web.socket()).unwrap();
    assert!(meta.file_type().is_socket());
    assert_eq!(meta.permissions().mode() & 0o7777, 0o600);
    web.sigterm();
    assert!(web.wait_exit().await.success());
    assert!(!web.socket().exists());

    // A socket left by a crash is replaced.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("web.sock");
    drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
    let web = Web::start_with(Path::new(NO_HUB), |cfg| cfg["socket"] = json!(path));
    let mut cli = Cli::connect(&path).await;
    assert_eq!(cli.recv().await["server"], "wb-web");
    drop(web);

    // A socket that something still serves stops startup, and is left alone.
    let dir = tempfile::tempdir().unwrap();
    let cfg = common::fixture(dir.path(), Path::new(NO_HUB));
    let path = dir.path().join("web.sock");
    let live = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let config = dir.path().join("web.json");
    std::fs::write(&config, cfg.to_string()).unwrap();
    let (status, stderr) = common::run_to_exit(&["--config", config.to_str().unwrap()]);
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("is in use by another process"), "{stderr}");
    assert!(!stderr.contains("listening on"), "{stderr}");
    assert!(path.exists());
    drop(live);

    // Any other file there stops startup, and is left alone.
    let dir = tempfile::tempdir().unwrap();
    let cfg = common::fixture(dir.path(), Path::new(NO_HUB));
    let path = dir.path().join("web.sock");
    std::fs::write(&path, "keep").unwrap();
    let config = dir.path().join("web.json");
    std::fs::write(&config, cfg.to_string()).unwrap();
    let (status, stderr) = common::run_to_exit(&["--config", config.to_str().unwrap()]);
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("is not a socket"), "{stderr}");
    assert!(!stderr.contains("listening on"), "{stderr}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep");

    // So does a directory that does not exist.
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = common::fixture(dir.path(), Path::new(NO_HUB));
    cfg["socket"] = json!(dir.path().join("missing/web.sock"));
    let config = dir.path().join("web.json");
    std::fs::write(&config, cfg.to_string()).unwrap();
    let (status, stderr) = common::run_to_exit(&["--config", config.to_str().unwrap()]);
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("cannot bind"), "{stderr}");
    assert!(!stderr.contains("listening on"), "{stderr}");
}

/// Connects to `argv[1]` and prints how many bytes arrive before the end.
const PEER: &str = r#"
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.settimeout(5)
s.connect(sys.argv[1])
n = 0
while True:
    try:
        b = s.recv(4096)
    except ConnectionResetError:
        break
    if not b:
        break
    n += len(b)
print(n)
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_user_gets_no_bytes() {
    if !rustix::process::geteuid().is_root() {
        eprintln!("skipped: only root can connect as another uid");
        return;
    }
    // A directory and socket the other uid may reach, so only the peer check is left.
    let run = tempfile::Builder::new()
        .prefix("wb-web-peer")
        .tempdir_in("/tmp")
        .unwrap();
    std::fs::set_permissions(run.path(), Permissions::from_mode(0o711)).unwrap();
    let path = run.path().join("web.sock");
    let web = Web::start_with(Path::new(NO_HUB), |cfg| cfg["socket"] = json!(path));
    std::fs::set_permissions(&path, Permissions::from_mode(0o666)).unwrap();
    let out = std::process::Command::new("python3")
        .args(["-I", "-c", PEER])
        .arg(&path)
        .uid(65534)
        .gid(65534)
        .current_dir("/")
        .output();
    let out = match out {
        Ok(out) => out,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipped: no python3");
            return;
        }
        Err(e) => panic!("{e}"),
    };
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0");
    web.wait_log("web.sock refused a connection from another user", 1)
        .await;
    // Root still gets the hello.
    let mut cli = Cli::connect(&path).await;
    assert_eq!(cli.recv().await["t"], "hello");
}
