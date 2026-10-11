//! PTY sessions against the real `wb-hub` binary.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::Duration;

use common::{CANARIES, Client, Hub, running, wait_gone};
use serde_json::json;
use wb_proto::limits::MAX_LINE;

#[test]
fn hello_names_the_hub() {
    let hub = Hub::start();
    let c = hub.connect();
    assert_eq!(c.hello["proto"], 1);
    assert_eq!(c.hello["server"], "wb-hub");
    assert_eq!(c.hello["host"], "example");
    assert_eq!(c.hello["pid"], hub.pid());
    assert_eq!(c.hello["agents"], json!([]));
}

#[test]
fn spawn_and_echo() {
    let hub = Hub::start();
    let mut c = hub.connect();
    let r = c.spawn("echo", &[&hub.shell]);
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
    let first = a.spawn("att", &[&hub.shell]);
    a.input("att", "echo MARK$((1+1))\r");
    a.output_until("att", "MARK2");

    let mut b = hub.connect();
    let r = b.ok(json!({"t": "pty.open", "sid": "att", "cols": 80, "rows": 24}));
    assert_eq!(r["new"], false, "{r}");
    assert_eq!(r["resumed"], false, "{r}");
    assert_eq!(r["pid"], first["pid"]);
    assert_eq!(r["epoch"], first["epoch"]);
    assert!(r["replay"].as_str().unwrap().contains("MARK2"), "{r}");

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
    let first = c.spawn("kf", &[&hub.shell]);
    let pid = first["pid"].as_u64().unwrap() as u32;
    let epoch = first["epoch"].as_u64().unwrap();

    c.ok(json!({"t": "pty.kill", "sid": "kf", "forget": true}));
    // By the time of the reply the child is gone and the session is forgotten.
    assert!(!running(pid), "child {pid} still running after kill-forget");
    assert_eq!(c.ok(json!({"t": "list"}))["sessions"], json!([]));
    let gone = c.until("gone", |m| m["t"] == "gone");
    assert_eq!(gone, json!({"t": "gone", "sid": "kf", "epoch": epoch}));
    let gone = watcher.until("gone", |m| m["t"] == "gone");
    assert_eq!(gone["epoch"], epoch);

    let r = c.request(json!({"t": "pty.open", "sid": "kf", "cols": 80, "rows": 24}));
    assert_eq!(r["code"], "not_found", "{r}");
    let again = c.spawn("kf", &[&hub.shell]);
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
    let first = a.spawn("race", &[&hub.shell]);
    let shell = first["pid"].as_u64().unwrap() as u32;
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
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while fs::exists(format!("/proc/{shell}")).unwrap() {
        assert!(std::time::Instant::now() < deadline, "the shell survived");
        std::thread::sleep(Duration::from_millis(5));
    }

    // Within the drain: open with spawn and type at once, without waiting for the reply.
    let mut b = hub.connect();
    b.send(
        &json!({"t": "pty.open", "rid": 100, "sid": "race", "cols": 80, "rows": 24,
                   "spawn": {"argv": [&hub.shell]}}),
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
            "argv": [&hub.shell, "-c", "export -p; echo END$((3+3))"],
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
fn a_large_paste_arrives_whole() {
    let hub = Hub::start();
    let mut c = hub.connect();
    c.spawn("paste", &[&hub.shell]);
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
        &[&hub.shell, "-c", "stty raw -echo; echo R$((1+6)); sleep 60"],
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
    let r = c.spawn("tree", &[&hub.shell]);
    let shell = r["pid"].as_u64().unwrap() as u32;
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
    let r = c.spawn("ex", &[&hub.shell, "-c", "echo BYE; exit 7"]);
    let pid = r["pid"].as_u64().unwrap() as u32;
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

    let again = other.spawn("ex", &[&hub.shell, "-c", "exit 0"]);
    assert_eq!(again["new"], true);
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
        "internal"
    );
    let argv = json!({"argv": ["/nonexistent/program"]});
    assert_eq!(
        code(
            &mut c,
            json!({"t": "pty.open", "sid": "bad", "cols": 80, "rows": 24, "spawn": argv})
        ),
        "spawn_failed"
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
    let pid = c.spawn("term", &[&hub.shell])["pid"].as_u64().unwrap() as u32;
    let status = hub.terminate();
    assert!(status.success(), "{status}");
    assert!(
        wait_gone(pid, Duration::from_secs(5)),
        "shell {pid} survived the hub"
    );
    assert!(!hub.socket.exists());
}
