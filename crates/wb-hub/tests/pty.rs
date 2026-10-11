//! PTY sessions against the real `wb-hub` binary.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use common::{CANARIES, Client, Hub, eventually, running, signal, wait_gone};
use rustix::process::Signal;
use serde_json::{Value, json};
use wb_proto::limits::{MAX_LINE, SNAPSHOT_EVERY};

/// Adds a shell entry to a test config.
fn with_shell(cfg: &mut Value, name: &str, paths: &[&str]) {
    let shell = json!({"name": name, "paths": paths, "args": []});
    cfg["shells"].as_array_mut().unwrap().push(shell);
}

fn pid_of(reply: &Value) -> u32 {
    let pid = reply["pid"]
        .as_u64()
        .unwrap_or_else(|| panic!("no pid in {reply}"));
    u32::try_from(pid).unwrap()
}

#[test]
fn hello_names_the_hub_and_its_available_shells() {
    let hub = Hub::start_with(|cfg| with_shell(cfg, "gone", &["/nonexistent/gone"]));
    let c = hub.connect();
    assert_eq!(c.hello["proto"], 1);
    assert_eq!(c.hello["server"], "wb-hub");
    assert_eq!(c.hello["host"], "example");
    assert_eq!(c.hello["pid"], hub.pid());
    assert_eq!(c.hello["agents"], json!([]));
    // `gone` has no existing path, so it is not offered.
    assert_eq!(c.hello["shells"], json!(["bash", "sh"]));
    assert_eq!(c.hello["defaultShell"], "bash");
}

#[test]
fn spawn_and_echo() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let r = c.spawn("echo", &["bash"]);
    assert_eq!(r["new"], true, "{r}");
    assert!(r["pid"].as_u64().is_some(), "{r}");
    assert_eq!(r["replay"], json!(null), "{r}");
    // The shell computes the marker, so the echoed command line cannot match it.
    c.input("echo", "echo MARK$((40+2))\r");
    c.output_until("echo", "MARK42");
    let list = c.ok(json!({"t": "list"}));
    let s = &list["sessions"][0];
    assert_eq!(s["sid"], "echo");
    assert_eq!(s["kind"], "pty");
    assert_eq!(s["alive"], true);
    assert_eq!(s["viewers"], 1);
    assert_eq!(s["createdAt"], r["epoch"]);
}

#[test]
fn a_second_connection_attaches_with_replay() {
    let hub = Hub::start();
    let mut a = hub.connect();
    let first = a.spawn("att", &["bash"]);
    a.input("att", "echo MARK$((1+1))\r");
    a.output_until("att", "MARK2");

    let mut b = hub.connect();
    let r = b.ok(json!({"t": "pty.open", "sid": "att", "cols": 80, "rows": 24}));
    assert_eq!(r["new"], false, "{r}");
    assert_eq!(r["resumed"], false, "{r}");
    assert_eq!(r["pid"], first["pid"]);
    assert_eq!(r["epoch"], first["epoch"]);
    assert!(r["replay"].as_str().unwrap().contains("MARK2"), "{r}");
    // The foreground process follows the reply, before any output.
    let fg = b.next().unwrap();
    assert_eq!(fg["t"], "pty.fg", "{fg}");
    assert_eq!(fg["comm"], "bash", "{fg}");
    assert_eq!(fg["cwd"], hub.dir.join("home").to_str().unwrap(), "{fg}");

    // Both see live output from then on.
    a.input("att", "echo NEXT$((2+2))\r");
    b.output_until("att", "NEXT4");
    a.output_until("att", "NEXT4");
}

#[test]
fn kill_with_forget_then_reopen_gives_a_new_incarnation() {
    let hub = Hub::start();
    let mut watcher = hub.connect();
    watcher.ok(json!({"t": "watch"}));
    let mut c = hub.connect();
    let first = c.spawn("kf", &["bash"]);
    let pid = pid_of(&first);
    let epoch = first["epoch"].as_u64().unwrap();
    let record = hub.pty_file("kf.json");
    eventually(Duration::from_secs(5), "the record", || record.exists());

    c.ok(json!({"t": "pty.kill", "sid": "kf", "forget": true}));
    // By the time of the reply the child is gone, the files are deleted and the session
    // is forgotten.
    assert!(!running(pid), "child {pid} still running after kill-forget");
    assert!(!record.exists(), "the record survived kill-forget");
    assert!(
        !hub.pty_file("kf.snap").exists(),
        "the snapshot survived kill-forget"
    );
    assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
    let gone = c.until("gone", |m| m["t"] == "gone");
    assert_eq!(gone, json!({"t": "gone", "sid": "kf", "epoch": epoch}));
    let gone = watcher.until("gone", |m| m["t"] == "gone");
    assert_eq!(gone["epoch"], epoch);

    let r = c.request(json!({"t": "pty.open", "sid": "kf", "cols": 80, "rows": 24}));
    assert_eq!(r["code"], "not_found", "{r}");
    let again = c.spawn("kf", &["bash"]);
    assert_eq!(again["new"], true);
    assert!(
        again["epoch"].as_u64().unwrap() > epoch,
        "{again} after {first}"
    );
}

