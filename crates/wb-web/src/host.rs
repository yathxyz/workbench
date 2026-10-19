//! Processes and systemd units, read only (design §3.5.5, M5-W3). Unit control is
//! refused for good. Paths are relative to `/api`.
//!
//! `/proc` is read directly: every process wb-web can see, with the board card whose
//! shell it is (`node`, from the hub's session list) and the unit whose cgroup holds it.
//! Units come from the system manager through `systemctl` (on the service's `PATH`),
//! never through a shell; a unit name is checked before it reaches an argv.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::time::timeout;

use crate::AppState;
use crate::http::{ApiError, Param};

/// The most processes one listing returns.
const PROCS_MAX: usize = 4000;
/// How long a `systemctl` call may take.
const SYSTEMCTL_WAIT: Duration = Duration::from_secs(5);
/// How long `/api/units` and `/api/status` reuse one listing.
const UNITS_FRESH: Duration = Duration::from_secs(10);
/// The `systemctl status` lines kept from the journal.
const STATUS_LINES: &str = "--lines=30";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/proc", get(procs))
        .route("/units", get(units))
        .route("/unit/{name}", get(unit))
        .route("/unit/{name}/{verb}", post(unit_control))
}

// ---- processes

/// One process, in the shape of the frontend's `ProcInfo`.
#[derive(Clone, Debug, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub comm: String,
    pub state: String,
    pub cwd: Option<String>,
    pub cmd: String,
    /// Start time, seconds since the epoch.
    pub start: u64,
    /// Resident set, bytes.
    pub rss: u64,
    pub unit: Option<String>,
}

impl Proc {
    fn to_json(&self, node: Option<&String>) -> Value {
        let mut v = json!({
            "pid": self.pid, "ppid": self.ppid, "comm": self.comm, "state": self.state,
            "cwd": self.cwd, "cmd": self.cmd, "start": self.start, "rss": self.rss, "unit": self.unit,
        });
        if let Some(n) = node {
            v["node"] = json!(n);
        }
        v
    }
}

/// `comm`, state, ppid and starttime (clock ticks since boot) of a `/proc/<pid>/stat`
/// line. `comm` is in parentheses and may hold spaces and `)`, so the fields after it
/// are found from the last `)`.
pub fn parse_stat(line: &str) -> Option<(String, String, u32, u64)> {
    let open = line.find('(')?;
    let close = line.rfind(')')?;
    let comm = line.get(open + 1..close)?.to_owned();
    let rest: Vec<&str> = line.get(close + 1..)?.split_whitespace().collect();
    // rest[0] is field 3 (state); starttime is field 22.
    let state = (*rest.first()?).to_owned();
    let ppid = rest.get(1)?.parse().ok()?;
    let start = rest.get(19)?.parse().ok()?;
    Some((comm, state, ppid, start))
}

/// The unit a process belongs to, from `/proc/<pid>/cgroup`: the innermost
/// `.service` or `.scope` of its v2 (`0::`) path.
pub fn unit_of_cgroup(text: &str) -> Option<String> {
    let path = text
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .or_else(|| text.lines().next().and_then(|l| l.splitn(3, ':').nth(2)))?;
    path.rsplit('/')
        .find(|s| s.ends_with(".service") || s.ends_with(".scope"))
        .map(str::to_owned)
}

/// `btime` from `/proc/stat`: boot time, seconds since the epoch.
pub fn parse_btime(text: &str) -> Option<u64> {
    text.lines()
        .find_map(|l| l.strip_prefix("btime "))
        .and_then(|v| v.trim().parse().ok())
}

