//! `hub.json`: read once at startup, never re-read.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use rustix::fs::{Access, access};
use serde::Deserialize;

use crate::env::valid_env_name;

/// `sun_path` holds 108 bytes including the trailing NUL.
const SUN_PATH: usize = 108;

/// What the hub sets in every PTY child (DESIGN §3.7.3 step 1); the module's assertion
/// lists the same names.
const FIXED_CHILD_ENV: [&str; 7] = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "WB_SESSION",
    "TERM",
    "COLORTERM",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_socket")]
    pub socket: PathBuf,
    pub state_dir: PathBuf,
    pub host: String,
    /// The shells a PTY can run, in the order `hello` lists them; never `$SHELL`.
    pub shells: Vec<ShellConfig>,
    /// The name of the shell a spawn without `shell` runs.
    pub default_shell: String,
    pub child: ChildConfig,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShellConfig {
    pub name: String,
    /// Absolute candidates; the first that exists and is executable at spawn time runs.
    pub paths: Vec<String>,
    /// Appended when a spawn's `argv` has a single item.
    pub args: Vec<String>,
}

impl ShellConfig {
    /// The first of `paths` that is an executable regular file right now.
    pub fn resolve(&self) -> Option<&str> {
        self.paths.iter().map(String::as_str).find(|p| {
            let p = Path::new(p);
            p.is_file() && access(p, Access::EXEC_OK).is_ok()
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChildConfig {
    /// Names copied from the hub's own environment into every child.
    #[serde(default)]
    pub pass_env: Vec<String>,
    /// Values set in every child; they override `pass_env`.
    #[serde(default)]
    pub set_env: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    pub label: String,
    pub argv: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

fn default_socket() -> PathBuf {
    PathBuf::from("/run/workbench-hub/hub.sock")
}

pub fn load(path: &Path) -> anyhow::Result<Config> {
    let text = std::fs::read_to_string(path).with_context(|| format!("{}", path.display()))?;
    let cfg: Config = serde_json::from_str(&text).with_context(|| format!("{}", path.display()))?;
    cfg.validate()
        .with_context(|| format!("{}", path.display()))?;
    Ok(cfg)
}

impl Config {
    pub fn shell(&self, name: &str) -> Option<&ShellConfig> {
        self.shells.iter().find(|s| s.name == name)
    }

    /// The names of the shells that have an executable path right now.
    pub fn available_shells(&self) -> Vec<String> {
        self.shells
            .iter()
            .filter(|s| s.resolve().is_some())
            .map(|s| s.name.clone())
            .collect()
    }

    fn validate(&self) -> anyhow::Result<()> {
        if !self.socket.is_absolute() {
            bail!("socket must be an absolute path");
        }
        if self.socket.as_os_str().len() >= SUN_PATH {
            bail!("socket path must be shorter than {SUN_PATH} bytes");
        }
        if !self.state_dir.is_absolute() {
            bail!("stateDir must be an absolute path");
        }
        let mut seen = BTreeSet::new();
        for shell in &self.shells {
            let name = &shell.name;
            if !valid_name(name) {
                bail!("shell name {name:?} must match ^[a-z0-9-]{{1,32}}$");
            }
            if !seen.insert(name) {
                bail!("shell {name} is listed twice");
            }
            if shell.paths.is_empty() || !shell.paths.iter().all(|p| absolute(p)) {
                bail!("shells.{name}.paths must be one or more absolute paths");
            }
            if shell.args.iter().any(|a| a.contains('\0')) {
                bail!("shells.{name}.args must not contain NUL");
            }
        }
        if self.shell(&self.default_shell).is_none() {
            bail!("defaultShell {:?} is not in shells", self.default_shell);
        }
        let names = self
            .child
            .pass_env
            .iter()
            .chain(self.child.set_env.keys())
            .chain(self.agents.values().flat_map(|a| a.env.keys()));
        for name in names {
            if !valid_env_name(name) {
                bail!("invalid environment variable name {name:?}");
            }
        }
        let mut child = self.child.pass_env.iter().chain(self.child.set_env.keys());
        if let Some(name) = child.find(|n| FIXED_CHILD_ENV.contains(&n.as_str())) {
            bail!("child.passEnv and child.setEnv must not name {name}: the hub sets it");
        }
        for (name, agent) in &self.agents {
            if !valid_name(name) {
                bail!("agent name {name:?} must match ^[a-z0-9-]{{1,32}}$");
            }
            if !agent.argv.first().is_some_and(|a| absolute(a)) {
                bail!("agents.{name}.argv[0] must be an absolute path");
            }
        }
        Ok(())
    }
}

fn absolute(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0')
}

/// Agent and shell names: `^[a-z0-9-]{1,32}$`.
fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"{
      "socket": "/run/workbench-hub/hub.sock",
      "stateDir": "/home/alice/.local/state/workbench/hub",
      "host": "example",
      "shells": [
        {"name": "bash", "paths": ["/etc/profiles/per-user/alice/bin/bash", "/run/current-system/sw/bin/bash"], "args": ["-i"]},
        {"name": "nu", "paths": ["/etc/profiles/per-user/alice/bin/nu", "/run/current-system/sw/bin/nu"], "args": ["-i"]}
      ],
      "defaultShell": "bash",
      "child": {
        "passEnv": ["LANG","LOCALE_ARCHIVE","TZDIR","TERMINFO_DIRS","NIX_PATH","NIX_PROFILES","XDG_CONFIG_DIRS","XDG_DATA_DIRS","EDITOR","PAGER"],
        "setEnv": {
          "PATH": "/run/wrappers/bin:/etc/profiles/per-user/alice/bin:/run/current-system/sw/bin:/etc/workbench/bin",
          "WB_SOCKET": "/run/workbench-web/web.sock"
        }
      },
      "agents": {
        "claude": {"label": "Claude",   "argv": ["/etc/workbench/agents/claude/bin/claude-agent-acp"], "env": {}},
        "codex":  {"label": "Codex",    "argv": ["/etc/workbench/agents/codex/bin/codex-acp"], "env": {"RUST_LOG": "error"}},
        "omp":    {"label": "oh-my-pi", "argv": ["/etc/profiles/per-user/alice/bin/omp", "acp"], "env": {}}
      }
    }"#;

    fn parse(text: &str) -> anyhow::Result<Config> {
        let cfg: Config = serde_json::from_str(text)?;
        cfg.validate()?;
        Ok(cfg)
    }

    fn with(edit: impl FnOnce(&mut serde_json::Value)) -> anyhow::Result<Config> {
        let mut v: serde_json::Value = serde_json::from_str(EXAMPLE).unwrap();
        edit(&mut v);
        parse(&v.to_string())
    }

    #[test]
    fn the_design_example_parses() {
        let cfg = parse(EXAMPLE).unwrap();
        assert_eq!(cfg.host, "example");
        assert_eq!(cfg.default_shell, "bash");
        assert_eq!(cfg.shell("nu").unwrap().args, ["-i"]);
        assert_eq!(
            cfg.shells.iter().map(|s| &s.name[..]).collect::<Vec<_>>(),
            ["bash", "nu"]
        );
        assert_eq!(cfg.child.pass_env.len(), 10);
        assert_eq!(
            cfg.child.set_env["WB_SOCKET"],
            "/run/workbench-web/web.sock"
        );
        assert_eq!(cfg.agents["codex"].env["RUST_LOG"], "error");
        assert_eq!(
            cfg.agents["omp"].argv,
            ["/etc/profiles/per-user/alice/bin/omp", "acp"]
        );
    }

    #[test]
    fn socket_defaults_and_lists_default_to_empty() {
        let cfg = parse(
            r#"{"stateDir": "/s", "host": "h", "child": {}, "defaultShell": "sh",
                "shells": [{"name": "sh", "paths": ["/bin/sh"], "args": []}]}"#,
        )
        .unwrap();
        assert_eq!(cfg.socket, Path::new("/run/workbench-hub/hub.sock"));
        assert!(cfg.child.pass_env.is_empty() && cfg.child.set_env.is_empty());
        assert!(cfg.agents.is_empty());
    }

    #[test]
    fn unknown_fields_are_rejected() {
        assert!(with(|v| v["tmuxSocket"] = "/tmp/t".into()).is_err());
        assert!(with(|v| v["child"]["extra"] = 1.into()).is_err());
        assert!(with(|v| v["child"]["shell"] = "/bin/bash".into()).is_err());
        assert!(with(|v| v["shells"][0]["extra"] = 1.into()).is_err());
        assert!(with(|v| v["agents"]["omp"]["args"] = 1.into()).is_err());
    }

    #[test]
    fn a_shell_resolves_to_its_first_executable_path() {
        let exe = std::env::current_exe().unwrap();
        let exe = exe.to_str().unwrap();
        let dir = std::env::temp_dir().join(format!("wb-config-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain");
        std::fs::write(&plain, "not a program").unwrap();
        let shell = ShellConfig {
            name: "x".into(),
            paths: vec![
                "/nonexistent/x".into(),
                plain.to_str().unwrap().into(),
                dir.to_str().unwrap().into(),
                exe.into(),
            ],
            args: Vec::new(),
        };
        assert_eq!(shell.resolve(), Some(exe));
        let missing = ShellConfig {
            paths: vec!["/nonexistent/x".into()],
            ..shell
        };
        assert_eq!(missing.resolve(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn validation_rejects_bad_values() {
        let long = format!("/{}", "s".repeat(107));
        assert!(with(|v| v["socket"] = long.into()).is_err());
        let fits = format!("/{}", "s".repeat(106));
        assert!(with(|v| v["socket"] = fits.into()).is_ok());
        assert!(with(|v| v["socket"] = "hub.sock".into()).is_err());
        assert!(with(|v| v["stateDir"] = "state".into()).is_err());
        assert!(with(|v| v["shells"][1]["paths"][0] = "nu".into()).is_err());
        assert!(with(|v| v["shells"][1]["paths"] = serde_json::json!([])).is_err());
        assert!(with(|v| v["shells"][1]["name"] = "Nu".into()).is_err());
        assert!(with(|v| v["shells"][1]["name"] = "bash".into()).is_err());
        assert!(with(|v| v["shells"][1]["args"][0] = "a\0b".into()).is_err());
        assert!(with(|v| v["defaultShell"] = "zsh".into()).is_err());
        assert!(with(|v| v["shells"] = serde_json::json!([])).is_err());
        assert!(with(|v| v["child"]["passEnv"][0] = "BAD-NAME".into()).is_err());
        assert!(with(|v| v["child"]["setEnv"]["A=B"] = "x".into()).is_err());
        assert!(with(|v| v["agents"]["codex"]["env"]["1X"] = "x".into()).is_err());
        assert!(with(|v| v["agents"]["Claude"] = v["agents"]["claude"].clone()).is_err());
        let long_name = "a".repeat(33);
        assert!(with(|v| v["agents"][long_name] = v["agents"]["claude"].clone()).is_err());
        assert!(with(|v| v["agents"]["omp"]["argv"][0] = "omp".into()).is_err());
        assert!(with(|v| v["agents"]["omp"]["argv"] = serde_json::json!([])).is_err());
    }

    #[test]
    fn the_fixed_child_variables_cannot_be_configured() {
        for name in FIXED_CHILD_ENV {
            let pass = with(|v| v["child"]["passEnv"][0] = name.into());
            assert!(pass.is_err_and(|e| e.to_string().contains(name)), "{name}");
            assert!(
                with(|v| v["child"]["setEnv"][name] = "x".into()).is_err(),
                "{name}"
            );
        }
    }
}