#[test]
fn an_open_during_a_forgetting_exit_gets_a_new_incarnation_and_keeps_its_input() {
    let hub = Hub::start();
    let mut a = hub.connect();
    let first = a.spawn("race", &["bash"]);
    let shell = pid_of(&first);
    let epoch = first["epoch"].as_u64().unwrap();
    // A background job that ignores SIGHUP keeps the slave open, so after the shell exits
    // the session drains output for the full drain period before the forget completes.
    a.input(
        "race",
        "(trap '' HUP; exec sleep 300) & echo BG=$!=END$((7*7))\r",
    );
    let out = a.output_until("race", "=END49");
    let (before, _) = out.rsplit_once("=END49").unwrap();
    let bg: u32 = before
        .rsplit_once("BG=")
        .and_then(|(_, pid)| pid.parse().ok())
        .unwrap_or_else(|| panic!("no background pid in {out:?}"));
    a.send(&json!({"t": "pty.kill", "rid": 100, "sid": "race", "forget": true}));
    // Reaped, not just a zombie: the session has seen the exit and is draining.
    let deadline = Instant::now() + Duration::from_secs(5);
    while fs::exists(format!("/proc/{shell}")).unwrap() {
        assert!(Instant::now() < deadline, "the shell survived");
        std::thread::sleep(Duration::from_millis(5));
    }

    // Within the drain: open with spawn and type at once, without waiting for the reply.
    let mut b = hub.connect();
    b.send(
        &json!({"t": "pty.open", "rid": 100, "sid": "race", "cols": 80, "rows": 24,
                   "spawn": {"argv": ["bash"]}}),
    );
    b.input("race", "echo AFTER$((2+3))\r");
    let r = b.until("the open reply", |m| m["rid"] == 100);
    assert_eq!(r["t"], "ok", "{r}");
    assert!(
        r["epoch"].as_u64().unwrap() > epoch,
        "the open joined the forgotten incarnation: {r}"
    );
    b.output_until("race", "AFTER5");
    let list = b.ok(json!({"t": "list"}));
    assert_eq!(list["sessions"][0]["pty"]["pid"], r["pid"], "{list}");
    let reply = a.until("the kill reply", |m| m["rid"] == 100);
    assert_eq!(reply["t"], "ok", "{reply}");
    assert!(
        wait_gone(bg, Duration::from_secs(6)),
        "background job {bg} survived"
    );
}

#[test]
fn hub_environment_canaries_do_not_reach_the_child() {
    let hub = Hub::start();
    let mut c = hub.connect();
    // `bash -c` reads no startup files, so this is the environment the hub built. The
    // failure messages name variables only: a host's values can be secrets.
    c.ok(
        json!({"t": "pty.open", "sid": "env", "cols": 80, "rows": 24, "spawn": {
            "argv": ["bash", "-c", "export -p; echo END$((3+3))"],
            "env": {"CLIENT_VAR": "from-client", "HOME": "/elsewhere", "WB_SESSION": "forged"},
        }}),
    );
    let env = c.output_until("env", "END6");
    let names: Vec<&str> = env
        .lines()
        .filter_map(|l| l.strip_prefix("declare -x "))
        .map(|l| l.split('=').next().unwrap())
        .collect();
    for name in CANARIES {
        assert!(
            !names.contains(&name),
            "{name} reached the child; it has {names:?}"
        );
    }
    assert!(
        !env.contains("canary-value"),
        "a canary value reached the child"
    );
    let home = hub.dir.join("home");
    for expected in [
        format!("HOME=\"{}\"", home.display()),
        "USER=\"alice\"".into(),
        "LOGNAME=\"alice\"".into(),
        format!("SHELL=\"{}\"", hub.shell),
        "WB_SESSION=\"env\"".into(),
        "TERM=\"xterm-256color\"".into(),
        "COLORTERM=\"truecolor\"".into(),
        "WB_SET=\"from-config\"".into(),
        "CLIENT_VAR=\"from-client\"".into(),
    ] {
        assert!(
            env.contains(&expected),
            "missing {expected}; the child has {names:?}"
        );
    }
    assert!(
        names.contains(&"PATH"),
        "PATH was not passed; the child has {names:?}"
    );
    assert!(
        !env.contains("/elsewhere") && !env.contains("forged"),
        "a client value overrode the hub's"
    );
}

/// Run by `another_uid_gets_zero_bytes` inside a user namespace; not a test of its own.
#[test]
#[ignore = "helper process for another_uid_gets_zero_bytes"]
fn peer_probe() {
    let socket = std::env::var("WB_PROBE_SOCKET").unwrap();
    let mut c = Client::raw(socket.as_ref());
    println!("PROBE_BYTES={}", c.read_to_close());
}

#[test]
fn another_uid_gets_zero_bytes() {
    let hub = Hub::start();
    // Let the foreign uid reach the socket, so the peer check is what refuses it.
    fs::set_permissions(&hub.dir, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&hub.socket, fs::Permissions::from_mode(0o666)).unwrap();
    let exe = hub.dir.join("probe");
    fs::copy(std::env::current_exe().unwrap(), &exe).unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    // Plain `unshare -U -r` keeps the caller's uid as seen through SO_PEERCRED; mapping
    // root inside to a subordinate uid makes the probe a different user outside.
    let out = Command::new("unshare")
        .args(["--map-auto", "--setuid", "0", "--setgid", "0"])
        .arg(&exe)
        .args(["--exact", "peer_probe", "--ignored", "--nocapture"])
        .env("WB_PROBE_SOCKET", &hub.socket)
        .current_dir(&hub.dir)
        .output();
    let out = match out {
        Ok(out) => out,
        Err(e) => return eprintln!("SKIPPED another_uid_gets_zero_bytes: no unshare: {e}"),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let Some(bytes) = stdout.lines().find_map(|l| l.strip_prefix("PROBE_BYTES=")) else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return eprintln!(
            "SKIPPED another_uid_gets_zero_bytes: unshare --map-auto is unavailable \
             ({}): {}",
            out.status,
            stderr.trim()
        );
    };
    assert_eq!(bytes, "0", "a foreign uid got bytes:\n{stdout}");
    // The hub is still serving its own user.
    hub.connect().ok(json!({"t": "list"}));
}

