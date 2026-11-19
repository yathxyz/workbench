//! The hub must keep reading a session's mailbox while git holds an operation open.

mod common;

use std::env;
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use common::acp::group_members;
use common::{Client, Hub, PATIENCE, eventually};
use serde_json::{Value, json};

const PROMPTLY: Duration = Duration::from_secs(5);

fn program(name: &str) -> PathBuf {
    env::split_paths(&env::var_os("PATH").unwrap())
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|file| file.is_file())
        .unwrap_or_else(|| panic!("{name} missing from test PATH"))
}

fn git(hub: &Hub, args: &[&str]) -> String {
    let output = Command::new(hub.dir.join("git.real"))
        .current_dir(hub.home())
        .env_clear()
        .env("HOME", hub.home())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8(output.stdout).unwrap()
}

/// Sleep *after* real git registered an add, or *before* it removes anything. A
/// descendant holds the pipes, so killing the wrapper alone cannot pass these tests.
fn fixture(pause: &str) -> Hub {
    let hub = Hub::with_scenarios_and(&[], |cfg| {
        let dir = Path::new(cfg["stateDir"].as_str().unwrap())
            .parent()
            .unwrap();
        let shim = dir.join("git");
        symlink(program("git"), dir.join("git.real")).unwrap();
        fs::write(
            &shim,
            format!(
                r#"#!{}
export GIT_CONFIG_NOSYSTEM=1
case " $* " in
    *' worktree {pause} '*)
        if [ '{pause}' = add ]; then "$0.real" "$@" || exit $?; fi
        sleep 60 &
        printf '%s %s\n' "$$" "$!" > "$0.started"
        wait
        if [ '{pause}' = add ]; then exit 0; fi ;;
esac
exec "$0.real" "$@"
"#,
                cfg["shells"][0]["paths"][0].as_str().unwrap()
            ),
        )
        .unwrap();
        fs::set_permissions(&shim, fs::Permissions::from_mode(0o700)).unwrap();
        cfg["agents"]["missing"] = json!({"label": "Missing", "argv": [dir.join("not-installed")]});
        cfg["git"] = json!(shim);
    });
    git(&hub, &["init", "-b", "main"]);
    git(&hub, &["commit", "--allow-empty", "-m", "seed"]);
    hub
}

fn open(hub: &Hub, agent: &str) -> Value {
    json!({"t": "acp.open", "rid": 90, "sid": "managed", "since": 0,
           "spawn": {"agent": agent, "cwd": hub.home(), "worktree": {"branch": "topic"}}})
}

fn sleeping_group(hub: &Hub) -> u32 {
    let path = hub.dir.join("git.started");
    eventually(PATIENCE, "git and its child started", || {
        fs::read_to_string(&path).is_ok_and(|s| s.ends_with('\n'))
    });
    let pids = fs::read_to_string(path).unwrap();
    let (group, child) = pids.trim().split_once(' ').unwrap();
    let group = group.parse().unwrap();
    assert!(group_members(group).contains(&child.parse().unwrap()));
    group
}

/// More commands than both the 8-slot mailbox and the per-connection in-flight
/// limit. If the actor waits on git, the pileup blocks even a different sid *on the
/// same socket*. A second sender can fill the entire mailbox on its own.
fn assert_responsive(hub: &Hub, c: &mut Client, published: bool) {
    let mut filler = hub.connect();
    for sender in [&mut filler, &mut *c] {
        for rid in 100..116 {
            let t = if rid % 2 == 0 {
                "acp.revive"
            } else {
                "acp.remove_worktree"
            };
            sender.send(&json!({"t": t, "sid": "managed", "rid": rid}));
        }
    }
    c.send(
        &json!({"t": "acp.open", "rid": 200, "sid": "unrelated", "since": 0,
                   "spawn": {"agent": "missing", "cwd": hub.home()}}),
    );
    let other = c.reply_within(200, PROMPTLY);
    assert_eq!(other["new"], true, "{other}");
    for sender in [&mut filler, &mut *c] {
        for rid in 100..116 {
            let busy = sender.reply_within(rid, PROMPTLY);
            assert_eq!(busy["code"], "conflict", "{busy}");
            assert_eq!(busy["message"], "worktree operation in progress");
        }
    }
    let list = c.ok(json!({"t": "list"}));
    assert_eq!(
        list["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["sid"] == "managed"),
        published,
        "{list}"
    );
}

fn registered(hub: &Hub, path: &Path) -> bool {
    let wanted = format!("worktree {}", path.display());
    git(hub, &["worktree", "list", "--porcelain", "-z"])
        .split('\0')
        .any(|field| field == wanted)
}

#[test]
fn kill_and_forget_cancel_unpublished_worktree_add() {
    for forget in [false, true] {
        let hub = fixture("add");
        let wt = hub.dir.join("home-wt/topic");
        let mut c = hub.connect();
        c.send(&open(&hub, "stub"));
        let group = sleeping_group(&hub);
        assert!(wt.join(".git").is_file() && registered(&hub, &wt));
        assert_responsive(&hub, &mut c, false);

        c.send(&json!({"t": "acp.kill", "rid": 300, "sid": "managed", "forget": forget}));
        assert_eq!(c.reply_within(300, PROMPTLY), json!({"t":"ok", "rid":300}));
        // Not just eventually: the cleanup is part of the kill reply.
        assert!(!wt.exists() && !registered(&hub, &wt));
        assert_eq!(
            git(&hub, &["rev-parse", "topic"]),
            git(&hub, &["rev-parse", "HEAD"])
        );
        assert!(fs::read_dir(hub.acp_file("")).unwrap().all(|f| {
            !f.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("managed.")
        }));
        let interrupted = c.reply_within(90, PROMPTLY);
        assert_eq!(interrupted["code"], "conflict", "{interrupted}");
        assert_eq!(c.acp_open("managed", 0)["code"], "not_found");
        assert!(hub.record("stub").is_empty());
        eventually(PROMPTLY, "cancelled git process group gone", || {
            group_members(group).is_empty()
        });
    }
}

#[test]
fn shutdown_aborts_worktree_add_remove_and_prepublication_rollback() {
    for phase in ["add", "remove", "rollback"] {
        let mut hub = fixture(if phase == "rollback" { "remove" } else { phase });
        let mut c = hub.connect();
        if phase == "rollback" {
            // Refuse the new session after worktree add, as in the daemon conformance test.
            fs::create_dir(hub.acp_file("managed.jsonl")).unwrap();
        }
        c.send(&open(&hub, "missing"));
        let published = phase == "remove";
        if published {
            let made = c.reply(90);
            assert_eq!(made["summary"]["alive"], false, "{made}");
            c.send(&json!({"t": "acp.remove_worktree", "rid": 91, "sid": "managed"}));
        }
        let group = sleeping_group(&hub);
        assert_responsive(&hub, &mut c, published);
        let start = Instant::now();
        assert!(hub.terminate().success());
        eventually(
            PROMPTLY.saturating_sub(start.elapsed()),
            "git group gone on shutdown",
            || group_members(group).is_empty(),
        );
        assert!(start.elapsed() < PROMPTLY, "shutdown waited for git");
        assert_eq!(hub.acp_file("managed.json").exists(), published);
    }
}