fn read_proc(root: &Path, pid: u32, btime: u64, hz: u64, page: u64) -> Option<Proc> {
    let dir = root.join(pid.to_string());
    let (comm, state, ppid, ticks) = parse_stat(&fs::read_to_string(dir.join("stat")).ok()?)?;
    let cmd = fs::read(dir.join("cmdline"))
        .map(|b| {
            let s = String::from_utf8_lossy(&b);
            s.trim_end_matches('\0').replace('\0', " ")
        })
        .unwrap_or_default();
    let rss = fs::read_to_string(dir.join("statm"))
        .ok()
        .and_then(|t| t.split_whitespace().nth(1)?.parse::<u64>().ok())
        .map_or(0, |pages| pages * page);
    let cwd = fs::read_link(dir.join("cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let unit = fs::read_to_string(dir.join("cgroup"))
        .ok()
        .and_then(|t| unit_of_cgroup(&t));
    Some(Proc {
        pid,
        ppid,
        comm,
        state,
        cwd,
        cmd,
        start: btime + ticks / hz.max(1),
        rss,
        unit,
    })
}

/// Every process under `root` (normally `/proc`) that can be read, by pid. One that
/// exits during the walk is left out.
pub fn list_procs(root: &Path) -> Vec<Proc> {
    let btime = fs::read_to_string(root.join("stat"))
        .ok()
        .and_then(|t| parse_btime(&t))
        .unwrap_or(0);
    let hz = rustix::param::clock_ticks_per_second();
    let page = rustix::param::page_size() as u64;
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut pids: Vec<u32> = entries
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    pids.sort_unstable();
    pids.into_iter()
        .filter_map(|pid| read_proc(root, pid, btime, hz, page))
        .take(PROCS_MAX)
        .collect()
}

/// The board card each process is the shell of: a live PTY session's pid is its sid.
fn shell_nodes(app: &AppState) -> HashMap<u32, String> {
    app.hub
        .sessions()
        .into_iter()
        .filter(|s| s.alive)
        .filter_map(|s| Some((s.pty.as_ref()?.pid?, s.sid)))
        .collect()
}

async fn procs(State(app): State<AppState>) -> Json<Value> {
    let nodes = shell_nodes(&app);
    let list = tokio::task::spawn_blocking(|| list_procs(Path::new("/proc")))
        .await
        .unwrap_or_default();
    let procs: Vec<Value> = list.iter().map(|p| p.to_json(nodes.get(&p.pid))).collect();
    Json(json!({"host": app.cfg.host, "procs": procs}))
}

/// The processes of one unit, for `/api/unit/{name}`.
async fn procs_of(app: &AppState, unit: &str) -> Vec<Value> {
    let nodes = shell_nodes(app);
    let unit = unit.to_owned();
    tokio::task::spawn_blocking(move || {
        list_procs(Path::new("/proc"))
            .into_iter()
            .filter(|p| p.unit.as_deref() == Some(unit.as_str()))
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_default()
    .iter()
    .map(|p| p.to_json(nodes.get(&p.pid)))
    .collect()
}

// ---- units

/// A unit name `systemctl` may be given: the characters systemd allows in one, never a
/// leading `-` (an option) and never a path.
pub fn is_unit_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 256
        && !s.starts_with('-')
        && !s.starts_with('.')
        && s.bytes().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, b':' | b'_' | b'.' | b'@' | b'-' | b'\\')
        })
}

/// Runs `systemctl ARGS`: its stdout, or an error message. A non-zero exit is not an
/// error when `any_exit` (`systemctl status` exits 3 for an inactive unit).
async fn systemctl(args: &[&str], any_exit: bool) -> Result<String, String> {
    let child = Command::new("systemctl")
        .args(args)
        .env("SYSTEMD_COLORS", "0")
        .env("SYSTEMD_PAGER", "")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("systemctl is not available: {e}"))?;
    let out = timeout(SYSTEMCTL_WAIT, child.wait_with_output())
        .await
        .map_err(|_| "systemctl did not answer within 5 s".to_owned())?
        .map_err(|e| format!("systemctl failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() || (any_exit && !stdout.is_empty()) {
        Ok(stdout)
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err
            .trim()
            .lines()
            .next()
            .unwrap_or("systemctl failed")
            .to_owned())
    }
}

/// The units of `systemctl list-units --output=json`, as `{unit, load, active, sub,
/// description}`.
pub fn parse_units(text: &str) -> Result<Vec<Value>, String> {
    let list: Vec<Value> =
        serde_json::from_str(text).map_err(|e| format!("cannot read systemctl's list: {e}"))?;
    let s = |u: &Value, k: &str| u.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    Ok(list
        .iter()
        .filter(|u| u.get("unit").is_some_and(Value::is_string))
        .map(|u| {
            json!({"unit": s(u, "unit"), "load": s(u, "load"), "active": s(u, "active"),
                   "sub": s(u, "sub"), "description": s(u, "description")})
        })
        .collect())
}

/// A listing of the units, or why there is none.
type Units = Result<Vec<Value>, String>;

/// The last listing and when it was taken.
static UNITS: Mutex<Option<(Instant, Units)>> = Mutex::new(None);

/// The system manager's units, reused for `UNITS_FRESH`.
async fn unit_list() -> Units {
    if let Some((at, list)) = UNITS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        && at.elapsed() < UNITS_FRESH
    {
        return list.clone();
    }
    let list = match systemctl(
        &["list-units", "--output=json", "--no-pager", "--plain"],
        false,
    )
    .await
    {
        Ok(text) => parse_units(&text),
        Err(e) => Err(e),
    };
    *UNITS.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), list.clone()));
    list
}

/// `{total, active, failed, failedNames}` for `/api/status`; `error` instead of the
/// counts' meaning when the units cannot be listed.
pub async fn unit_counts() -> Value {
    match unit_list().await {
        Ok(units) => {
            let state = |u: &Value| u["active"].as_str().unwrap_or("").to_owned();
            let failed: Vec<Value> = units
                .iter()
                .filter(|u| state(u) == "failed")
                .map(|u| u["unit"].clone())
                .collect();
            json!({
                "total": units.len(),
                "active": units.iter().filter(|u| state(u) == "active").count(),
                "failed": failed.len(),
                "failedNames": failed,
            })
        }
        Err(e) => json!({"total": 0, "active": 0, "failed": 0, "failedNames": [], "error": e}),
    }
}

async fn units(State(app): State<AppState>) -> Json<Value> {
    match unit_list().await {
        Ok(units) => Json(json!({"host": app.cfg.host, "units": units, "error": null})),
        Err(e) => Json(json!({"host": app.cfg.host, "units": [], "error": e})),
    }
}

