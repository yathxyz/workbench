//! Artifact versions and per-node db (design §3.5.5, M5-W3). Paths are relative to
//! `/api`.
//!
//! An artifact node's pages live in `<stateDir>/artifacts/<node>/`:
//! - `meta.json`: `{head, versions: [{sha, at}], capabilities}`, the newest version last;
//! - `v/<sha>.json`: one version's content, `{kind: "page", html}` or
//!   `{kind: "files", files: {path: {text}}}`;
//! - `db.json`: the page's document store, as the frontend PUTs it.
//!
//! There is no second origin: the frontend renders the head in an opaque-origin
//! `srcdoc` frame (fix 6), so `url` is always `null`. A PUT that names the head it
//! replaces (`ifMatch`, `null` for none) and finds another is 409
//! `{error: {code: "conflict", message, head}}`; a PUT without `ifMatch` replaces
//! whatever is there. The check and the write happen under one lock. Nothing deletes
//! an artifact's directory: a removed card may come back with an undo or another
//! board (as with blobs).

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::AppState;
use crate::http::{ApiError, ApiQuery, Body, Param, not_found};
use crate::util::{atomic_write, sanitize_sid};

/// The largest artifact or db PUT, in bytes (the board's cap).
pub const ARTIFACT_MAX: usize = 32 << 20;
/// Versions kept per artifact; older ones are removed from disk.
pub const VERSIONS_KEPT: usize = 30;
/// The longest file path inside a files artifact.
const FILE_PATH_MAX: usize = 256;

/// Serialises every artifact and db write of the process.
static LOCK: Mutex<()> = Mutex::const_new(());

pub fn routes() -> Router<AppState> {
    Router::new()
        // Deleting artifacts is a removed feature (design §3.5.5), not a wrong method.
        .route(
            "/artifact/{node}",
            get(get_artifact)
                .put(put_artifact)
                .delete(not_found)
                .layer(DefaultBodyLimit::max(ARTIFACT_MAX)),
        )
        .route(
            "/db/{node}",
            get(get_db)
                .put(put_db)
                .layer(DefaultBodyLimit::max(ARTIFACT_MAX)),
        )
}

/// One published version, as `meta.versions` lists it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub sha: String,
    /// UTC, `YYYY-MM-DDTHH:MM:SS`.
    pub at: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub head: Option<String>,
    pub versions: Vec<Version>,
    pub capabilities: Map<String, Value>,
}

/// What a version holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Content {
    Page { html: String },
    Files { files: BTreeMap<String, FileText> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileText {
    pub text: String,
}

/// A PUT body. `files` patches the head: a string or `{text}` sets a file, `null` or
/// `{delete: true}` removes it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Publish {
    html: Option<String>,
    files: Option<Map<String, Value>>,
    capabilities: Option<Map<String, Value>>,
    /// Absent: no check. Present (`null` included): must equal the head.
    #[serde(default, deserialize_with = "present")]
    if_match: Option<Option<String>>,
}

/// Tells a field given as `null` from one left out.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Debug, Default, Deserialize)]
struct VersionQuery {
    v: Option<String>,
}

fn node_dir(app: &AppState, node: &str) -> PathBuf {
    app.cfg.state_dir.join("artifacts").join(node)
}

/// The node id as sent, or 400 when it is not one (a board id is `[A-Za-z0-9_-]`, at
/// most 64 bytes).
fn node_id(node: &str) -> Result<&str, ApiError> {
    if !node.is_empty() && sanitize_sid(node) == node {
        Ok(node)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "bad id"))
    }
}

