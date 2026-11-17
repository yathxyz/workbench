//! `web.json` (design §3.7.1): parsing, validation and the proxy secret.
//!
//! Unknown keys are refused: a misspelt auth key must stop startup, never be ignored.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, ensure};
use serde::Deserialize;

use crate::api::{Client, Gate, Scope};
use crate::auth::Floor;

/// Longest unix socket path, `sun_path` included its terminating NUL.
const SOCKET_PATH_MAX: usize = 108;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    pub listen: SocketAddr,
    pub public_origin: String,
    pub trusted_proxy: IpAddr,
    pub proxy_secret_file: PathBuf,
    /// `web.sock`, for the `wb` CLI.
    #[serde(default = "default_socket")]
    pub socket: PathBuf,
    #[serde(default = "default_hub_socket")]
    pub hub_socket: PathBuf,
    pub state_dir: PathBuf,
    pub web_root: PathBuf,
    pub boards_dir: PathBuf,
    pub notes_dir: PathBuf,
    /// Names the board file; also reported to the frontend.
    pub host: String,
    /// edwind's `edit.sock`. Absent means no edwind: the notes endpoints stay stubs and
    /// `sample` stays off (edwind spec R15.5).
    pub edit_socket: Option<PathBuf>,
    /// edwin-web (the console page, the frame runtime and its Scheme), served at
    /// `/edwin/`. It comes from the same Edwin as the edwind on `editSocket`, so frames
    /// and daemon match. Absent, `/edwin/` is whatever `webRoot` holds under `edwin/`.
    pub edwin_web_root: Option<PathBuf>,
    /// The destinations `POST /api/mv` refuses, shared with edwind (R14.8). Absent
    /// means the built-in list.
    pub refuse_paths: Option<Vec<String>>,
    /// Image providers for the canvas's media cards (F-A41). Absent means none: the
    /// cards that make images say so, and describe and expand still use `sample`.
    pub media: Option<MediaConfig>,
    /// The mesh API (design §3.8.1). Absent means no listener and no registry of
    /// observed sessions.
    pub api: Option<ApiConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiConfig {
    /// An address on the mesh interface, never a wildcard.
    pub listen: SocketAddr,
    /// By name, as refusals are logged.
    pub clients: BTreeMap<String, ApiClient>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ApiClient {
    /// 64 lowercase hex characters, read at startup.
    pub token_file: PathBuf,
    pub scopes: BTreeSet<Scope>,
    /// The host this client's events are filed under; required with `events`.
    pub host: Option<String>,
    /// The only peer address the token is accepted from.
    pub address: Option<IpAddr>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaConfig {
    /// By name, as the card's provider menu shows it.
    pub providers: BTreeMap<String, MediaProvider>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct MediaProvider {
    pub api: MediaApi,
    /// https, or http to loopback; the key goes only here.
    pub base_url: String,
    /// The key, sent as `Authorization: Bearer`. Read at each request, so a rotated
    /// key needs no restart. Absent for a local server that takes none.
    pub key_file: Option<PathBuf>,
    /// The models offered, the first being the default.
    pub models: Vec<String>,
}

/// The protocol a provider speaks.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum MediaApi {
    /// The OpenAI image API (`/images/generations`, `/images/edits`), which xAI, LocalAI
    /// and other servers also speak.
    Openai,
    /// Hugging Face Inference (`/models/{model}`): text to image, image to image.
    Huggingface,
}

fn default_socket() -> PathBuf {
    "/run/workbench-web/web.sock".into()
}

fn default_hub_socket() -> PathBuf {
    "/run/workbench-hub/hub.sock".into()
}

/// Reads and validates the config at `path` and builds the auth floor from it, and the
/// API's gate when `api` is configured.
pub fn load(path: &Path) -> Result<(Config, Floor, Option<Gate>)> {
    let text = std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    let cfg: Config =
        serde_json::from_slice(&text).with_context(|| format!("config {}", path.display()))?;
    cfg.validate()?;
    let (expected_origin, expected_host) = parse_origin(&cfg.public_origin)?;
    let floor = Floor {
        trusted_proxy: cfg.trusted_proxy.to_canonical(),
        secret: read_secret(&cfg.proxy_secret_file, "proxy secret")?,
        expected_host,
        expected_origin,
    };
    let gate = cfg.api.as_ref().map(gate).transpose()?;
    Ok((cfg, floor, gate))
}

/// Reads every client's token. Two clients with one token are refused: a request
/// would match both.
fn gate(api: &ApiConfig) -> Result<Gate> {
    let mut clients = Vec::new();
    for (name, c) in &api.clients {
        let token = read_secret(&c.token_file, &format!("api client {name}: token"))?;
        ensure!(
            clients
                .iter()
                .all(|other: &Arc<Client>| other.token != token),
            "api client {name}: its token is also another client's"
        );
        clients.push(Arc::new(Client {
            name: name.clone(),
            token,
            scopes: c.scopes.clone(),
            host: c.host.clone(),
            address: c.address.map(|a| a.to_canonical()),
        }));
    }
    Ok(Gate { clients })
}

impl Config {
    fn validate(&self) -> Result<()> {
        let paths = [
            ("proxySecretFile", &self.proxy_secret_file),
            ("socket", &self.socket),
            ("hubSocket", &self.hub_socket),
            ("stateDir", &self.state_dir),
            ("webRoot", &self.web_root),
            ("boardsDir", &self.boards_dir),
            ("notesDir", &self.notes_dir),
        ];
        for (key, path) in paths {
            ensure!(path.is_absolute(), "{key} must be an absolute path");
        }
        if let Some(edit) = &self.edit_socket {
            ensure!(edit.is_absolute(), "editSocket must be an absolute path");
        }
        if let Some(root) = &self.edwin_web_root {
            ensure!(root.is_absolute(), "edwinWebRoot must be an absolute path");
        }
        let sockets = [
            ("socket", Some(&self.socket)),
            ("hubSocket", Some(&self.hub_socket)),
            ("editSocket", self.edit_socket.as_ref()),
        ];
        for (key, path) in sockets {
            ensure!(
                path.is_none_or(|p| p.as_os_str().len() < SOCKET_PATH_MAX),
                "{key} must be shorter than {SOCKET_PATH_MAX} bytes"
            );
        }
        for (i, (a, pa)) in sockets.iter().enumerate() {
            for (b, pb) in &sockets[i + 1..] {
                ensure!(
                    pa.is_none() || pa != pb,
                    "{a} and {b} must be different paths"
                );
            }
        }
        ensure!(
            valid_host(&self.host),
            "host must match [A-Za-z0-9][A-Za-z0-9._-]*"
        );
        for (name, p) in self.media.iter().flat_map(|m| &m.providers) {
            ensure!(
                !name.is_empty()
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')),
                "media provider names must match [A-Za-z0-9_-]+"
            );
            ensure!(
                https_or_loopback(&p.base_url),
                "media provider {name}: baseUrl must be https, or http to loopback"
            );
            ensure!(
                !p.models.is_empty()
                    && p.models
                        .iter()
                        .all(|m| !m.is_empty() && !m.chars().any(char::is_control)),
                "media provider {name}: models must list at least one model"
            );
            if let Some(key) = &p.key_file {
                ensure!(
                    key.is_absolute(),
                    "media provider {name}: keyFile must be an absolute path"
                );
            }
        }
        if let Some(api) = &self.api {
            ensure!(
                !api.listen.ip().is_unspecified(),
                "api.listen must not be a wildcard address"
            );
            ensure!(
                api.listen != self.listen,
                "api.listen must differ from listen"
            );
            ensure!(!api.clients.is_empty(), "api.clients must name a client");
            for (name, c) in &api.clients {
                ensure!(
                    (1..=32).contains(&name.len())
                        && name
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
                    "api client names must match ^[a-z0-9-]{{1,32}}$"
                );
                ensure!(
                    c.token_file.is_absolute(),
                    "api client {name}: tokenFile must be an absolute path"
                );
                ensure!(
                    !c.scopes.is_empty(),
                    "api client {name}: scopes must name a scope"
                );
                ensure!(
                    c.host.is_some() || !c.scopes.contains(&Scope::Events),
                    "api client {name}: the events scope needs a host"
                );
                ensure!(
                    c.host.as_deref().is_none_or(valid_host),
                    "api client {name}: host must match [A-Za-z0-9][A-Za-z0-9._-]*"
                );
            }
        }
        for path in self.refuse_paths.iter().flatten() {
            ensure!(
                path.starts_with('/') || path == "~" || path.starts_with("~/"),
                "refusePaths entries must be absolute paths or start with ~/"
            );
        }
        Ok(())
    }
}

/// `https://…`, or `http://` to 127.0.0.0/8, `localhost` or `[::1]`, with no user part.
fn https_or_loopback(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    match scheme {
        "https" => true,
        "http" => {
            let host = match authority.strip_prefix('[') {
                Some(v6) => v6.split(']').next().unwrap_or(""),
                None => authority.split(':').next().unwrap_or(""),
            };
            host == "localhost" || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
        }
        _ => false,
    }
}

/// A host name usable as a file name: no separators, no leading dot.
fn valid_host(host: &str) -> bool {
    host.bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphanumeric())
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Splits `publicOrigin` into the `Origin` and `Host` values a browser sends for it:
/// lowercase `scheme://authority`, and the authority alone.
fn parse_origin(origin: &str) -> Result<(String, String)> {
    let bad = |why: &str| anyhow!("publicOrigin {origin:?}: {why}");
    let (scheme, rest) = origin
        .split_once("://")
        .ok_or_else(|| bad("expected scheme://host"))?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "https" => 443,
        "http" => 80,
        _ => return Err(bad("the scheme must be http or https")),
    };
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    ensure!(
        !authority.is_empty()
            && authority
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b)),
        bad("expected only a host and an optional port, with no path, query, fragment or user")
    );
    let (host, port) = match authority.strip_prefix('[') {
        Some(bracketed) => {
            let (ip, after) = bracketed.split_once(']').ok_or_else(|| bad("unclosed ["))?;
            ensure!(ip.parse::<Ipv6Addr>().is_ok(), bad("bad IPv6 address"));
            let port = match after {
                "" => None,
                _ => Some(after.strip_prefix(':').ok_or_else(|| bad("bad port"))?),
            };
            (ip, port)
        }
        None => match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        },
    };
    ensure!(
        !host.is_empty() && !host.contains(['[', ']']),
        bad("bad host")
    );
    if let Some(port) = port {
        let n = port
            .parse::<u16>()
            .ok()
            .filter(|n| *n != 0 && n.to_string() == port)
            .ok_or_else(|| bad("bad port"))?;
        ensure!(
            n != default_port,
            bad("remove the default port; browsers never send it")
        );
    }
    let authority = authority.to_ascii_lowercase();
    Ok((format!("{scheme}://{authority}"), authority))
}