#[test]
fn a_line_over_max_line_closes_the_connection() {
    let hub = Hub::start();
    // Exactly MAX_LINE is still a line.
    let mut c = hub.connect();
    let head = r#"{"t":"list","rid":7,"pad":""#;
    let mut line = head.as_bytes().to_vec();
    line.resize(MAX_LINE - 2, b'x');
    line.extend_from_slice(b"\"}\n");
    assert_eq!(line.len(), MAX_LINE + 1);
    c.write_raw(&line).unwrap();
    let reply = c.next().unwrap();
    assert_eq!(
        (&reply["t"], &reply["rid"]),
        (&json!("ok"), &json!(7)),
        "{reply}"
    );

    // One byte more closes it without a reply.
    let mut c = hub.connect();
    let mut line = vec![b'x'; MAX_LINE + 1];
    line.push(b'\n');
    let _ = c.write_raw(&line);
    assert_eq!(c.read_to_close(), 0);
    hub.connect().ok(json!({"t": "list"}));
}

#[test]
fn owed_replies_arrive_after_the_client_stops_sending() {
    let hub = Hub::start();
    let mut a = hub.connect();
    a.spawn("half", &["bash"]);
    // `list` is answered at once; `pty.kill{forget:true}` only after the child exited.
    let mut c = hub.connect();
    c.send(&json!({"t": "list", "rid": 1}));
    c.send(&json!({"t": "pty.kill", "rid": 2, "sid": "half", "forget": true}));
    c.shutdown_write();
    let mut replies = Vec::new();
    while let Some(m) = c.next() {
        replies.push((m["t"].clone(), m["rid"].clone()));
    }
    assert_eq!(replies, [(json!("ok"), json!(1)), (json!("ok"), json!(2))]);
}

#[test]
fn a_large_paste_arrives_whole() {
    let hub = Hub::start();
    let mut c = hub.connect();
    c.spawn("paste", &["bash"]);
    let n = 200 << 10;
    c.input(
        "paste",
        &format!(
            "stty raw -echo; echo READY$((5+5)); read -r -s -N {n} x; stty sane; echo LEN=${{#x}}\r"
        ),
    );
    c.output_until("paste", "READY10");
    let paste: String = (0..n).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
    c.input("paste", &paste);
    c.output_until("paste", &format!("LEN={n}"));
}

#[test]
fn input_beyond_the_queue_is_dropped_with_input_overflow() {
    let hub = Hub::start();
    let mut c = hub.connect();
    c.spawn(
        "full",
        &["bash", "-c", "stty raw -echo; echo R$((1+6)); sleep 60"],
    );
    c.output_until("full", "R7");
    let mib = "y".repeat(1 << 20);
    for _ in 0..9 {
        c.input("full", &mib);
    }
    let err = c.until("input_overflow", |m| m["t"] == "err");
    assert_eq!(err["sid"], "full", "{err}");
    assert_eq!(err["code"], "input_overflow", "{err}");
    c.ok(json!({"t": "pty.kill", "sid": "full", "forget": true}));
}

#[test]
fn kill_reaches_every_member_of_the_session() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let r = c.spawn("tree", &["bash"]);
    let shell = pid_of(&r);
    // A background job in its own process group that ignores SIGHUP: only the session
    // scan reaches it, and only SIGKILL ends it.
    c.input(
        "tree",
        "(trap '' HUP; exec sleep 300) & echo BG=$!=END$((7*7))\r",
    );
    let out = c.output_until("tree", "=END49");
    let (before, _) = out.rsplit_once("=END49").unwrap();
    let bg: u32 = before
        .rsplit_once("BG=")
        .and_then(|(_, pid)| pid.parse().ok())
        .unwrap_or_else(|| panic!("no background pid in {out:?}"));
    assert!(running(bg));

    c.ok(json!({"t": "pty.kill", "sid": "tree", "forget": false}));
    let exit = c.until("pty.exit", |m| m["t"] == "pty.exit");
    assert_eq!(exit["reason"], "killed", "{exit}");
    assert!(!running(shell), "the shell was not reaped");
    assert!(
        wait_gone(bg, Duration::from_secs(6)),
        "background job {bg} survived"
    );

    let list = c.ok(json!({"t": "list"}));
    let s = &list["sessions"][0];
    assert_eq!(s["alive"], false);
    assert_eq!(s["pty"]["exit"]["reason"], "killed");
    assert!(s["pty"].get("pid").is_none(), "{s}");
}

