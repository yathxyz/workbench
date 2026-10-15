//! The board store, `<boardsDir>/<host>.json` (design §3.5.5). Paths are relative to
//! `/api`.
//!
//! A PUT must name the board it replaces in `If-Match`. The check and the write happen
//! under one lock, so of two writers holding the same tag exactly one wins.
//!
//! Under the same lock the migration guard of the edwind spec (R8.20) runs: a page
//! node that has `buf` in the stored board keeps it whatever the PUT says, and `text`
//! and `anchors` leave every node that has `buf`. The first PUT that brings `buf` to a
//! node copies the stored board to `<host>.pre-edwind.json` once (R8.19).

use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use axum::body::Body as ResponseBody;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{CONTENT_TYPE, ETAG, IF_MATCH};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::de::IgnoredAny;
use serde_json::{Map, Value, json};

use crate::http::{ApiError, Body};
use crate::util::atomic_write;
use crate::{AppState, FeedMsg};

const BOARD_MAX: usize = 32 << 20;
/// The ETag while no board file exists.
const EMPTY: &str = "\"empty\"";

pub fn routes() -> Router<AppState> {
    Router::new().route(
        "/board",
        get(get_board)
            .put(put_board)
            .layer(DefaultBodyLimit::max(BOARD_MAX)),
    )
}

fn board_path(app: &AppState) -> PathBuf {
    app.cfg.boards_dir.join(format!("{}.json", app.cfg.host))
}

/// The one-time copy of the board as it was before its first `buf` (R8.19).
fn backup_path(app: &AppState) -> PathBuf {
    app.cfg
        .boards_dir
        .join(format!("{}.pre-edwind.json", app.cfg.host))
}

/// What the migration guard made of a PUT body.
struct Guarded {
    /// The bytes to write: the body as sent unless the guard changed a node.
    body: Vec<u8>,
    /// A node carries `buf` for the first time, so the stored board is worth keeping.
    first_buf: bool,
}

/// The `nodes` object of a board, `None` for any other shape (a full wipe such as
/// `{"v":0}`, `null`, or the array form never written by this frontend).
fn nodes_mut(board: &mut Value) -> Option<&mut Map<String, Value>> {
    board.as_object_mut()?.get_mut("nodes")?.as_object_mut()
}

fn has_buf(node: &Map<String, Value>) -> bool {
    node.get("buf").is_some_and(|b| !b.is_null())
}

/// R8.20: every incoming node whose stored version has `buf` keeps that `buf`, and
/// `text` and `anchors` are stripped from every node that ends up with one. A body
/// that is not an object holding a `nodes` object is written as it came.
fn guard(stored: Option<&[u8]>, body: Vec<u8>) -> Guarded {
    let unchanged = |body| Guarded {
        body,
        first_buf: false,
    };
    let Ok(mut incoming) = serde_json::from_slice::<Value>(&body) else {
        return unchanged(body);
    };
    let Some(nodes) = nodes_mut(&mut incoming) else {
        return unchanged(body);
    };
    let stored_nodes = stored
        .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
        .and_then(|mut board| nodes_mut(&mut board).map(std::mem::take))
        .unwrap_or_default();
    let mut changed = false;
    let mut first_buf = false;
    for (id, node) in nodes.iter_mut() {
        let Some(node) = node.as_object_mut() else {
            continue;
        };
        let stored_buf = stored_nodes
            .get(id)
            .and_then(Value::as_object)
            .filter(|n| has_buf(n))
            .map(|n| n["buf"].clone());
        match (stored_buf, has_buf(node)) {
            (Some(buf), false) => {
                node.insert("buf".to_owned(), buf);
                changed = true;
            }
            (None, true) => first_buf = true,
            _ => {}
        }
        if has_buf(node) {
            for key in ["text", "anchors"] {
                changed |= node.remove(key).is_some();
            }
        }
    }
    Guarded {
        body: if changed {
            serde_json::to_vec(&incoming).unwrap_or(body)
        } else {
            body
        },
        first_buf,
    }
}

