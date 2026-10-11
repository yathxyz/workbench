//! `hub.json`: read once at startup, never re-read.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde::Deserialize;

use crate::env::valid_env_name;

/// `sun_path` holds 108 bytes including the trailing NUL.
const SUN_PATH: usize = 108;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_socket")]
    pub socket: PathBuf,
    pub state_dir: PathBuf,
    pub host: String,
    pub child: ChildConfig,
    #[serde(default)]
    pub agents: BTreeMap<String, AgentConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ChildConfig {
    /// The shell for PTY children; never `$SHELL`.
    pub shell: String,
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
        if !self.child.shell.starts_with('/') {
            bail!("child.shell must be an absolute path");
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
        for (name, agent) in &self.agents {
            if !valid_agent_name(name) {
                bail!("agent name {name:?} must match ^[a-z0-9-]{{1,32}}$");
            }
            if !agent.argv.first().is_some_and(|a| a.starts_with('/')) {
                bail!("agents.{name}.argv[0] must be an absolute path");
            }
        }
        Ok(())
    }
}

fn valid_agent_name(name: &str) -> bool {
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
      "child": {
        "shell": "/run/current-system/sw/bin/bash",
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
        let cfg =
            parse(r#"{"stateDir": "/s", "host": "h", "child": {"shell": "/bin/bash"}}"#).unwrap();
        assert_eq!(cfg.socket, Path::new("/run/workbench-hub/hub.sock"));
        assert!(cfg.child.pass_env.is_empty() && cfg.child.set_env.is_empty());
        assert!(cfg.agents.is_empty());
    }

    #[test]
    fn unknown_fields_are_rejected() {
        assert!(with(|v| v["tmuxSocket"] = "/tmp/t".into()).is_err());
        assert!(with(|v| v["child"]["extra"] = 1.into()).is_err());
        assert!(with(|v| v["agents"]["omp"]["args"] = 1.into()).is_err());
    }

    #[test]
    fn validation_rejects_bad_values() {
        let long = format!("/{}", "s".repeat(107));
        assert!(with(|v| v["socket"] = long.into()).is_err());
        let fits = format!("/{}", "s".repeat(106));
        assert!(with(|v| v["socket"] = fits.into()).is_ok());
        assert!(with(|v| v["socket"] = "hub.sock".into()).is_err());
        assert!(with(|v| v["stateDir"] = "state".into()).is_err());
        assert!(with(|v| v["child"]["shell"] = "bash".into()).is_err());
        assert!(with(|v| v["child"]["passEnv"][0] = "BAD-NAME".into()).is_err());
        assert!(with(|v| v["child"]["setEnv"]["A=B"] = "x".into()).is_err());
        assert!(with(|v| v["agents"]["codex"]["env"]["1X"] = "x".into()).is_err());
        assert!(with(|v| v["agents"]["Claude"] = v["agents"]["claude"].clone()).is_err());
        let long_name = "a".repeat(33);
        assert!(with(|v| v["agents"][long_name] = v["agents"]["claude"].clone()).is_err());
        assert!(with(|v| v["agents"]["omp"]["argv"][0] = "omp".into()).is_err());
        assert!(with(|v| v["agents"]["omp"]["argv"] = serde_json::json!([])).is_err());
    }
}