#[test]
fn exit_is_reported_and_the_corpse_can_be_attached_and_respawned() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let r = c.spawn("ex", &["bash", "-c", "echo BYE; exit 7"]);
    let pid = pid_of(&r);
    let exit = c.until("pty.exit", |m| m["t"] == "pty.exit");
    assert_eq!(
        exit,
        json!({"t": "pty.exit", "sid": "ex", "code": 7, "signal": null, "reason": "exited"})
    );
    assert!(!running(pid), "the child is a zombie or still running");

    let mut other = hub.connect();
    let corpse = other.ok(json!({"t": "pty.open", "sid": "ex", "cols": 80, "rows": 24}));
    assert_eq!(corpse["new"], false);
    assert_eq!(corpse["exit"]["code"], 7);
    assert!(
        corpse["replay"].as_str().unwrap().contains("BYE"),
        "{corpse}"
    );

    assert!(corpse.get("pid").is_none(), "{corpse}");
    let again = other.spawn("ex", &["bash", "-c", "exit 0"]);
    assert_eq!(again["new"], true);
    assert_ne!(again["pid"], r["pid"]);
    assert_eq!(
        again["epoch"], r["epoch"],
        "a respawn keeps the incarnation"
    );
}

#[test]
fn malformed_requests_get_errors() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let code = |c: &mut Client, msg| c.request(msg)["code"].clone();
    assert_eq!(code(&mut c, json!({"t": "no.such"})), "unknown_type");
    assert_eq!(
        code(
            &mut c,
            json!({"t": "pty.open", "sid": "nope", "cols": 80, "rows": 24})
        ),
        "not_found"
    );
    assert_eq!(
        code(
            &mut c,
            json!({"t": "pty.open", "sid": "../x", "cols": 80, "rows": 24})
        ),
        "bad_request"
    );
    assert_eq!(
        code(
            &mut c,
            json!({"t": "pty.kill", "sid": "nope", "forget": true})
        ),
        "not_found"
    );
    assert_eq!(
        code(&mut c, json!({"t": "pty.capture", "sid": "nope"})),
        "not_found"
    );
    assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
    c.send(&json!({"t": "list", "rid": 0}));
    assert_eq!(c.next().unwrap()["code"], "bad_request");

    let mut old = Client::raw(&hub.socket);
    old.next().unwrap();
    old.send(&json!({"t": "hello", "proto": 2, "client": "future"}));
    assert_eq!(old.next().unwrap()["code"], "proto");
    assert!(old.next().is_none());
}

#[test]
fn sigterm_hangs_up_the_shells_and_exits_cleanly() {
    let mut hub = Hub::start();
    let mut c = hub.connect();
    let pid = pid_of(&c.spawn("term", &["bash"]));
    let status = hub.terminate();
    assert!(status.success(), "{status}");
    assert!(
        wait_gone(pid, Duration::from_secs(5)),
        "shell {pid} survived the hub"
    );
    assert!(!hub.socket.exists());
}

#[test]
fn an_open_without_spawn_never_starts_a_process() {
    let hub = Hub::start();
    let mut c = hub.connect();
    assert_eq!(c.attach("ghost")["code"], "not_found");
    assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));

    let runs = hub.dir.join("runs");
    let cmd = format!("echo ran >> {}", runs.display());
    c.spawn("once", &["bash", "-c", &cmd]);
    c.until("pty.exit", |m| m["t"] == "pty.exit");
    let corpse = c.attach("once");
    assert_eq!(corpse["t"], "ok", "{corpse}");
    assert_eq!(corpse["new"], false, "{corpse}");
    assert_eq!(corpse["exit"]["reason"], "exited", "{corpse}");
    assert!(corpse.get("pid").is_none(), "{corpse}");
    let s = &c.ok(json!({"t": "list"}))["sessions"][0];
    assert_eq!(s["alive"], false, "{s}");
    assert_eq!(fs::read_to_string(&runs).unwrap(), "ran\n");
}

#[test]
fn resume_sends_the_ring_tail_and_a_stale_stream_gets_a_snapshot() {
    let hub = Hub::start();
    let mut a = hub.connect();
    let first = a.spawn("res", &["bash"]);
    let stream = first["stream"].as_u64().unwrap();
    a.input("res", "echo ONE$((0+1))\r");
    let (_, after_one) = a.output_until_at("res", "ONE1");
    a.input("res", "echo TWO$((1+1))\r");
    let (_, end) = a.output_until_at("res", "TWO2");

    let mut b = hub.connect();
    let open = |resume: Value| json!({"t": "pty.open", "sid": "res", "cols": 80, "rows": 24, "resume": resume});
    let r = b.ok(open(json!({"stream": stream, "out": after_one})));
    assert_eq!(r["resumed"], true, "{r}");
    assert_eq!(r["stream"], stream);
    let tail = r["replay"].as_str().unwrap();
    assert!(tail.contains("TWO2") && !tail.contains("ONE1"), "{r}");
    assert!(r["out"].as_u64().unwrap() >= end, "{r}");

    for stale in [
        json!({"stream": stream - 1, "out": after_one}),
        json!({"stream": stream, "out": end + (1 << 30)}),
    ] {
        let r = b.ok(open(stale));
        assert_eq!(r["resumed"], false, "{r}");
        let snapshot = r["replay"].as_str().unwrap();
        assert!(
            snapshot.contains("ONE1") && snapshot.contains("TWO2"),
            "{r}"
        );
    }
}

#[test]
fn gone_reaches_a_second_attached_connection_which_is_detached() {
    let hub = Hub::start();
    let mut a = hub.connect();
    let first = a.spawn("g", &["bash"]);
    let mut b = hub.connect();
    assert_eq!(b.attach("g")["t"], "ok");
    a.ok(json!({"t": "pty.kill", "sid": "g", "forget": true}));
    let gone = b.until("gone", |m| m["t"] == "gone");
    assert_eq!(
        gone,
        json!({"t": "gone", "sid": "g", "epoch": first["epoch"]})
    );
    // The next incarnation has only its opener as a viewer.
    a.spawn("g", &["bash"]);
    let s = &a.ok(json!({"t": "list"}))["sessions"][0];
    assert_eq!(s["viewers"], 1, "{s}");
}