/// A secret is 64 lowercase hex characters; trailing whitespace is ignored. `what` names
/// it in errors, which never include the file's content.
fn read_secret(path: &Path, what: &str) -> Result<Box<[u8]>> {
    let raw = std::fs::read(path)
        .with_context(|| format!("cannot read {what} file {}", path.display()))?;
    let secret = raw.trim_ascii_end();
    ensure!(
        secret.len() == 64
            && secret
                .iter()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
        "{what} file {} malformed",
        path.display()
    );
    Ok(secret.into())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    const SECRET: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    struct Fixture {
        dir: tempfile::TempDir,
        cfg: Value,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let secret = dir.path().join("secret");
            std::fs::write(&secret, format!("{SECRET}\n")).unwrap();
            let cfg = json!({
                "listen": "127.0.0.1:8090",
                "publicOrigin": "https://wb.example.org",
                "trustedProxy": "192.0.2.1",
                "proxySecretFile": secret,
                "stateDir": "/home/alice/.local/state/workbench/web",
                "webRoot": "/srv/workbench-web",
                "boardsDir": "/home/alice/boards",
                "notesDir": "/home/alice/notes",
                "host": "box1",
            });
            Fixture { dir, cfg }
        }

        fn load(&self) -> Result<(Config, Floor, Option<Gate>)> {
            let path = self.dir.path().join("web.json");
            std::fs::write(&path, self.cfg.to_string()).unwrap();
            load(&path)
        }

        fn secret(&self, content: &str) -> &Self {
            std::fs::write(self.dir.path().join("secret"), content).unwrap();
            self
        }
    }

    #[test]
    fn a_complete_config_loads() {
        let (cfg, floor, _) = Fixture::new().load().unwrap();
        assert_eq!(cfg.hub_socket, Path::new("/run/workbench-hub/hub.sock"));
        assert!(cfg.edit_socket.is_none());
        assert!(cfg.refuse_paths.is_none());
        assert_eq!(floor.expected_origin, "https://wb.example.org");
        assert_eq!(floor.expected_host, "wb.example.org");
        assert_eq!(&*floor.secret, SECRET.as_bytes());
    }

    #[test]
    fn an_ipv4_mapped_trusted_proxy_is_canonicalised() {
        let mut f = Fixture::new();
        f.cfg["trustedProxy"] = json!("::ffff:192.0.2.1");
        let (_, floor, _) = f.load().unwrap();
        assert_eq!(floor.trusted_proxy, "192.0.2.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn missing_required_keys_fail() {
        for key in ["listen", "publicOrigin", "trustedProxy", "proxySecretFile"] {
            let mut f = Fixture::new();
            f.cfg.as_object_mut().unwrap().remove(key);
            assert!(f.load().is_err(), "{key}");
        }
    }

    #[test]
    fn unknown_keys_fail_and_so_does_the_removed_sample_key() {
        let mut f = Fixture::new();
        f.cfg["origins"] = json!("*");
        assert!(f.load().is_err());
        // `sample` moved to edit.json (edwind spec R15.6); an old config must say so.
        let mut f = Fixture::new();
        f.cfg["sample"] = json!({"apiKeyFile": "/k", "baseUrl": "https://api.example.org"});
        let err = format!("{:#}", f.load().err().unwrap());
        assert!(err.contains("unknown field `sample`"), "{err}");
        let mut f = Fixture::new();
        f.cfg["sample"] = Value::Null;
        assert!(f.load().is_err());
    }

    #[test]
    fn the_sockets_must_differ() {
        for (key, other) in [
            ("hubSocket", "socket"),
            ("editSocket", "socket"),
            ("editSocket", "hubSocket"),
        ] {
            let mut f = Fixture::new();
            f.cfg[key] = json!("/run/workbench/one.sock");
            f.cfg[other] = json!("/run/workbench/one.sock");
            let err = format!("{:#}", f.load().err().unwrap());
            assert!(
                err.contains("must be different paths"),
                "{key} {other}: {err}"
            );
        }
    }

    #[test]
    fn edit_socket_and_refuse_paths_load() {
        let mut f = Fixture::new();
        f.cfg["editSocket"] = json!("/run/edwind/edit.sock");
        f.cfg["refusePaths"] = json!(["/home/alice/.ssh", "~/.config/systemd"]);
        let (cfg, _, _) = f.load().unwrap();
        assert_eq!(
            cfg.edit_socket.as_deref(),
            Some(Path::new("/run/edwind/edit.sock"))
        );
        assert_eq!(
            cfg.refuse_paths.as_deref(),
            Some(
                &[
                    "/home/alice/.ssh".to_owned(),
                    "~/.config/systemd".to_owned()
                ][..]
            )
        );
        let mut f = Fixture::new();
        f.cfg["editSocket"] = Value::Null;
        f.cfg["refusePaths"] = Value::Null;
        let (cfg, _, _) = f.load().unwrap();
        assert!(cfg.edit_socket.is_none());
        assert!(cfg.refuse_paths.is_none());
    }

    #[test]
    fn media_providers_load_and_are_checked() {
        let mut f = Fixture::new();
        f.cfg["media"] = json!({"providers": {
            "openai": {"api": "openai", "baseUrl": "https://api.openai.com/v1", "keyFile": "/run/k", "models": ["gpt-image-1"]},
            "local": {"api": "huggingface", "baseUrl": "http://127.0.0.1:7860", "models": ["flux"]},
        }});
        let (cfg, _, _) = f.load().unwrap();
        let p = &cfg.media.as_ref().unwrap().providers;
        assert_eq!(p.keys().collect::<Vec<_>>(), ["local", "openai"]);
        assert_eq!(p["openai"].api, MediaApi::Openai);
        assert!(p["local"].key_file.is_none());
        let bad = [
            json!({"x y": {"api": "openai", "baseUrl": "https://a.example", "models": ["m"]}}),
            json!({"p": {"api": "openai", "baseUrl": "http://api.example.org", "models": ["m"]}}),
            json!({"p": {"api": "openai", "baseUrl": "http://user@127.0.0.1/", "models": ["m"]}}),
            json!({"p": {"api": "openai", "baseUrl": "https://a.example", "models": []}}),
            json!({"p": {"api": "openai", "baseUrl": "https://a.example", "models": ["m"], "keyFile": "k"}}),
            json!({"p": {"api": "comfy", "baseUrl": "https://a.example", "models": ["m"]}}),
            json!({"p": {"api": "openai", "baseUrl": "https://a.example", "models": ["m"], "key": "sk-1"}}),
        ];
        for providers in bad {
            let mut f = Fixture::new();
            f.cfg["media"] = json!({ "providers": providers });
            assert!(f.load().is_err(), "{providers}");
        }
    }

    #[test]
    fn loopback_urls() {
        for ok in [
            "https://api.x.ai/v1",
            "http://127.0.0.1:8080/v1",
            "http://localhost/x",
            "http://[::1]:9/",
        ] {
            assert!(https_or_loopback(ok), "{ok}");
        }
        for no in [
            "http://10.0.0.1/",
            "ftp://a/",
            "https://",
            "http://127.0.0.1.example.org/",
            "file:///x",
        ] {
            assert!(!https_or_loopback(no), "{no}");
        }
    }

    #[test]
    fn edit_socket_must_be_an_absolute_short_path() {
        let mut f = Fixture::new();
        f.cfg["editSocket"] = json!("run/edit.sock");
        assert!(f.load().is_err());
        f.cfg["editSocket"] = json!(format!("/{}", "s".repeat(120)));
        assert!(f.load().is_err());
    }

    #[test]
    fn refuse_paths_must_be_absolute_or_under_home() {
        for bad in [json!(["relative/dir"]), json!("/x"), json!([1])] {
            let mut f = Fixture::new();
            f.cfg["refusePaths"] = bad.clone();
            assert!(f.load().is_err(), "{bad}");
        }
    }

    #[test]
    fn malformed_secrets_fail_without_echoing_the_value() {
        let f = Fixture::new();
        for bad in [
            &SECRET[1..],
            &SECRET.to_uppercase(),
            &SECRET.replace('a', "g"),
            "",
        ] {
            let err = f.secret(bad).load().err().unwrap().to_string();
            assert!(err.contains("malformed"), "{err}");
            assert!(bad.len() < 8 || !err.contains(&bad[..8]));
        }
        std::fs::remove_file(f.dir.path().join("secret")).unwrap();
        assert!(f.load().is_err());
    }

    #[test]
    fn trailing_whitespace_in_the_secret_is_stripped() {
        let f = Fixture::new();
        f.secret(&format!("{SECRET} \r\n\t"));
        assert!(f.load().is_ok());
    }

    #[test]
    fn public_origin_rules() {
        let ok = [
            (
                "https://wb.example.org/",
                "https://wb.example.org",
                "wb.example.org",
            ),
            (
                "HTTPS://WB.Example.org",
                "https://wb.example.org",
                "wb.example.org",
            ),
            (
                "http://127.0.0.1:8443",
                "http://127.0.0.1:8443",
                "127.0.0.1:8443",
            ),
            ("http://[::1]:8080", "http://[::1]:8080", "[::1]:8080"),
        ];
        for (input, origin, host) in ok {
            assert_eq!(
                parse_origin(input).unwrap(),
                (origin.into(), host.into()),
                "{input}"
            );
        }
        let bad = [
            "wb.example.org",
            "ftp://wb.example.org",
            "https://",
            "https://wb.example.org/app",
            "https://wb.example.org?x",
            "https://wb.example.org#x",
            "https://alice@wb.example.org",
            "https://wb.example.org:443",
            "http://wb.example.org:80",
            "https://wb.example.org:0443",
            "https://wb.example.org:99999",
            "https://wb.example.org:",
            "http://[::1",
            "http://a[b",
        ];
        for input in bad {
            assert!(parse_origin(input).is_err(), "{input}");
        }
    }

    #[test]
    fn relative_paths_and_odd_hosts_fail() {
        let mut f = Fixture::new();
        f.cfg["boardsDir"] = json!("boards");
        assert!(f.load().is_err());
        for host in ["", ".hidden", "a/b", ".."] {
            let mut f = Fixture::new();
            f.cfg["host"] = json!(host);
            assert!(f.load().is_err(), "{host}");
        }
        let mut f = Fixture::new();
        f.cfg["hubSocket"] = json!(format!("/{}", "s".repeat(120)));
        assert!(f.load().is_err());
    }
    /// A fixture with an `api` of one client, whose token file holds `TOKEN`.
    fn with_api() -> Fixture {
        let mut f = Fixture::new();
        let token = f.dir.path().join("token");
        std::fs::write(&token, format!("{TOKEN}\n")).unwrap();
        f.cfg["api"] = json!({
            "listen": "198.51.100.2:8091",
            "clients": {
                "devbox-agents": {
                    "tokenFile": token,
                    "scopes": ["events"],
                    "host": "devbox",
                    "address": "::ffff:198.51.100.2",
                },
            },
        });
        f
    }

    const TOKEN: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

    #[test]
    fn an_api_loads_its_clients() {
        let (cfg, _, gate) = Fixture::new().load().unwrap();
        assert!(cfg.api.is_none() && gate.is_none());

        let (cfg, _, gate) = with_api().load().unwrap();
        assert_eq!(
            cfg.api.unwrap().listen,
            "198.51.100.2:8091".parse().unwrap()
        );
        let clients = gate.unwrap().clients;
        assert_eq!(clients.len(), 1);
        let client = &clients[0];
        assert_eq!(client.name, "devbox-agents");
        assert_eq!(&*client.token, TOKEN.as_bytes());
        assert_eq!(client.scopes, [Scope::Events].into());
        assert_eq!(client.host.as_deref(), Some("devbox"));
        // An IPv4-mapped address is its IPv4 address, as a peer's is.
        assert_eq!(client.address, Some("198.51.100.2".parse().unwrap()));
    }

    #[test]
    fn a_bad_api_fails() {
        // (what, the edit)
        type Edit = fn(&mut Value);
        let bad: [(&str, Edit); 14] = [
            ("a wildcard listen", |api| {
                api["listen"] = json!("0.0.0.0:8091")
            }),
            ("an IPv6 wildcard listen", |api| {
                api["listen"] = json!("[::]:8091")
            }),
            ("the browser's listen", |api| {
                api["listen"] = json!("127.0.0.1:8090")
            }),
            ("no clients", |api| api["clients"] = json!({})),
            ("an unknown key", |api| api["cors"] = json!("*")),
            ("an unknown client key", |api| {
                api["clients"]["devbox-agents"]["token"] = json!("x");
            }),
            ("a relative token file", |api| {
                api["clients"]["devbox-agents"]["tokenFile"] = json!("token");
            }),
            ("a missing token file", |api| {
                api["clients"]["devbox-agents"]["tokenFile"] = json!("/nonexistent/token");
            }),
            ("no scopes", |api| {
                api["clients"]["devbox-agents"]["scopes"] = json!([])
            }),
            ("an unknown scope", |api| {
                api["clients"]["devbox-agents"]["scopes"] = json!(["events", "admin"]);
            }),
            ("events without a host", |api| {
                api["clients"]["devbox-agents"]
                    .as_object_mut()
                    .unwrap()
                    .remove("host");
            }),
            ("a bad host", |api| {
                api["clients"]["devbox-agents"]["host"] = json!("a/b")
            }),
            ("a bad address", |api| {
                api["clients"]["devbox-agents"]["address"] = json!("devbox");
            }),
            ("a bad client name", |api| {
                let client = api["clients"]["devbox-agents"].clone();
                api["clients"] = json!({"Devbox": client});
            }),
        ];
        for (what, edit) in bad {
            let mut f = with_api();
            edit(&mut f.cfg["api"]);
            assert!(f.load().is_err(), "{what}");
        }
        for name in ["", "a_b", &"a".repeat(33)] {
            let mut f = with_api();
            let client = f.cfg["api"]["clients"]["devbox-agents"].clone();
            f.cfg["api"]["clients"] = json!({name: client});
            assert!(f.load().is_err(), "{name:?}");
        }
    }

    #[test]
    fn api_tokens_are_checked_and_never_echoed() {
        // Two clients with one token.
        let mut f = with_api();
        let mut second = f.cfg["api"]["clients"]["devbox-agents"].clone();
        second["scopes"] = json!(["read"]);
        f.cfg["api"]["clients"]["owner"] = second;
        let err = format!("{:#}", f.load().err().unwrap());
        assert!(err.contains("also another client's"), "{err}");
        assert!(!err.contains(TOKEN), "{err}");

        // A malformed token file.
        let f = with_api();
        let bad = "FFEEDDCCBBAA99887766554433221100FFEEDDCCBBAA99887766554433221100";
        std::fs::write(f.dir.path().join("token"), bad).unwrap();
        let err = format!("{:#}", f.load().err().unwrap());
        assert!(
            err.contains("api client devbox-agents: token file"),
            "{err}"
        );
        assert!(err.contains("malformed") && !err.contains(bad), "{err}");
    }
}
