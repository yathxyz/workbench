//! `wb tools` and `wb TOOL` against a fake `web.sock` (DESIGN §3.3, §3.7.4, W-14):
//! the hellos, the `cmd` line, the input merge, the exit codes and messages, and that
//! these commands never touch `edit.sock` and that a W-14 tool never connects.

mod common;

use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use common::{Run, WAIT};

/// The longest a `wb` run may take before the test kills it.
const RUN_LIMIT: Duration = Duration::from_secs(40);

/// What the fake server does after it accepts.
#[derive(Clone)]
struct Script {
    /// The first line, or `None` to close at once without a byte (as for a wrong uid).
    hello: Option<String>,
    /// The lines written once the `cmd` line is read; empty closes after the hello.
    replies: Vec<String>,
    /// How long to wait for the client's lines and for it to hang up.
    patience: Duration,
}

impl Script {
    fn hello() -> String {
        json!({"t": "hello", "proto": 1, "server": "wb-web", "version": "9.9.9"}).to_string()
    }

    /// The usual exchange, answered with `replies`.
    fn replies(replies: &[Value]) -> Script {
        Script {
            hello: Some(Script::hello()),
            replies: replies.iter().map(Value::to_string).collect(),
            patience: WAIT,
        }
    }

    fn reply(reply: Value) -> Script {
        Script::replies(&[reply])
    }

    fn ok(result: &str) -> Script {
        Script::reply(json!({"t": "ok", "rid": 1, "result": result}))
    }

    fn err(code: &str, message: &str) -> Script {
        Script::reply(json!({"t": "err", "rid": 1, "code": code, "message": message}))
    }
}

/// What the fake server read from `wb`.
#[derive(Debug, Default)]
struct Seen {
    accepted: bool,
    /// The JSON lines `wb` sent, in order.
    lines: Vec<Value>,
}

impl Seen {
    fn hello(&self) -> &Value {
        self.lines.first().expect("wb sent no hello")
    }

    fn cmd(&self) -> &Value {
        self.lines.get(1).expect("wb sent no cmd")
    }
}

/// A fake web.sock, and a fake edit.sock that the tool commands must never touch.
struct Fake {
    _dir: tempfile::TempDir,
    sock: PathBuf,
    listener: UnixListener,
    edit: UnixListener,
    edit_sock: PathBuf,
}

impl Fake {
    fn new() -> Fake {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("web.sock");
        let edit_sock = dir.path().join("edit.sock");
        let listener = UnixListener::bind(&sock).unwrap();
        listener.set_nonblocking(true).unwrap();
        let edit = UnixListener::bind(&edit_sock).unwrap();
        edit.set_nonblocking(true).unwrap();
        Fake {
            _dir: dir,
            sock,
            listener,
            edit,
            edit_sock,
        }
    }

    /// `wb` with `$WB_SOCKET` on this fake and `$WB_EDIT_SOCK` on the trap.
    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_wb"));
        cmd.args(args)
            .env("WB_SOCKET", &self.sock)
            .env("WB_EDIT_SOCK", &self.edit_sock)
            .env_remove("WB_SESSION");
        cmd
    }

    fn wb(&self, args: &[&str], stdin: Option<&str>) -> Run {
        run_command(self.command(args), stdin)
    }

    /// Serves one connection with `script` on a thread.
    fn serve(&self, script: Script) -> JoinHandle<Seen> {
        let listener = self.listener.try_clone().unwrap();
        std::thread::spawn(move || serve(&listener, &script))
    }

    /// Nobody connected to web.sock (beyond what was served).
    fn assert_no_connection(&self) {
        assert_no_accept(&self.listener, "web.sock");
    }

    /// Nobody connected to edit.sock.
    fn assert_edit_untouched(&self) {
        assert_no_accept(&self.edit, "edit.sock");
    }
}

fn assert_no_accept(listener: &UnixListener, what: &str) {
    match listener.accept() {
        Err(e) if e.kind() == ErrorKind::WouldBlock => {}
        Err(e) => panic!("accept on {what}: {e}"),
        Ok(_) => panic!("wb connected to {what}"),
    }
}