/// Types `stty size` into `sid` from `c` and returns what it printed.
fn stty_size(c: &mut Client, sid: &str, n: u32) -> String {
    c.input(sid, &format!("echo SIZE=$(stty size)=E$(({n}+1))\r"));
    let out = c.output_until(sid, &format!("=E{}", n + 1));
    let (before, _) = out.rsplit_once(&format!("=E{}", n + 1)).unwrap();
    before.rsplit_once("SIZE=").unwrap().1.to_owned()
}

#[test]
fn an_open_sizes_only_a_sole_viewer_and_the_last_resize_wins() {
    let hub = Hub::start();
    let mut a = hub.connect();
    a.spawn("rs", &["bash"]);
    assert_eq!(stty_size(&mut a, "rs", 0), "24 80");

    let mut b = hub.connect();
    let open = json!({"t": "pty.open", "sid": "rs", "cols": 100, "rows": 30});
    b.ok(open.clone());
    assert_eq!(
        stty_size(&mut b, "rs", 1),
        "24 80",
        "a second viewer resized"
    );
    b.send(&json!({"t": "pty.resize", "sid": "rs", "cols": 120, "rows": 40}));
    assert_eq!(stty_size(&mut b, "rs", 2), "40 120");
    a.send(&json!({"t": "pty.resize", "sid": "rs", "cols": 90, "rows": 20}));
    assert_eq!(stty_size(&mut a, "rs", 3), "20 90");

    a.ok(json!({"t": "pty.detach", "sid": "rs"}));
    b.ok(open);
    assert_eq!(
        stty_size(&mut b, "rs", 4),
        "30 100",
        "the sole viewer's size"
    );
}

/// A child that prints `W<n>=<rows> <cols>.` on every SIGWINCH. `wait` returns on each
/// trapped signal, so none is merged with the next.
fn winch_counter(alt_screen: bool) -> String {
    let alt = if alt_screen {
        r"printf '\033[?1049h';"
    } else {
        ""
    };
    format!(
        "trap 'n=$((n+1)); echo W$n=$(stty size).' WINCH; {alt} echo READY$((6*7)); \
         sleep 1000 & while :; do wait $!; done"
    )
}

/// Collects output of `sid` until WINCH number `upto` is reported; returns every
/// `(n, "<rows> <cols>")` reported in it.
fn winches(c: &mut Client, sid: &str, upto: u32) -> Vec<(u32, String)> {
    let mut text = String::new();
    loop {
        let seen: Vec<(u32, String)> = text
            .split('W')
            .skip(1)
            .filter_map(|p| {
                let (n, rest) = p.split_once('=')?;
                let (size, _) = rest.split_once('.')?;
                Some((n.parse().ok()?, size.to_owned()))
            })
            .collect();
        if seen.iter().any(|(n, _)| *n == upto) {
            return seen;
        }
        text += &c.output_until(sid, ".");
    }
}

fn winch(n: u32, size: &str) -> (u32, String) {
    (n, size.to_owned())
}

#[test]
fn an_attach_to_the_alternate_screen_nudges_with_exactly_two_winches() {
    let hub = Hub::start();
    let mut a = hub.connect();
    a.spawn("alt", &["bash", "-c", &winch_counter(true)]);
    a.output_until("alt", "READY42");

    let mut b = hub.connect();
    assert_eq!(b.attach("alt")["t"], "ok");
    assert_eq!(
        winches(&mut b, "alt", 2),
        [winch(1, "23 80"), winch(2, "24 80")]
    );
    // The next WINCH is the resize's: the nudge sent no third one.
    b.send(&json!({"t": "pty.resize", "sid": "alt", "cols": 100, "rows": 30}));
    assert_eq!(winches(&mut b, "alt", 3), [winch(3, "30 100")]);
}

#[test]
fn an_attach_to_the_primary_screen_sends_no_winch_nor_does_an_unchanged_size() {
    let hub = Hub::start();
    let mut a = hub.connect();
    a.spawn("prim", &["bash", "-c", &winch_counter(false)]);
    a.output_until("prim", "READY42");

    let mut b = hub.connect();
    assert_eq!(b.attach("prim")["t"], "ok");
    let resize = |cols, rows| json!({"t": "pty.resize", "sid": "prim", "cols": cols, "rows": rows});
    b.send(&resize(100, 30));
    assert_eq!(winches(&mut b, "prim", 1), [winch(1, "30 100")]);
    b.send(&resize(100, 30));
    b.send(&resize(100, 31));
    assert_eq!(winches(&mut b, "prim", 2), [winch(2, "31 100")]);
}

#[test]
fn a_resize_during_the_nudge_cancels_its_restore() {
    let hub = Hub::start();
    let mut a = hub.connect();
    a.spawn("nc", &["bash", "-c", &winch_counter(true)]);
    a.output_until("nc", "READY42");

    let mut b = hub.connect();
    b.send(&json!({"t": "pty.open", "rid": 1, "sid": "nc", "cols": 80, "rows": 24}));
    b.send(&json!({"t": "pty.resize", "sid": "nc", "cols": 100, "rows": 30}));
    let before = b.output_until("nc", "30 100.");
    // Long enough for a restore that was not cancelled (50 ms) to land.
    std::thread::sleep(Duration::from_millis(200));
    b.send(&json!({"t": "pty.resize", "sid": "nc", "cols": 100, "rows": 31}));
    let after = b.output_until("nc", "31 100.");
    assert!(
        !before.contains("24 80") && !after.contains("24 80"),
        "the nudge restored over the resize: {before:?} {after:?}"
    );
}