/// `"<size>-<mtime_ns>-<ino>"`. Every atomic write makes a new inode, so two writes of
/// equal size within one timestamp tick still differ.
fn etag(meta: &Metadata) -> String {
    let mtime_ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    format!("\"{}-{mtime_ns}-{}\"", meta.len(), meta.ino())
}

/// Whether a PUT carrying `if_match` may replace the board tagged `current`: 428 without
/// the header, 412 unless it is exactly one value equal to `current`. Weak tags, lists
/// and `*` are compared as plain strings, so they never match.
fn precondition(if_match: &[HeaderValue], current: &str) -> Result<(), StatusCode> {
    match if_match {
        [] => Err(StatusCode::PRECONDITION_REQUIRED),
        [tag] if tag.as_bytes() == current.as_bytes() => Ok(()),
        _ => Err(StatusCode::PRECONDITION_FAILED),
    }
}

/// The ETag and bytes, both from one open file, so a concurrent rename cannot pair
/// one file's tag with another's body. `None` when there is no board.
fn read_board(path: &Path) -> io::Result<Option<(String, Vec<u8>)>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let meta = file.metadata()?;
    let mut body = Vec::new();
    file.read_to_end(&mut body)?;
    Ok(Some((etag(&meta), body)))
}

/// The tag of the board at `path` as it is now, `"empty"` when there is none: what a
/// GET would send, from one `stat`.
fn current_etag(path: &Path) -> io::Result<String> {
    match fs::metadata(path) {
        Ok(meta) => Ok(etag(&meta)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(EMPTY.to_owned()),
        Err(e) => Err(e),
    }
}

/// The board's tag now, for the `/rpc` connect snapshot.
pub async fn etag_now(app: &AppState) -> io::Result<String> {
    let path = board_path(app);
    tokio::task::spawn_blocking(move || current_etag(&path))
        .await
        .map_err(io::Error::other)?
}

fn json_response(status: StatusCode, etag: &str, body: Vec<u8>) -> Response {
    let mut res = Response::new(ResponseBody::from(body));
    *res.status_mut() = status;
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(etag) = HeaderValue::try_from(etag) {
        h.insert(ETAG, etag);
    }
    res
}

fn io_failure(what: &str, e: &dyn std::fmt::Display) -> Response {
    tracing::error!(error = %e, "{what}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what).into_response()
}

async fn get_board(State(app): State<AppState>) -> Response {
    let path = board_path(&app);
    match tokio::task::spawn_blocking(move || read_board(&path)).await {
        Ok(Ok(Some((etag, body)))) => json_response(StatusCode::OK, &etag, body),
        Ok(Ok(None)) => json_response(StatusCode::OK, EMPTY, b"null".to_vec()),
        Ok(Err(e)) => io_failure("cannot read the board", &e),
        Err(e) => io_failure("cannot read the board", &e),
    }
}

/// What a PUT did under the lock.
enum Put {
    Written(String),
    Refused(StatusCode, String),
}

async fn put_board(State(app): State<AppState>, headers: HeaderMap, Body(body): Body) -> Response {
    if let Err(e) = serde_json::from_slice::<IgnoredAny>(&body) {
        return ApiError::new(StatusCode::BAD_REQUEST, format!("invalid JSON: {e}"))
            .into_response();
    }
    let if_match: Vec<HeaderValue> = headers.get_all(IF_MATCH).iter().cloned().collect();
    let path = board_path(&app);
    let backup = backup_path(&app);
    let dir = app.cfg.boards_dir.clone();
    // Held until the notice is sent, so notices go out in write order.
    let _write = app.board_lock.lock().await;
    let put = tokio::task::spawn_blocking(move || -> io::Result<Put> {
        // Tag and bytes from one open file: the guard compares against exactly the
        // board the precondition admitted.
        let stored = read_board(&path)?;
        let current = stored
            .as_ref()
            .map_or_else(|| EMPTY.to_owned(), |(tag, _)| tag.clone());
        if let Err(status) = precondition(&if_match, &current) {
            return Ok(Put::Refused(status, current));
        }
        let stored = stored.map(|(_, bytes)| bytes);
        let guarded = guard(stored.as_deref(), body.to_vec());
        fs::create_dir_all(&dir)?;
        if let (true, Some(stored)) = (guarded.first_buf, &stored)
            && !backup.try_exists()?
        {
            atomic_write(&backup, stored)?;
        }
        Ok(Put::Written(etag(&atomic_write(&path, &guarded.body)?)))
    })
    .await;
    match put {
        Ok(Ok(Put::Written(etag))) => {
            let _ = app.feed.send(FeedMsg::Board { etag: etag.clone() });
            json_response(StatusCode::NO_CONTENT, &etag, Vec::new())
        }
        Ok(Ok(Put::Refused(StatusCode::PRECONDITION_REQUIRED, _))) => {
            ApiError::new(StatusCode::PRECONDITION_REQUIRED, "If-Match required").into_response()
        }
        Ok(Ok(Put::Refused(status, current))) => (
            status,
            Json(json!({"error": "board changed elsewhere", "etag": current})),
        )
            .into_response(),
        Ok(Err(e)) => io_failure("cannot write the board", &e),
        Err(e) => io_failure("cannot write the board", &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(raw: &[&str]) -> Vec<HeaderValue> {
        raw.iter()
            .map(|v| HeaderValue::from_str(v).unwrap())
            .collect()
    }

    #[test]
    fn precondition_rows() {
        const TAG: &str = "\"12-1760000000123456789-42\"";
        let rows: &[(&[&str], &str, Result<(), StatusCode>)] = &[
            (&[], EMPTY, Err(StatusCode::PRECONDITION_REQUIRED)),
            (&[], TAG, Err(StatusCode::PRECONDITION_REQUIRED)),
            (&[EMPTY], EMPTY, Ok(())),
            (&[EMPTY], TAG, Err(StatusCode::PRECONDITION_FAILED)),
            (&[TAG], TAG, Ok(())),
            (&[TAG], EMPTY, Err(StatusCode::PRECONDITION_FAILED)),
            (
                &["\"12-1760000000123456789-43\""],
                TAG,
                Err(StatusCode::PRECONDITION_FAILED),
            ),
            (
                &["12-1760000000123456789-42"],
                TAG,
                Err(StatusCode::PRECONDITION_FAILED),
            ),
            (
                &["W/\"12-1760000000123456789-42\""],
                TAG,
                Err(StatusCode::PRECONDITION_FAILED),
            ),
            (&["*"], TAG, Err(StatusCode::PRECONDITION_FAILED)),
            (&["*"], EMPTY, Err(StatusCode::PRECONDITION_FAILED)),
            (
                &["\"empty\", \"12-1760000000123456789-42\""],
                TAG,
                Err(StatusCode::PRECONDITION_FAILED),
            ),
            (&[TAG, TAG], TAG, Err(StatusCode::PRECONDITION_FAILED)),
            (&["\"EMPTY\""], EMPTY, Err(StatusCode::PRECONDITION_FAILED)),
        ];
        for (if_match, current, want) in rows {
            assert_eq!(
                precondition(&values(if_match), current),
                *want,
                "If-Match {if_match:?} against {current}"
            );
        }
    }

    fn run_guard(stored: Option<&str>, incoming: &str) -> (Value, bool) {
        let g = guard(stored.map(str::as_bytes), incoming.as_bytes().to_vec());
        (serde_json::from_slice(&g.body).unwrap(), g.first_buf)
    }

    #[test]
    fn the_guard_keeps_stored_bufs_and_strips_text_from_them() {
        let stored = r#"{"v":1,"nodes":{
            "p1":{"id":"p1","kind":"buffer","buf":"notes/a.md","x":1},
            "p2":{"id":"p2","kind":"buffer","buf":"notes/b.md"},
            "t1":{"id":"t1","kind":"terminal"}}}"#;
        let incoming = r#"{"v":1,"nodes":{
            "p1":{"id":"p1","kind":"buffer","text":"old","anchors":[{"id":"a"}],"x":2},
            "p2":{"id":"p2","kind":"buffer","text":"old2","buf":null},
            "p3":{"id":"p3","kind":"buffer","text":"new page"},
            "t1":{"id":"t1","kind":"terminal","text":"kept: no buf"}}}"#;
        let (out, first_buf) = run_guard(Some(stored), incoming);
        assert!(!first_buf);
        assert_eq!(
            out["nodes"],
            json!({
                "p1": {"id": "p1", "kind": "buffer", "buf": "notes/a.md", "x": 2},
                "p2": {"id": "p2", "kind": "buffer", "buf": "notes/b.md"},
                "p3": {"id": "p3", "kind": "buffer", "text": "new page"},
                "t1": {"id": "t1", "kind": "terminal", "text": "kept: no buf"},
            })
        );
    }

    #[test]
    fn the_guard_reports_the_first_buf_and_leaves_other_shapes_alone() {
        let pre = r#"{"nodes":{"p1":{"id":"p1","kind":"buffer","text":"t","anchors":[]}}}"#;
        let migrated = r#"{"nodes":{"p1":{"id":"p1","kind":"buffer","buf":"notes/a.md"}}}"#;
        // The migration itself: buf arrives where there was none.
        let (out, first_buf) = run_guard(Some(pre), migrated);
        assert!(first_buf);
        assert_eq!(out["nodes"]["p1"]["buf"], "notes/a.md");
        // The same board again: nothing new.
        assert!(!run_guard(Some(migrated), migrated).1);
        // A new node with buf on a board that never had one: first too.
        assert!(run_guard(Some(pre), r#"{"nodes":{"p9":{"buf":"notes/z.md"}}}"#).1);
        // No stored board: the flag is set, and the caller has nothing to copy.
        assert!(run_guard(None, migrated).1);
        // A node that keeps buf and still carries text loses the text (R8.17 shape).
        let (out, _) = run_guard(
            Some(migrated),
            r#"{"nodes":{"p1":{"id":"p1","buf":"notes/a.md","text":"x","anchors":[1]}}}"#,
        );
        assert_eq!(out["nodes"]["p1"], json!({"id": "p1", "buf": "notes/a.md"}));
        // Shapes without a nodes object pass through byte for byte.
        for body in [r#"{"v":0}"#, "null", r#"{"nodes":[{"id":"a1"}]}"#, "[1,2]"] {
            let g = guard(Some(migrated.as_bytes()), body.as_bytes().to_vec());
            assert_eq!(g.body, body.as_bytes(), "{body}");
            assert!(!g.first_buf, "{body}");
        }
        // Unchanged nodes keep the body as sent, spacing included.
        let g = guard(Some(pre.as_bytes()), pre.as_bytes().to_vec());
        assert_eq!(g.body, pre.as_bytes());
    }

    #[test]
    fn etag_is_size_mtime_ns_and_inode_and_changes_on_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.json");
        assert_eq!(current_etag(&path).unwrap(), EMPTY);
        assert!(read_board(&path).unwrap().is_none());

        let written = atomic_write(&path, b"{\"a\":1}").unwrap();
        let tag = etag(&written);
        let meta = fs::metadata(&path).unwrap();
        let ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
        assert_eq!(tag, format!("\"7-{ns}-{}\"", meta.ino()));
        assert_eq!(current_etag(&path).unwrap(), tag);
        assert_eq!(
            read_board(&path).unwrap(),
            Some((tag.clone(), b"{\"a\":1}".to_vec()))
        );

        // Same size again: the new inode alone keeps the tags apart.
        let again = etag(&atomic_write(&path, b"{\"a\":2}").unwrap());
        assert_ne!(again, tag);
        assert_eq!(current_etag(&path).unwrap(), again);
    }
}
