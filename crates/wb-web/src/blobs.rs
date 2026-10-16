//! Images on the canvas (F-A32): content-addressed files in `<stateDir>/blobs/`, named
//! by the sha256 of their bytes. The board keeps only the hash, so a pasted photo does
//! not grow the board file or its every save.
//!
//! `POST /api/blob` takes the raw bytes and answers `{hash, type, size}`;
//! `GET /blob/{hash}` serves them. Only raster images whose first bytes say so are
//! taken (PNG, JPEG, GIF, WebP, AVIF): never SVG or HTML, which would run as this
//! origin when opened in a tab. The type is read from the bytes, on the way in and on
//! the way out; the request's `Content-Type` is not trusted.

use std::fs;
use std::io;
use std::path::PathBuf;

use axum::body::Body as ResponseBody;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ETAG};
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::http::{ApiError, Body, Param};
use crate::util::atomic_write;

/// The largest image taken, in bytes.
pub const BLOB_MAX: usize = 32 << 20;

/// `POST /blob`, relative to `/api`.
pub fn api_routes() -> Router<AppState> {
    Router::new().route(
        "/blob",
        post(put_blob).layer(DefaultBodyLimit::max(BLOB_MAX)),
    )
}

/// `GET /blob/{hash}`, outside `/api`: an image is not JSON and, being named by its
/// hash, may be cached for good.
pub fn routes() -> Router<AppState> {
    Router::new().route("/blob/{hash}", get(get_blob))
}

fn blob_dir(app: &AppState) -> PathBuf {
    app.cfg.state_dir.join("blobs")
}

/// The image type of `b` from its first bytes, `None` for anything else.
pub fn sniff(b: &[u8]) -> Option<&'static str> {
    let at = |from: usize, sig: &[u8]| b.get(from..from + sig.len()) == Some(sig);
    if at(0, b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if at(0, b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some("image/gif")
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some("image/webp")
    } else if at(4, b"ftypavif") || at(4, b"ftypavis") {
        Some("image/avif")
    } else {
        None
    }
}

/// 64 lowercase hex digits.
fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn io_failure(what: &str, e: &dyn std::fmt::Display) -> Response {
    tracing::error!(error = %e, "{what}");
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what).into_response()
}

async fn put_blob(State(app): State<AppState>, Body(body): Body) -> Response {
    if body.is_empty() {
        return ApiError::new(StatusCode::BAD_REQUEST, "empty body").into_response();
    }
    let Some(kind) = sniff(&body) else {
        return ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not an image: PNG, JPEG, GIF, WebP or AVIF",
        )
        .into_response();
    };
    let hash = hex(&Sha256::digest(&body));
    let dir = blob_dir(&app);
    let name = hash.clone();
    let size = body.len();
    // Same bytes, same name: a second paste of one image writes nothing.
    let wrote = tokio::task::spawn_blocking(move || -> io::Result<()> {
        let path = dir.join(&name);
        if path.try_exists()? {
            return Ok(());
        }
        fs::create_dir_all(&dir)?;
        atomic_write(&path, &body).map(|_| ())
    })
    .await;
    match wrote {
        Ok(Ok(())) => Json(json!({"hash": hash, "type": kind, "size": size})).into_response(),
        Ok(Err(e)) => io_failure("cannot store the image", &e),
        Err(e) => io_failure("cannot store the image", &e),
    }
}

async fn get_blob(State(app): State<AppState>, Param(hash): Param<String>) -> Response {
    if !is_hash(&hash) {
        return ApiError::new(StatusCode::NOT_FOUND, "not found").into_response();
    }
    let path = blob_dir(&app).join(&hash);
    let read = tokio::task::spawn_blocking(move || fs::read(path)).await;
    let bytes = match read {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(e)) if e.kind() == io::ErrorKind::NotFound => {
            return ApiError::new(StatusCode::NOT_FOUND, "not found").into_response();
        }
        Ok(Err(e)) => return io_failure("cannot read the image", &e),
        Err(e) => return io_failure("cannot read the image", &e),
    };
    let Some(kind) = sniff(&bytes) else {
        return ApiError::new(StatusCode::NOT_FOUND, "not found").into_response();
    };
    let mut res = Response::new(ResponseBody::from(bytes));
    let h = res.headers_mut();
    h.insert(CONTENT_TYPE, HeaderValue::from_static(kind));
    h.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    h.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    if let Ok(tag) = HeaderValue::try_from(format!("\"{hash}\"")) {
        h.insert(ETAG, tag);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_takes_raster_images_only() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("image/png"));
        assert_eq!(sniff(b"\xff\xd8\xff\xe0\0\x10JFIF"), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a\x01\0"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x24\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0\0\0"), Some("image/avif"));
        for no in [
            &b""[..],
            b"\x89PN",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            b"<!doctype html><script>",
            b"RIFF\0\0\0\0WAVEfmt ",
            b"%PDF-1.7",
        ] {
            assert_eq!(sniff(no), None, "{no:?}");
        }
    }

    #[test]
    fn hashes_are_64_lowercase_hex() {
        assert!(is_hash(&"a".repeat(64)));
        assert!(!is_hash(&"A".repeat(64)));
        assert!(!is_hash(&"a".repeat(63)));
        assert!(!is_hash(&format!("../{}", "a".repeat(61))));
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