/// `KEY=VALUE` lines of `systemctl show` as an object.
pub fn parse_show(text: &str) -> Value {
    let mut props = serde_json::Map::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            props.insert(k.to_owned(), json!(v));
        }
    }
    Value::Object(props)
}

const SHOW: &str = "--property=Id,Description,LoadState,ActiveState,SubState,MainPID,\
                    ExecMainStartTimestamp,FragmentPath,Result";

async fn unit(State(app): State<AppState>, Param(name): Param<String>) -> Json<Value> {
    if !is_unit_name(&name) {
        return Json(
            json!({"unit": name, "props": {}, "status": "", "error": "bad unit name", "procs": []}),
        );
    }
    let status_args = ["status", "--no-pager", "--full", STATUS_LINES, "--", &name];
    let show_args = ["show", "--no-pager", SHOW, "--", &name];
    let (status, props) = tokio::join!(systemctl(&status_args, true), systemctl(&show_args, false));
    let error = match (&status, &props) {
        (Err(e), _) | (_, Err(e)) => Value::from(e.as_str()),
        _ => Value::Null,
    };
    Json(json!({
        "unit": name,
        "props": props.map(|t| parse_show(&t)).unwrap_or_else(|_| json!({})),
        "status": status.unwrap_or_default(),
        "error": error,
        "procs": procs_of(&app, &name).await,
    }))
}

/// Workbench never starts or stops units.
async fn unit_control(Param((_, verb)): Param<(String, String)>) -> ApiError {
    match verb.as_str() {
        "start" | "stop" | "restart" => ApiError::new(
            StatusCode::FORBIDDEN,
            "unit control is disabled in Workbench; use ssh",
        ),
        _ => ApiError::new(StatusCode::NOT_FOUND, "not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_keeps_a_comm_with_spaces_and_parentheses() {
        let line = "4242 (tmux: (server)) S 1 4242 4242 0 -1 4194560 1 0 0 0 3 1 0 0 20 0 1 0 98765 1000 300 18446744073709551615";
        assert_eq!(
            parse_stat(line),
            Some(("tmux: (server)".into(), "S".into(), 1, 98765))
        );
        assert_eq!(parse_stat("1 (init S 0"), None);
    }

    #[test]
    fn the_unit_is_the_innermost_service_or_scope() {
        assert_eq!(
            unit_of_cgroup(
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/foo.service\n"
            )
            .as_deref(),
            Some("foo.service")
        );
        assert_eq!(
            unit_of_cgroup("0::/system.slice/workbench.slice/workbench-hub.service\n").as_deref(),
            Some("workbench-hub.service")
        );
        assert_eq!(
            unit_of_cgroup("0::/user.slice/user-1000.slice/session-3.scope\n").as_deref(),
            Some("session-3.scope")
        );
        assert_eq!(unit_of_cgroup("0::/\n"), None);
    }

    #[test]
    fn btime_is_read_from_proc_stat() {
        assert_eq!(
            parse_btime("cpu  1 2 3\nbtime 1791600000\nprocesses 9\n"),
            Some(1_791_600_000)
        );
        assert_eq!(parse_btime("cpu 1\n"), None);
    }

    #[test]
    fn unit_names_never_look_like_options_or_paths() {
        for ok in [
            "workbench-hub.service",
            "user@1000.service",
            "dev-disk-by\\x2duuid.device",
            "a:b.mount",
        ] {
            assert!(is_unit_name(ok), "{ok}");
        }
        for bad in ["", "-H", "--host=x", "../x", "a/b", "a b", ".hidden", "a;b"] {
            assert!(!is_unit_name(bad), "{bad}");
        }
    }

    #[test]
    fn units_take_the_five_fields_of_systemctl_json() {
        let text = r#"[{"unit":"a.service","load":"loaded","active":"failed","sub":"failed","description":"A"},{"x":1}]"#;
        assert_eq!(
            parse_units(text).unwrap(),
            vec![
                json!({"unit":"a.service","load":"loaded","active":"failed","sub":"failed","description":"A"})
            ]
        );
        assert!(parse_units("not json").is_err());
    }

    #[test]
    fn show_lines_become_props() {
        assert_eq!(
            parse_show("Id=a.service\nMainPID=7\nDescription=x=y\n"),
            json!({"Id":"a.service","MainPID":"7","Description":"x=y"})
        );
    }

    #[test]
    fn this_process_is_listed_with_its_parent_and_command() {
        let me = std::process::id();
        let list = list_procs(Path::new("/proc"));
        let p = list
            .iter()
            .find(|p| p.pid == me)
            .expect("own process listed");
        assert_eq!(
            p.ppid,
            rustix::process::getppid().map_or(0, |p| p.as_raw_nonzero().get() as u32)
        );
        assert!(!p.cmd.is_empty() && p.rss > 0 && p.start > 1_000_000_000);
        assert_eq!(
            p.cwd.as_deref(),
            std::env::current_dir()
                .ok()
                .as_deref()
                .and_then(Path::to_str)
        );
    }
}