fn is_sha(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// The version name of `content`: the first 16 hex digits of the sha256 of its JSON.
pub fn sha_of(content: &Content) -> String {
    let bytes = serde_json::to_vec(content).unwrap_or_default();
    Sha256::digest(&bytes)
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> io::Result<Option<T>> {
    match fs::read(path) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn read_meta(dir: &std::path::Path) -> io::Result<Meta> {
    Ok(read_json(&dir.join("meta.json"))?.unwrap_or_default())
}

fn read_version(dir: &std::path::Path, sha: &str) -> io::Result<Option<Content>> {
    read_json(&dir.join("v").join(format!("{sha}.json")))
}

fn io_failure(what: &str, e: &dyn std::fmt::Display) -> Response {
    tracing::error!(error = %e, "{what}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what).into_response()
}

fn now_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_secs());
    utc(secs)
}

/// `secs` since the epoch as `YYYY-MM-DDTHH:MM:SS` (UTC).
fn utc(secs: u64) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil-from-days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

async fn get_artifact(
    State(app): State<AppState>,
    Param(node): Param<String>,
    ApiQuery(q): ApiQuery<VersionQuery>,
) -> Response {
    let node = match node_id(&node) {
        Ok(n) => n.to_owned(),
        Err(e) => return e.into_response(),
    };
    if q.v.as_deref().is_some_and(|v| !is_sha(v)) {
        return ApiError::new(StatusCode::BAD_REQUEST, "bad version").into_response();
    }
    let dir = node_dir(&app, &node);
    let read = tokio::task::spawn_blocking(move || -> io::Result<(Meta, Option<Content>, bool)> {
        let meta = read_meta(&dir)?;
        let want = q.v.or_else(|| meta.head.clone());
        let content = match &want {
            Some(sha) => read_version(&dir, sha)?,
            None => None,
        };
        let missing = want.is_some() && content.is_none();
        Ok((meta, content, missing))
    })
    .await;
    match read {
        Ok(Ok((_, _, true))) => {
            ApiError::new(StatusCode::NOT_FOUND, "no such version").into_response()
        }
        Ok(Ok((meta, content, false))) => {
            Json(json!({"meta": meta, "content": content, "url": null})).into_response()
        }
        Ok(Err(e)) => io_failure("cannot read the artifact", &e),
        Err(e) => io_failure("cannot read the artifact", &e),
    }
}

/// What a PUT asked for, checked against the stored state.
enum Outcome {
    Published {
        version: String,
        changed: bool,
        meta: Meta,
    },
    Conflict {
        head: Option<String>,
    },
    Bad(&'static str),
}

/// `files` applied to `base`: a page base counts as its `index.html`.
fn patch_files(
    base: Option<Content>,
    patch: &Map<String, Value>,
) -> Result<BTreeMap<String, FileText>, &'static str> {
    let mut files = match base {
        Some(Content::Files { files }) => files,
        Some(Content::Page { html }) => {
            BTreeMap::from([("index.html".into(), FileText { text: html })])
        }
        None => BTreeMap::new(),
    };
    for (path, v) in patch {
        if path.is_empty()
            || path.len() > FILE_PATH_MAX
            || path.starts_with('/')
            || path
                .split('/')
                .any(|s| s.is_empty() || s == "." || s == "..")
            || path.contains('\0')
        {
            return Err("bad file path");
        }
        match v {
            Value::Null => {
                files.remove(path);
            }
            Value::String(text) => {
                files.insert(path.clone(), FileText { text: text.clone() });
            }
            Value::Object(o) if o.get("delete") == Some(&Value::Bool(true)) => {
                files.remove(path);
            }
            Value::Object(o) => match o.get("text") {
                Some(Value::String(text)) => {
                    files.insert(path.clone(), FileText { text: text.clone() });
                }
                _ => return Err("a file is a string, {text}, {delete: true} or null"),
            },
            _ => return Err("a file is a string, {text}, {delete: true} or null"),
        }
    }
    if files.is_empty() {
        return Err("an artifact needs at least one file");
    }
    Ok(files)
}

fn publish(dir: &std::path::Path, p: Publish) -> io::Result<Outcome> {
    let mut meta = read_meta(dir)?;
    if let Some(want) = &p.if_match
        && *want != meta.head
    {
        return Ok(Outcome::Conflict { head: meta.head });
    }
    let base = || match &meta.head {
        Some(sha) => read_version(dir, sha),
        None => Ok(None),
    };
    let content = match (p.html, &p.files) {
        (Some(html), _) => Some(Content::Page { html }),
        (None, Some(patch)) => match patch_files(base()?, patch) {
            Ok(files) => Some(Content::Files { files }),
            Err(m) => return Ok(Outcome::Bad(m)),
        },
        (None, None) => None,
    };
    if let Some(caps) = p.capabilities {
        meta.capabilities = caps;
    }
    let Some(content) = content else {
        // Capabilities alone: no new version.
        let Some(head) = meta.head.clone() else {
            return Ok(Outcome::Bad("html or files required"));
        };
        fs::create_dir_all(dir)?;
        atomic_write(&dir.join("meta.json"), &serde_json::to_vec(&meta)?)?;
        return Ok(Outcome::Published {
            version: head,
            changed: false,
            meta,
        });
    };
    let sha = sha_of(&content);
    let changed = meta.head.as_deref() != Some(&sha);
    let vdir = dir.join("v");
    fs::create_dir_all(&vdir)?;
    let vpath = vdir.join(format!("{sha}.json"));
    if !vpath.try_exists()? {
        atomic_write(&vpath, &serde_json::to_vec(&content)?)?;
    }
    if changed {
        // A version published again (a rollback) moves to the end.
        meta.versions.retain(|v| v.sha != sha);
        meta.versions.push(Version {
            sha: sha.clone(),
            at: now_utc(),
        });
        meta.head = Some(sha.clone());
    }
    let dropped = meta.versions.len().saturating_sub(VERSIONS_KEPT);
    let old: Vec<Version> = meta.versions.drain(..dropped).collect();
    atomic_write(&dir.join("meta.json"), &serde_json::to_vec(&meta)?)?;
    // After meta.json no longer names them, so a crash leaves files, never dangling names.
    for v in old {
        let _ = fs::remove_file(vdir.join(format!("{}.json", v.sha)));
    }
    Ok(Outcome::Published {
        version: sha,
        changed,
        meta,
    })
}

async fn put_artifact(
    State(app): State<AppState>,
    Param(node): Param<String>,
    Body(body): Body,
) -> Response {
    let node = match node_id(&node) {
        Ok(n) => n.to_owned(),
        Err(e) => return e.into_response(),
    };
    let p: Publish = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => {
            return ApiError::new(StatusCode::BAD_REQUEST, format!("invalid publish: {e}"))
                .into_response();
        }
    };
    let dir = node_dir(&app, &node);
    let _held = LOCK.lock().await;
    let done = tokio::task::spawn_blocking(move || publish(&dir, p)).await;
    match done {
        Ok(Ok(Outcome::Published {
            version,
            changed,
            meta,
        })) => Json(json!({"version": version, "changed": changed, "meta": meta, "url": null}))
            .into_response(),
        Ok(Ok(Outcome::Conflict { head })) => (
            StatusCode::CONFLICT,
            Json(json!({"error": {
                "code": "conflict",
                "message": "the artifact has a newer version",
                "head": head,
            }})),
        )
            .into_response(),
        Ok(Ok(Outcome::Bad(m))) => ApiError::new(StatusCode::BAD_REQUEST, m).into_response(),
        Ok(Err(e)) => io_failure("cannot store the artifact", &e),
        Err(e) => io_failure("cannot store the artifact", &e),
    }
}

/// The stored db, or `{}` for a node that never wrote one.
async fn get_db(State(app): State<AppState>, Param(node): Param<String>) -> Response {
    let node = match node_id(&node) {
        Ok(n) => n.to_owned(),
        Err(e) => return e.into_response(),
    };
    let path = node_dir(&app, &node).join("db.json");
    match tokio::task::spawn_blocking(move || read_json::<Value>(&path)).await {
        Ok(Ok(v)) => Json(v.unwrap_or_else(|| json!({}))).into_response(),
        Ok(Err(e)) => io_failure("cannot read the db", &e),
        Err(e) => io_failure("cannot read the db", &e),
    }
}

/// Replaces the db with the body, a JSON object: 204.
async fn put_db(
    State(app): State<AppState>,
    Param(node): Param<String>,
    Body(body): Body,
) -> Response {
    let node = match node_id(&node) {
        Ok(n) => n.to_owned(),
        Err(e) => return e.into_response(),
    };
    match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(_)) => {}
        Ok(_) => {
            return ApiError::new(StatusCode::BAD_REQUEST, "the db is a JSON object")
                .into_response();
        }
        Err(e) => {
            return ApiError::new(StatusCode::BAD_REQUEST, format!("invalid JSON: {e}"))
                .into_response();
        }
    }
    let dir = node_dir(&app, &node);
    let _held = LOCK.lock().await;
    let wrote = tokio::task::spawn_blocking(move || -> io::Result<()> {
        fs::create_dir_all(&dir)?;
        atomic_write(&dir.join("db.json"), &body).map(drop)
    })
    .await;
    match wrote {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => io_failure("cannot store the db", &e),
        Err(e) => io_failure("cannot store the db", &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(dir: &std::path::Path, v: Value) -> Outcome {
        publish(dir, serde_json::from_value(v).unwrap()).unwrap()
    }

    fn version(o: Outcome) -> (String, bool, Meta) {
        match o {
            Outcome::Published {
                version,
                changed,
                meta,
            } => (version, changed, meta),
            Outcome::Conflict { head } => panic!("conflict at {head:?}"),
            Outcome::Bad(m) => panic!("bad: {m}"),
        }
    }

    #[test]
    fn utc_formats_the_epoch_and_a_leap_day() {
        assert_eq!(utc(0), "1970-01-01T00:00:00");
        assert_eq!(utc(951_825_600), "2000-02-29T12:00:00");
        assert_eq!(utc(1_792_368_000), "2026-10-19T00:00:00");
    }

    #[test]
    fn versions_are_content_names_and_republishing_moves_one_to_the_end() {
        let d = tempfile::tempdir().unwrap();
        let (a, changed, _) = version(put(d.path(), json!({"html": "<p>a</p>", "ifMatch": null})));
        assert!(changed && is_sha(&a));
        let (b, _, _) = version(put(d.path(), json!({"html": "<p>b</p>", "ifMatch": a})));
        let (same, changed, meta) = version(put(d.path(), json!({"html": "<p>b</p>"})));
        assert_eq!((same.as_str(), changed), (b.as_str(), false));
        assert_eq!(meta.versions.len(), 2);
        let (back, changed, meta) = version(put(d.path(), json!({"html": "<p>a</p>"})));
        assert_eq!((back.as_str(), changed), (a.as_str(), true));
        let order: Vec<_> = meta.versions.iter().map(|v| v.sha.as_str()).collect();
        assert_eq!(order, [b.as_str(), a.as_str()]);
    }

    #[test]
    fn if_match_must_name_the_head() {
        let d = tempfile::tempdir().unwrap();
        let (a, _, _) = version(put(d.path(), json!({"html": "1", "ifMatch": null})));
        match put(d.path(), json!({"html": "2", "ifMatch": null})) {
            Outcome::Conflict { head } => assert_eq!(head.as_deref(), Some(a.as_str())),
            _ => panic!("expected a conflict"),
        }
        match put(
            d.path(),
            json!({"html": "2", "ifMatch": "0000000000000000"}),
        ) {
            Outcome::Conflict { .. } => {}
            _ => panic!("expected a conflict"),
        }
    }

    #[test]
    fn files_patch_the_head_and_a_page_counts_as_index_html() {
        let d = tempfile::tempdir().unwrap();
        version(put(d.path(), json!({"html": "<p>a</p>"})));
        let (v, _, _) = version(put(
            d.path(),
            json!({"files": {"app.js": "1", "style.css": {"text": "x"}}}),
        ));
        let c = read_version(d.path(), &v).unwrap().unwrap();
        let Content::Files { files } = c else {
            panic!()
        };
        assert_eq!(
            files.keys().map(String::as_str).collect::<Vec<_>>(),
            ["app.js", "index.html", "style.css"]
        );
        let (v, _, _) = version(put(
            d.path(),
            json!({"files": {"app.js": null, "style.css": {"delete": true}}}),
        ));
        let Content::Files { files } = read_version(d.path(), &v).unwrap().unwrap() else {
            panic!()
        };
        assert_eq!(files.len(), 1);
        for bad in ["../x", "/x", "a//b", ""] {
            assert!(matches!(
                put(d.path(), json!({"files": {bad: "1"}})),
                Outcome::Bad(_)
            ));
        }
        assert!(matches!(
            put(d.path(), json!({"files": {"index.html": null}})),
            Outcome::Bad(_)
        ));
    }

    #[test]
    fn only_the_last_versions_are_kept_on_disk() {
        let d = tempfile::tempdir().unwrap();
        let first = version(put(d.path(), json!({"html": "0"}))).0;
        for i in 1..=VERSIONS_KEPT {
            version(put(d.path(), json!({"html": i.to_string()})));
        }
        let meta = read_meta(d.path()).unwrap();
        assert_eq!(meta.versions.len(), VERSIONS_KEPT);
        assert!(!meta.versions.iter().any(|v| v.sha == first));
        assert!(read_version(d.path(), &first).unwrap().is_none());
        assert_eq!(
            fs::read_dir(d.path().join("v")).unwrap().count(),
            VERSIONS_KEPT
        );
    }

    #[test]
    fn capabilities_alone_need_a_head_and_make_no_version() {
        let d = tempfile::tempdir().unwrap();
        assert!(matches!(
            put(d.path(), json!({"capabilities": {"db": {}}})),
            Outcome::Bad(_)
        ));
        let (a, _, _) = version(put(
            d.path(),
            json!({"html": "x", "capabilities": {"sample": {}}}),
        ));
        let (b, changed, meta) = version(put(d.path(), json!({"capabilities": {"db": {}}})));
        assert_eq!((b, changed), (a, false));
        assert_eq!(
            meta.capabilities,
            json!({"db": {}}).as_object().unwrap().clone()
        );
        assert_eq!(meta.versions.len(), 1);
    }
}