/// Accepts one connection within `WAIT` and plays `script`.
fn serve(listener: &UnixListener, script: &Script) -> Seen {
    let mut seen = Seen::default();
    let started = Instant::now();
    let stream = loop {
        match listener.accept() {
            Ok((s, _)) => break s,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                if started.elapsed() > WAIT {
                    return seen;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => panic!("accept: {e}"),
        }
    };
    seen.accepted = true;
    stream.set_nonblocking(false).unwrap();
    stream.set_read_timeout(Some(script.patience)).unwrap();
    let Some(hello) = &script.hello else {
        return seen;
    };
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    writeln!(writer, "{hello}").unwrap();
    // The client hello and the cmd.
    for _ in 0..2 {
        match read_json(&mut reader) {
            Some(v) => seen.lines.push(v),
            None => return seen,
        }
    }
    for line in &script.replies {
        // The client may have gone already (a usage of its own, a deadline).
        if writeln!(writer, "{line}").is_err() {
            return seen;
        }
    }
    // Hold the connection until the client hangs up; anything more it sends is kept.
    while let Some(v) = read_json(&mut reader) {
        seen.lines.push(v);
    }
    seen
}

/// The next line as JSON; `None` at end of input or after the read timeout.
fn read_json(reader: &mut BufReader<UnixStream>) -> Option<Value> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) | Err(_) => None,
        Ok(_) => {
            Some(serde_json::from_str(&line).unwrap_or_else(|e| panic!("wb sent {line:?}: {e}")))
        }
    }
}

/// Runs `cmd` to completion within `RUN_LIMIT`.
fn run_command(mut cmd: Command, stdin: Option<&str>) -> Run {
    let mut child = cmd
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(text) = stdin {
        let mut pipe = child.stdin.take().unwrap();
        // A `wb` that exits first leaves a broken pipe; its exit code tells.
        let _ = pipe.write_all(text.as_bytes());
    }
    let drain = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = r.read_to_string(&mut s);
            s
        })
    };
    let out = drain(Box::new(child.stdout.take().unwrap()));
    let err = drain(Box::new(child.stderr.take().unwrap()));
    let started = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status.code().unwrap_or(-1);
        }
        if started.elapsed() > RUN_LIMIT {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "wb did not exit within {RUN_LIMIT:?}; stderr:\n{}",
                err.join().unwrap()
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Run {
        code,
        stdout: out.join().unwrap(),
        stderr: err.join().unwrap(),
    }
}

/// One tool run against `script`: the run and what the server saw. Checks that
/// edit.sock stayed untouched.
fn exchange(args: &[&str], stdin: Option<&str>, script: Script) -> (Run, Seen) {
    let fake = Fake::new();
    let server = fake.serve(script);
    let run = fake.wb(args, stdin);
    let seen = server.join().unwrap();
    fake.assert_edit_untouched();
    (run, seen)
}

