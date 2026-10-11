//! The board store, `<boardsDir>/<host>.json` (design §3.5.5). Paths are relative to
//! `/api`.
//!
//! A PUT must name the board it replaces in `If-Match`. The check and the write happen
//! under one lock, so of two writers holding the same tag exactly one wins.

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
use serde_json::json;

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

/// `"<size>-<mtime_ns>-<ino>"`. Every atomic write makes a new inode, so two writes of
/// equal size within one timestamp tick still differ.
fn etag(meta: &Metadata) -> String {
    let mtime_ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    format!("\"{}-{mtime_ns}-{}\"", meta.len(), meta.ino())
}

/// The tag of the board as it is now, `"empty"` when there is none.
fn current_etag(path: &Path) -> io::Result<String> {
    match fs::metadata(path) {
        Ok(meta) => Ok(etag(&meta)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(EMPTY.to_owned()),
        Err(e) => Err(e),
    }
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
    let dir = app.cfg.boards_dir.clone();
    // Held until the notice is sent, so notices go out in write order.
    let _write = app.board_lock.lock().await;
    let put = tokio::task::spawn_blocking(move || -> io::Result<Put> {
        let current = current_etag(&path)?;
        if let Err(status) = precondition(&if_match, &current) {
            return Ok(Put::Refused(status, current));
        }
        fs::create_dir_all(&dir)?;
        Ok(Put::Written(etag(&atomic_write(&path, &body)?)))
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