#[test]
fn a_clean_restart_keeps_the_last_screen_in_a_hub_restart_corpse() {
    let mut hub = Hub::start();
    let mut c = hub.connect();
    let first = c.spawn("keep", &["bash"]);
    let pid = pid_of(&first);
    c.input("keep", "printf '\\033[31mLAST%s\\033[0m\\n' $((6*7))\r");
    c.output_until("keep", "LAST42");
    drop(c);
    assert!(hub.terminate().success());
    assert!(
        wait_gone(pid, Duration::from_secs(5)),
        "shell {pid} survived"
    );

    hub.restart();
    let mut c = hub.connect();
    let s = &c.ok(json!({"t": "list"}))["sessions"][0];
    assert_eq!(s["sid"], "keep", "{s}");
    assert_eq!(s["alive"], false, "{s}");
    assert_eq!(s["createdAt"], first["epoch"], "{s}");
    assert_eq!(s["pty"]["exit"]["reason"], "hub_restart", "{s}");
    let corpse = c.attach("keep");
    assert_eq!(corpse["new"], false, "{corpse}");
    assert_eq!(corpse["epoch"], first["epoch"], "{corpse}");
    assert_eq!(corpse["exit"]["reason"], "hub_restart", "{corpse}");
    assert!(
        corpse["replay"].as_str().unwrap().contains("LAST42"),
        "{corpse}"
    );
}

#[test]
fn a_crashed_hub_leaves_a_snapshot_at_most_30_s_stale() {
    let mut hub = Hub::start();
    let mut c = hub.connect();
    let pid = pid_of(&c.spawn("crash", &["bash"]));
    c.input("crash", "echo CRASH$((5*5))\r");
    c.output_until("crash", "CRASH25");
    let marked = SystemTime::now();
    let snap = hub.pty_file("crash.snap");
    let written = || {
        fs::metadata(&snap)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t >= marked)
    };
    let within = SNAPSHOT_EVERY + Duration::from_secs(2);
    eventually(within, "the periodic snapshot", written);
    let snapped = fs::metadata(&snap).unwrap().modified().unwrap();

    hub.kill9();
    // Without the hub nothing hangs up the shell; end it as systemd would.
    signal(pid, Signal::KILL);
    assert!(wait_gone(pid, Duration::from_secs(5)));
    // The crash left the socket file behind; the next hub replaces it.
    assert!(hub.socket.exists());
    hub.restart();
    let mut c = hub.connect();
    let corpse = c.attach("crash");
    assert!(
        corpse["replay"].as_str().unwrap().contains("CRASH25"),
        "{corpse}"
    );
    assert_eq!(corpse["exit"]["reason"], "hub_restart", "{corpse}");
    let at = snapped.duration_since(UNIX_EPOCH).unwrap().as_millis();
    assert_eq!(
        corpse["exit"]["at"].as_u64().map(u128::from),
        Some(at),
        "{corpse}"
    );
}

#[test]
fn a_corrupt_record_is_quarantined_while_a_healthy_session_loads() {
    let mut hub = Hub::start();
    let mut c = hub.connect();
    c.spawn("fine", &["bash", "-c", "echo FINE$((1+1))"]);
    c.until("pty.exit", |m| m["t"] == "pty.exit");
    drop(c);
    assert!(hub.terminate().success());
    fs::write(hub.pty_file("x.json"), "{not json").unwrap();
    fs::write(hub.pty_file("x.snap"), "junk").unwrap();

    hub.restart();
    let mut c = hub.connect();
    let list = c.ok(json!({"t": "list"}));
    let [fine, x] = list["sessions"].as_array().unwrap().as_slice() else {
        panic!("{list}")
    };
    assert_eq!(
        (&fine["sid"], &fine["fault"]),
        (&json!("fine"), &json!(null)),
        "{fine}"
    );
    assert_eq!(fine["pty"]["exit"]["reason"], "exited", "{fine}");
    assert_eq!(x["sid"], "x", "{x}");
    assert_eq!(x["alive"], false, "{x}");
    assert_eq!(x["fault"]["code"], "load_failed", "{x}");
    assert!(
        c.attach("fine")["replay"]
            .as_str()
            .unwrap()
            .contains("FINE2")
    );

    assert!(!hub.pty_file("x.json").exists());
    let mut kept: Vec<String> = fs::read_dir(hub.pty_file(""))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.starts_with("x."))
        .collect();
    kept.sort();
    assert_eq!(kept.len(), 2, "{kept:?}");
    assert!(
        kept[0].starts_with("x.quarantine-") && kept[0].ends_with(".json"),
        "{kept:?}"
    );
    assert!(
        kept[1].starts_with("x.quarantine-") && kept[1].ends_with(".snap"),
        "{kept:?}"
    );
}

/// Opens `sid` with `spawn` and returns the reply.
fn open_spawn(c: &mut Client, sid: &str, spawn: Value) -> Value {
    c.request(json!({"t": "pty.open", "sid": sid, "cols": 80, "rows": 24, "spawn": spawn}))
}