#[test]
fn ok_prints_the_result_after_the_hello_exchange() {
    let (run, seen) = exchange(
        &["read_node", "--json", r#"{"path":"notes/x"}"#],
        None,
        Script::ok("line one\nline two"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(
        run.stdout, "line one\nline two\n",
        "a final newline is added"
    );
    assert_eq!(run.stderr, "");
    assert_eq!(
        *seen.hello(),
        json!({"t": "hello", "proto": 1, "client": format!("wb/{}", env!("CARGO_PKG_VERSION"))})
    );
    assert_eq!(
        *seen.cmd(),
        json!({"t": "cmd", "rid": 1, "tool": "read_node", "input": {"path": "notes/x"}}),
        "one cmd with rid 1 and no timeout unless --timeout is given"
    );
    assert_eq!(
        seen.lines.len(),
        2,
        "one hello and one cmd: {:?}",
        seen.lines
    );
}

#[test]
fn a_result_ending_in_newline_is_printed_as_is() {
    let (run, _) = exchange(&["list_nodes"], None, Script::ok("a\nb\n"));
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "a\nb\n");
    let (run, _) = exchange(&["list_nodes"], None, Script::ok(""));
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "");
}

#[test]
fn no_input_sends_an_empty_object() {
    let (run, seen) = exchange(&["list_nodes"], None, Script::ok("(no nodes)"));
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(seen.cmd()["input"], json!({}));
    assert!(seen.cmd().get("timeout").is_none());
}

#[test]
fn timeout_is_sent_when_given() {
    let (run, seen) = exchange(
        &["read_node", "path=x", "--timeout", "5"],
        None,
        Script::ok("x"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(seen.cmd()["timeout"], 5);
}

#[test]
fn desk_commands_send_the_desk_tools() {
    let (run, seen) = exchange(
        &["desk", "ls"],
        None,
        Script::ok("0 Board: every card at its place"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "0 Board: every card at its place\n");
    assert_eq!(
        *seen.cmd(),
        json!({"t": "cmd", "rid": 1, "tool": "list_desks", "input": {}})
    );
    let (run, seen) = exchange(
        &["desk", "send", "3", "notes/plan", "--follow"],
        None,
        Script::ok("1 item(s) now also on desk 3."),
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(
        seen.cmd()["input"],
        json!({"desk": 3, "items": ["notes/plan"], "follow": true})
    );
    assert_eq!(seen.cmd()["tool"], "send_to_desk");
    let (run, _) = exchange(
        &["desk", "go", "9"],
        None,
        Script::err("tool", "nothing needs a look: desk 9 is empty"),
    );
    assert_eq!(run.code, 1, "{run:?}");
    assert!(run.stderr.contains("desk 9 is empty"), "{run:?}");
}

#[test]
fn fields_merge_over_inline_input() {
    let (run, seen) = exchange(
        &[
            "write_page",
            "--json",
            r#"{"path":"p","text":"old","keep":1}"#,
            "text=new text",
            "confirm:=true",
            "n:=[1,2]",
        ],
        None,
        Script::ok("done"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(
        seen.cmd()["input"],
        json!({"path": "p", "text": "new text", "keep": 1, "confirm": true, "n": [1, 2]})
    );
    assert_eq!(seen.cmd()["tool"], "write_page");
}

#[test]
fn fields_merge_over_input_from_stdin() {
    let (run, seen) = exchange(
        &["write_page", "--json", "-", "text=from argv"],
        Some(r#"{"path": "p", "text": "from stdin", "big": {"a": [true]}}"#),
        Script::ok("done"),
    );
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(
        seen.cmd()["input"],
        json!({"path": "p", "text": "from argv", "big": {"a": [true]}})
    );
}

#[test]
fn no_page_is_exit_7() {
    let (run, _) = exchange(
        &["read_node", "path=x"],
        None,
        Script::err("no_page", "no Workbench page is open"),
    );
    assert_eq!(run.code, 7, "{run:?}");
    assert_eq!(run.stderr, "wb: no Workbench page is open\n");
    assert_eq!(run.stdout, "");
}

#[test]
fn error_codes_are_exit_1_with_their_messages() {
    for (code, message, shown) in [
        ("tool", "no node at x", "wb: no node at x\n"),
        (
            "timeout",
            "no answer in 60 s",
            "wb: the page did not answer in time\n",
        ),
        (
            "page_gone",
            "gone",
            "wb: the page closed before answering\n",
        ),
        (
            "bad_request",
            "input must be an object",
            "wb: input must be an object\n",
        ),
        ("future_code", "something new", "wb: something new\n"),
    ] {
        let (run, _) = exchange(&["read_node", "path=x"], None, Script::err(code, message));
        assert_eq!(run.code, 1, "{code}: {run:?}");
        assert_eq!(run.stderr, shown, "{code}");
        assert_eq!(run.stdout, "", "{code}");
    }
}

#[test]
fn an_err_without_rid_ends_the_command() {
    let (run, _) = exchange(
        &["read_node"],
        None,
        Script::reply(json!({"t": "err", "code": "bad_request", "message": "expected hello"})),
    );
    assert_eq!(run.code, 1, "{run:?}");
    assert_eq!(run.stderr, "wb: expected hello\n");
}

#[test]
fn other_lines_before_the_answer_are_skipped() {
    let script = Script {
        replies: vec![
            "not json".to_owned(),
            json!({"t": "ping"}).to_string(),
            json!({"t": "ok", "rid": 2, "result": "not mine"}).to_string(),
            json!({"t": "err", "rid": 3, "code": "tool", "message": "not mine"}).to_string(),
            json!({"t": "ok", "rid": 1, "result": "mine"}).to_string(),
        ],
        ..Script::ok("")
    };
    let (run, _) = exchange(&["read_node"], None, script);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "mine\n");
}

#[test]
fn tools_lists_without_the_w14_tools() {
    let list = "read_node(path): Read a node.\n\
                list_hosts(): List the hosts.\n\
                host_folder(host): Bind a folder to a host.\n\
                create_node(kind, name, text, parent, near): Create a node.\n\
                list_tmux(host): tmux sessions.\n\
                adopt_tmux(target, host): Adopt a session.\n\
                unit_control(unit, verb, host, confirm): start | stop | restart.\n\
                host_status(host): Health of a host.\n\
                list_tools(): List the board tools and their input fields.";
    let (run, seen) = exchange(&["tools"], None, Script::ok(list));
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(
        run.stdout,
        "read_node(path): Read a node.\n\
         create_node(kind, name, text, parent, near): Create a node.\n\
         list_tools(): List the board tools and their input fields.\n"
    );
    assert_eq!(
        *seen.cmd(),
        json!({"t": "cmd", "rid": 1, "tool": "list_tools", "input": {}})
    );
}

#[test]
fn tools_reports_no_page_as_exit_7() {
    let (run, _) = exchange(
        &["tools"],
        None,
        Script::err("no_page", "no Workbench page is open"),
    );
    assert_eq!(run.code, 7, "{run:?}");
    assert_eq!(run.stderr, "wb: no Workbench page is open\n");
}

#[test]
fn socket_flag_wins_over_the_environment() {
    let fake = Fake::new();
    let server = fake.serve(Script::ok("via flag"));
    let sock = fake.sock.to_str().unwrap().to_owned();
    let mut cmd = fake.command(&["read_node", "--socket", &sock]);
    cmd.env("WB_SOCKET", "/nonexistent/web.sock");
    let run = run_command(cmd, None);
    assert!(server.join().unwrap().accepted);
    assert_eq!(run.code, 0, "{run:?}");
    assert_eq!(run.stdout, "via flag\n");
}

#[test]
fn unreachable_socket_is_exit_1_with_the_path_and_errno() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("absent/web.sock");
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wb"));
    cmd.args(["read_node", "path=x"]).env("WB_SOCKET", &absent);
    let run = run_command(cmd, None);
    assert_eq!(run.code, 1, "{run:?}");
    assert_eq!(
        run.stderr,
        format!(
            "wb: cannot reach wb-web at {} (No such file or directory)\n",
            absent.display()
        )
    );
    assert_eq!(run.stdout, "");

    // A file that is not a listening socket.
    let plain = dir.path().join("web.sock");
    std::fs::write(&plain, "").unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wb"));
    cmd.args(["tools", "--socket"]).arg(&plain);
    let run = run_command(cmd, None);
    assert_eq!(run.code, 1, "{run:?}");
    assert_eq!(
        run.stderr,
        format!(
            "wb: cannot reach wb-web at {} (Connection refused)\n",
            plain.display()
        )
    );
}

#[test]
fn the_default_socket_is_the_web_runtime_directory() {
    let default = Path::new("/run/workbench-web/web.sock");
    if default.exists() {
        eprintln!("skipped: {} exists on this host", default.display());
        return;
    }
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wb"));
    cmd.args(["read_node"]).env_remove("WB_SOCKET");
    let run = run_command(cmd, None);
    assert_eq!(run.code, 1, "{run:?}");
    assert!(
        run.stderr
            .starts_with("wb: cannot reach wb-web at /run/workbench-web/web.sock ("),
        "{}",
        run.stderr
    );
    // An empty $WB_SOCKET counts as unset.
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_wb"));
    cmd.args(["read_node"]).env("WB_SOCKET", "");
    let run = run_command(cmd, None);
    assert!(
        run.stderr
            .starts_with("wb: cannot reach wb-web at /run/workbench-web/web.sock ("),
        "{}",
        run.stderr
    );
}

#[test]
fn a_socket_of_another_user_is_refused_before_connecting() {
    if !rustix::process::geteuid().is_root() {
        eprintln!("skipped: needs root to give the socket to another uid");
        return;
    }
    let fake = Fake::new();
    std::os::unix::fs::chown(&fake.sock, Some(65534), None).unwrap();
    let run = fake.wb(&["read_node"], None);
    assert_eq!(run.code, 1, "{run:?}");
    assert!(
        run.stderr.contains("is owned by uid 65534"),
        "{}",
        run.stderr
    );
    fake.assert_no_connection();
    fake.assert_edit_untouched();
}

#[test]
fn a_server_of_another_protocol_is_refused() {
    let script = Script {
        hello: Some(
            json!({"t": "hello", "proto": 2, "server": "wb-web", "version": "9"}).to_string(),
        ),
        ..Script::ok("never")
    };
    let (run, seen) = exchange(&["read_node"], None, script);
    assert_eq!(run.code, 1, "{run:?}");
    assert!(run.stderr.contains("protocol 2"), "{}", run.stderr);
    assert!(seen.lines.is_empty(), "wb sent {:?}", seen.lines);

    let script = Script {
        hello: Some(json!({"t": "ok", "rid": 1, "result": "early"}).to_string()),
        ..Script::ok("never")
    };
    let (run, seen) = exchange(&["read_node"], None, script);
    assert_eq!(run.code, 1, "{run:?}");
    assert!(
        run.stderr.contains("did not start with hello"),
        "{}",
        run.stderr
    );
    assert!(seen.lines.is_empty(), "wb sent {:?}", seen.lines);
}

#[test]
fn a_close_without_a_byte_is_exit_1() {
    // What a wb-web does to a peer of another uid.
    let script = Script {
        hello: None,
        ..Script::ok("never")
    };
    let (run, _) = exchange(&["read_node"], None, script);
    assert_eq!(run.code, 1, "{run:?}");
    assert_eq!(
        run.stderr,
        "wb: wb-web closed the connection before it sent its hello\n"
    );
}

#[test]
fn a_close_before_the_answer_is_exit_1() {
    let (run, seen) = exchange(&["read_node"], None, Script::replies(&[]));
    assert_eq!(run.code, 1, "{run:?}");
    assert_eq!(
        run.stderr,
        "wb: wb-web closed the connection before it sent an answer\n"
    );
    assert_eq!(seen.lines.len(), 2);
}

#[test]
fn the_read_deadline_is_the_timeout_plus_10_s() {
    // The server takes the cmd and never answers: wb gives up after 1 + 10 s.
    let script = Script {
        replies: vec![json!({"t": "ping"}).to_string()],
        patience: Duration::from_secs(30),
        ..Script::ok("")
    };
    let started = Instant::now();
    let (run, seen) = exchange(&["read_node", "--timeout", "1"], None, script);
    let took = started.elapsed();
    assert_eq!(run.code, 1, "{run:?}");
    assert_eq!(seen.cmd()["timeout"], 1);
    assert!(
        run.stderr.contains("did not send an answer within 11 s"),
        "{}",
        run.stderr
    );
    assert!(
        took >= Duration::from_secs(11) && took < Duration::from_secs(25),
        "took {took:?}"
    );
}

#[test]
fn w14_tools_are_usage_errors_and_never_connect() {
    let fake = Fake::new();
    for tool in [
        "list_hosts",
        "host_folder",
        "host_status",
        "unit_control",
        "list_tmux",
        "adopt_tmux",
    ] {
        let run = fake.wb(&[tool, "--json", "{}"], None);
        assert_eq!(run.code, 2, "{tool}: {run:?}");
        assert!(
            run.stderr
                .starts_with(&format!("wb: {tool} is not available from wb\nusage: wb ")),
            "{tool}: {}",
            run.stderr
        );
        assert_eq!(run.stdout, "");
    }
    for (args, stdin) in [
        (
            &["create_node", "--json", r#"{"kind":"agent","name":"a"}"#][..],
            None,
        ),
        (&["create_node", "kind=agent", "name=a"][..], None),
        (
            &["create_node", "--json", "-"][..],
            Some(r#"{"kind":"agent","name":"a"}"#),
        ),
    ] {
        let run = fake.wb(args, stdin);
        assert_eq!(run.code, 2, "{args:?}: {run:?}");
        assert!(
            run.stderr.starts_with(
                "wb: create_node with kind=agent is not available from wb\nusage: wb "
            ),
            "{args:?}: {}",
            run.stderr
        );
    }
    fake.assert_no_connection();
    fake.assert_edit_untouched();
}

#[test]
fn usage_errors_exit_2_and_never_connect() {
    let fake = Fake::new();
    for (args, stdin) in [
        (&["read_node", "--url", "http://127.0.0.1:8080"][..], None),
        (&["read_node", "--token=abc"][..], None),
        (&["tools", "--url", "http://h"][..], None),
        (&["tools", "extra"][..], None),
        (&["read_node", "--json", "[1]"][..], None),
        (&["read_node", "--json", "{bad"][..], None),
        (&["read_node", "--json"][..], None),
        (&["read_node", "nofield"][..], None),
        (&["read_node", "n:=nope"][..], None),
        (&["read_node", "--timeout", "0"][..], None),
        (&["read_node", "--json", "-"][..], Some("not json")),
        (&["read_node", "--json", "-"][..], Some("[1, 2]")),
        (&["Read_node"][..], None),
        (&["read-node"][..], None),
    ] {
        let run = fake.wb(args, stdin);
        assert_eq!(run.code, 2, "{args:?}: {run:?}");
        assert!(run.stderr.starts_with("wb: "), "{args:?}: {}", run.stderr);
        assert!(
            run.stderr.contains("usage: wb "),
            "{args:?}: {}",
            run.stderr
        );
        assert!(
            run.stderr.contains("wb TOOL [--json INPUT]"),
            "the usage text lists the tool commands: {}",
            run.stderr
        );
        assert_eq!(run.stdout, "");
    }
    fake.assert_no_connection();
    fake.assert_edit_untouched();
}
