//! The environment of a child, built from scratch (DESIGN §3.7.3).
//!
//! Nothing is inherited from the hub except `HOME`, `USER`, `LOGNAME` and the names in
//! `child.passEnv`, so `NOTIFY_SOCKET`, `INVOCATION_ID`, `CREDENTIALS_DIRECTORY` and the
//! like never reach a child.

use std::collections::BTreeMap;
use std::ffi::OsString;

use crate::config::ChildConfig;

/// Most entries in a client-supplied `env`.
const CLIENT_ENV_MAX: usize = 32;
/// Longest value in a client-supplied `env`.
const CLIENT_VALUE_MAX: usize = 4096;

/// Who the children run as, read from the hub's own environment at startup.
#[derive(Debug)]
pub struct Identity {
    pub home: String,
    pub user: String,
    pub logname: String,
}

impl Identity {
    pub fn from_env() -> anyhow::Result<Self> {
        let get = |name: &str| {
            std::env::var(name).map_err(|e| anyhow::anyhow!("{name} in the hub's environment: {e}"))
        };
        Ok(Self {
            home: get("HOME")?,
            user: get("USER")?,
            logname: get("LOGNAME")?,
        })
    }
}

/// `^[A-Za-z_][A-Za-z0-9_]{0,63}$`
pub fn valid_env_name(name: &str) -> bool {
    let b = name.as_bytes();
    (1..=64).contains(&b.len())
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|&c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Checks a client-supplied `SpawnPty.env`; an error is a `bad_request` message.
pub fn check_client_env(env: &BTreeMap<String, String>) -> Result<(), String> {
    if env.len() > CLIENT_ENV_MAX {
        return Err(format!("env has more than {CLIENT_ENV_MAX} entries"));
    }
    for (key, value) in env {
        if !valid_env_name(key) {
            return Err(format!("env key {key:?} is not a valid name"));
        }
        if value.len() > CLIENT_VALUE_MAX {
            return Err(format!(
                "env value of {key} exceeds {CLIENT_VALUE_MAX} bytes"
            ));
        }
        if value.contains('\0') {
            return Err(format!("env value of {key} contains NUL"));
        }
    }
    Ok(())
}

/// The complete environment of a PTY child. `hub_env` looks a name up in the hub's own
/// environment; `client` must have passed [`check_client_env`].
pub fn pty_env(
    child: &ChildConfig,
    who: &Identity,
    sid: &str,
    client: Option<&BTreeMap<String, String>>,
    hub_env: impl Fn(&str) -> Option<OsString>,
) -> Vec<(OsString, OsString)> {
    let mut env: BTreeMap<OsString, OsString> = [
        ("HOME", who.home.as_str()),
        ("USER", &who.user),
        ("LOGNAME", &who.logname),
        ("SHELL", &child.shell),
        ("WB_SESSION", sid),
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    for name in &child.pass_env {
        if let Some(value) = hub_env(name) {
            env.insert(name.into(), value);
        }
    }
    for (name, value) in &child.set_env {
        env.insert(name.into(), value.into());
    }
    for (name, value) in client.into_iter().flatten() {
        env.entry(name.into()).or_insert_with(|| value.into());
    }
    env.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child() -> ChildConfig {
        ChildConfig {
            shell: "/bin/bash".into(),
            pass_env: vec!["LANG".into(), "EDITOR".into(), "MISSING".into()],
            set_env: [("PATH", "/set/bin"), ("EDITOR", "vi")]
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        }
    }

    fn who() -> Identity {
        Identity {
            home: "/home/alice".into(),
            user: "alice".into(),
            logname: "alice".into(),
        }
    }

    /// A hub environment full of things that must never reach a child.
    fn hub_env(name: &str) -> Option<OsString> {
        let v = match name {
            "LANG" => "C.UTF-8",
            "EDITOR" => "nano",
            "PATH" => "/hub/bin",
            "ANTHROPIC_API_KEY" | "GITHUB_TOKEN" => "secret",
            "NOTIFY_SOCKET" => "/run/systemd/notify",
            "CREDENTIALS_DIRECTORY" => "/run/credentials/x",
            "INVOCATION_ID" | "JOURNAL_STREAM" | "LISTEN_FDS" => "1",
            "XDG_RUNTIME_DIR" => "/run/user/1000",
            _ => return None,
        };
        Some(v.into())
    }

    fn build(client: Option<&BTreeMap<String, String>>) -> BTreeMap<String, String> {
        pty_env(&child(), &who(), "n_abc", client, hub_env)
            .into_iter()
            .map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap()))
            .collect()
    }

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn only_the_listed_keys_exist() {
        let env = build(None);
        let expect = map(&[
            ("COLORTERM", "truecolor"),
            ("EDITOR", "vi"),
            ("HOME", "/home/alice"),
            ("LANG", "C.UTF-8"),
            ("LOGNAME", "alice"),
            ("PATH", "/set/bin"),
            ("SHELL", "/bin/bash"),
            ("TERM", "xterm-256color"),
            ("USER", "alice"),
            ("WB_SESSION", "n_abc"),
        ]);
        assert_eq!(env, expect);
    }

    #[test]
    fn the_client_cannot_override_hub_keys() {
        let client = map(&[
            ("PATH", "/evil"),
            ("WB_SESSION", "other"),
            ("TERM", "dumb"),
            ("HOME", "/tmp"),
            ("CANVAS_NODE", "n_abc"),
        ]);
        let env = build(Some(&client));
        assert_eq!(env["PATH"], "/set/bin");
        assert_eq!(env["WB_SESSION"], "n_abc");
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["HOME"], "/home/alice");
        assert_eq!(env["CANVAS_NODE"], "n_abc");
    }

    #[test]
    fn env_names() {
        for ok in ["A", "_", "a_1", "PATH", &"X".repeat(64)] {
            assert!(valid_env_name(ok), "{ok}");
        }
        for bad in ["", "1A", "A-B", "A=B", "Ä", " A", &"X".repeat(65)] {
            assert!(!valid_env_name(bad), "{bad}");
        }
    }

    #[test]
    fn client_env_limits() {
        let full: BTreeMap<String, String> =
            (0..32).map(|i| (format!("K{i}"), "v".into())).collect();
        assert!(check_client_env(&full).is_ok());
        let mut over = full.clone();
        over.insert("K32".into(), "v".into());
        assert!(check_client_env(&over).is_err());
        assert!(check_client_env(&map(&[("A", &"v".repeat(4096))])).is_ok());
        assert!(check_client_env(&map(&[("A", &"v".repeat(4097))])).is_err());
        assert!(check_client_env(&map(&[("A", "x\0y")])).is_err());
        assert!(check_client_env(&map(&[("A-B", "x")])).is_err());
    }
}