/// Runs `$0` and `$SHELL` through `spawn` in `sid` and returns them.
fn zero_and_shell(c: &mut Client, sid: &str, mut spawn: Value, n: u32) -> String {
    spawn["argv"] = json!(["any", "-c", format!("echo \"Z=$0 S=$SHELL\" E$(({n}+1))")]);
    let r = open_spawn(c, sid, spawn);
    assert_eq!(r["t"], "ok", "{r}");
    let out = c.output_until(sid, &format!("E{}", n + 1));
    c.until("pty.exit", |m| m["t"] == "pty.exit" && m["sid"] == sid);
    let (before, _) = out.rsplit_once(&format!(" E{}", n + 1)).unwrap();
    before.rsplit_once("Z=").unwrap().1.to_owned()
}

#[test]
fn a_named_shell_runs_with_its_resolved_path_as_0_and_shell() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let sh = format!("{} S={}", hub.sh, hub.sh);
    let bash = format!("{} S={}", hub.shell, hub.shell);
    assert_eq!(zero_and_shell(&mut c, "a", json!({"shell": "sh"}), 0), sh);
    assert_eq!(
        zero_and_shell(&mut c, "b", json!({}), 1),
        bash,
        "the default shell"
    );

    // A single argv item gets the shell's configured args.
    c.spawn("i", &["bash"]);
    c.input("i", "echo FLAGS=$-=END$((1+1))\r");
    let out = c.output_until("i", "=END2");
    let flags = out.rsplit_once("FLAGS=").unwrap().1;
    assert!(flags.split('=').next().unwrap().contains('i'), "{out:?}");
}

#[test]
fn an_unknown_or_unavailable_shell_is_a_bad_request() {
    let hub = Hub::start_with(|cfg| with_shell(cfg, "gone", &["/nonexistent/gone"]));
    let mut c = hub.connect();
    for name in ["gone", "zsh", "/bin/sh"] {
        let r = open_spawn(&mut c, "s", json!({"argv": ["x"], "shell": name}));
        assert_eq!(r["code"], "bad_request", "{r}");
        assert_eq!(r["message"], format!("shell {name} not available"), "{r}");
    }
    assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
}

#[test]
fn a_respawn_keeps_the_shell_also_after_a_restart() {
    let mut hub = Hub::start();
    let mut c = hub.connect();
    let sh = format!("{} S={}", hub.sh, hub.sh);
    assert_eq!(zero_and_shell(&mut c, "k", json!({"shell": "sh"}), 0), sh);
    assert_eq!(zero_and_shell(&mut c, "k", json!({}), 1), sh);
    drop(c);
    assert!(hub.terminate().success());

    hub.restart();
    let mut c = hub.connect();
    assert_eq!(zero_and_shell(&mut c, "k", json!({}), 2), sh);
    // A named shell on a respawn wins, and is kept from then on.
    let bash = format!("{} S={}", hub.shell, hub.shell);
    assert_eq!(
        zero_and_shell(&mut c, "k", json!({"shell": "bash"}), 3),
        bash
    );
    assert_eq!(zero_and_shell(&mut c, "k", json!({}), 4), bash);
}

