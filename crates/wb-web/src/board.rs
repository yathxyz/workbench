//! The board store, `<boardsDir>/<host>.json` (design §3.5.5). Paths are relative to
//! `/api`.
//!
//! M0 is last writer wins: `If-Match` is not read yet.

use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;

use axum::Router;
use axum::body::Body as ResponseBody;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{CONTENT_TYPE, ETAG};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::de::IgnoredAny;

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

/// The ETag and bytes, both from one open file, so a concurrent rename cannot pair
/// one file's tag with another's body. `None` when there is no board.
fn read_board(path: &PathBuf) -> io::Result<Option<(String, Vec<u8>)>> {
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

async fn put_board(State(app): State<AppState>, Body(body): Body) -> Response {
    if let Err(e) = serde_json::from_slice::<IgnoredAny>(&body) {
        return ApiError::new(StatusCode::BAD_REQUEST, format!("invalid JSON: {e}"))
            .into_response();
    }
    let path = board_path(&app);
    let dir = app.cfg.boards_dir.clone();
    let _write = app.board_lock.lock().await;
    let written = tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&dir)?;
        atomic_write(&path, &body)
    })
    .await;
    let meta = match written {
        Ok(Ok(meta)) => meta,
        Ok(Err(e)) => return io_failure("cannot write the board", &e),
        Err(e) => return io_failure("cannot write the board", &e),
    };
    let etag = etag(&meta);
    let _ = app.feed.send(FeedMsg::Board { etag: etag.clone() });
    json_response(StatusCode::NO_CONTENT, &etag, Vec::new())
}