#[test]
fn an_exec_failure_leaves_a_spawn_failed_corpse() {
    let dir = std::env::temp_dir().join(format!("wb-broken-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let broken = dir.join("broken");
    // Executable, but its interpreter does not exist: execve fails with ENOENT.
    fs::write(&broken, "#!/nonexistent/interpreter\n").unwrap();
    fs::set_permissions(&broken, fs::Permissions::from_mode(0o755)).unwrap();
    let hub = Hub::start_with(|cfg| with_shell(cfg, "broken", &[broken.to_str().unwrap()]));
    let mut c = hub.connect();
    let r = open_spawn(
        &mut c,
        "bad",
        json!({"argv": ["broken"], "shell": "broken"}),
    );
    assert_eq!(r["code"], "spawn_failed", "{r}");
    let s = &c.ok(json!({"t": "list"}))["sessions"][0];
    assert_eq!(s["sid"], "bad", "{s}");
    assert_eq!(s["alive"], false, "{s}");
    assert_eq!(s["pty"]["exit"]["reason"], "spawn_failed", "{s}");
    let corpse = c.attach("bad");
    assert_eq!(corpse["exit"]["reason"], "spawn_failed", "{corpse}");
    assert_eq!(corpse["exit"]["code"], json!(null), "{corpse}");
    // The corpse respawns with a working shell.
    let r = open_spawn(&mut c, "bad", json!({"argv": ["bash"], "shell": "bash"}));
    assert_eq!(r["new"], true, "{r}");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn capture_reads_the_screen_of_live_and_dead_sessions() {
    let hub = Hub::start();
    let mut c = hub.connect();
    c.spawn("cap", &["bash"]);
    c.input("cap", "echo CAP$((3*3))\r");
    c.output_until("cap", "CAP9");
    let capture = json!({"t": "pty.capture", "sid": "cap", "lines": 5});
    let live = c.ok(capture.clone());
    assert!(live["text"].as_str().unwrap().contains("CAP9"), "{live}");
    c.ok(json!({"t": "pty.kill", "sid": "cap", "forget": false}));
    c.until("pty.exit", |m| m["t"] == "pty.exit");
    let dead = c.ok(capture);
    assert!(dead["text"].as_str().unwrap().contains("CAP9"), "{dead}");
}

#[test]
fn the_foreground_process_is_polled() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let pid = pid_of(&c.spawn("fg", &["bash"]));
    c.input("fg", "sleep 30\r");
    let fg = c.until("pty.fg for sleep", |m| {
        m["t"] == "pty.fg" && m["comm"] == "sleep"
    });
    assert_eq!(fg["cwd"], hub.dir.join("home").to_str().unwrap(), "{fg}");
    let s = &c.ok(json!({"t": "list"}))["sessions"][0];
    let fg = &s["pty"]["fg"];
    assert_eq!(fg["comm"], "sleep", "{s}");
    assert_eq!(fg["leader"], false, "{s}");
    assert_ne!(fg["pgid"], pid, "{s}");
}

#[test]
fn a_panicking_session_actor_is_reloaded_from_disk() {
    if !cfg!(debug_assertions) {
        return eprintln!("SKIPPED: the panic hook exists in debug builds only");
    }
    let hub = Hub::start_with_env(|_| {}, &[("WB_HUB_TEST_PANIC_INPUT", "__panic__")]);
    let mut other = hub.connect();
    other.spawn("calm", &["bash"]);
    let mut a = hub.connect();
    let first = a.spawn("boom", &["bash"]);
    let pid = pid_of(&first);
    let mut b = hub.connect();
    assert_eq!(b.attach("boom")["t"], "ok");

    a.input("boom", "__panic__");
    let reloaded =
        json!({"t": "err", "sid": "boom", "code": "internal", "message": "session reloaded"});
    for c in [&mut a, &mut b] {
        assert_eq!(c.until("err", |m| m["t"] == "err"), reloaded);
    }
    assert!(
        wait_gone(pid, Duration::from_secs(5)),
        "shell {pid} survived"
    );
    let list = a.ok(json!({"t": "list"}));
    let [boom, calm] = list["sessions"].as_array().unwrap().as_slice() else {
        panic!("{list}")
    };
    assert_eq!(boom["alive"], false, "{boom}");
    assert_eq!(boom["createdAt"], first["epoch"], "{boom}");
    assert_eq!(boom["pty"]["exit"]["reason"], "hub_restart", "{boom}");
    assert_eq!(calm["alive"], true, "{calm}");

    let again = a.spawn("boom", &["bash"]);
    assert_eq!(again["new"], true, "{again}");
    assert_eq!(again["epoch"], first["epoch"], "{again}");
    assert_ne!(again["stream"], first["stream"], "{again}");
}

#[test]
fn a_second_hub_on_the_same_state_exits_1() {
    let hub = Hub::start();
    assert_eq!(hub.run_second().code(), Some(1));
    // The first hub still serves.
    let mut c = hub.connect();
    c.ok(json!({"t": "list"}));
}

#[test]
fn the_child_has_only_the_terminal_open() {
    let hub = Hub::start();
    let mut c = hub.connect();
    c.spawn(
        "fds",
        &["bash", "-c", "ls -l /proc/self/fd; echo END$((1+1))"],
    );
    let out = c.output_until("fds", "END2");
    let fds: Vec<(u32, &str)> = out
        .lines()
        .filter_map(|l| {
            let (left, target) = l.trim_end().split_once(" -> ")?;
            Some((left.rsplit(' ').next()?.parse().ok()?, target))
        })
        .collect();
    let tty: Vec<&str> = fds.iter().filter(|(fd, _)| *fd <= 2).map(|f| f.1).collect();
    assert_eq!(tty.len(), 3, "{out:?}");
    assert!(
        tty[0].starts_with("/dev/pts/") && tty.iter().all(|t| *t == tty[0]),
        "{out:?}"
    );
    // Anything else is the directory `ls` is listing.
    let other: Vec<&(u32, &str)> = fds.iter().filter(|(fd, _)| *fd > 2).collect();
    assert!(
        other.len() <= 1 && other.iter().all(|f| f.1.starts_with("/proc/")),
        "{out:?}"
    );
}

#[test]
fn a_death_by_signal_reports_the_signal() {
    let hub = Hub::start();
    let mut c = hub.connect();
    // SIGUSR1 terminates without a core dump.
    c.spawn("sig", &["bash", "-c", "kill -USR1 $$"]);
    let exit = c.until("pty.exit", |m| m["t"] == "pty.exit");
    assert_eq!(
        exit,
        json!({"t": "pty.exit", "sid": "sig", "code": null, "signal": 10, "reason": "exited"})
    );
}

#[test]
fn a_connection_that_stops_reading_is_closed_and_others_keep_receiving() {
    let hub = Hub::start();
    let mut a = hub.connect();
    // 6 MiB in paced bursts, 12 MiB as escaped JSON: three times the connection queue,
    // slow enough for a reader.
    let burst = "for i in $(seq 40); do yes | head -c 102400; sleep 0.05; done; \
                 echo DONE$((2*3)); exec sleep 1000";
    a.spawn("slow", &["bash", "-c", burst]);
    let mut b = hub.connect();
    assert_eq!(b.attach("slow")["t"], "ok");
    b.output_until("slow", "DONE6");
    a.read_to_close();
    let s = &b.ok(json!({"t": "list"}))["sessions"][0];
    assert_eq!(
        (&s["alive"], &s["viewers"]),
        (&json!(true), &json!(1)),
        "{s}"
    );
    let capture = b.ok(json!({"t": "pty.capture", "sid": "slow", "lines": 3}));
    assert!(
        capture["text"].as_str().unwrap().contains("DONE6"),
        "{capture}"
    );
}
