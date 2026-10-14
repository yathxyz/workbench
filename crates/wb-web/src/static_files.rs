//! The SPA, loaded from `webRoot` into memory at startup and served by exact path.
//!
//! There is no decoding and no filesystem access per request, so traversal is
//! impossible by construction. ETags are content hashes, because store mtimes are
//! constant and cannot tell two builds apart.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result, anyhow, ensure};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::http::ApiError;

const FILE_MAX: u64 = 32 << 20;
const TOTAL_MAX: u64 = 128 << 20;
/// Bounds the walk, which follows symlinks.
const DEPTH_MAX: usize = 16;

#[derive(Clone)]
struct Asset {
    body: Bytes,
    etag: HeaderValue,
    ctype: &'static str,
}

/// URL path → asset; every `<dir>/` with an `index.html` is that file, `/` included.
pub struct Assets(HashMap<String, Asset>);

impl Assets {
    /// Reads every file under `root`, symlinks followed, dot files skipped. The root
    /// must hold an `index.html`; `/edwin/` and any other directory that has one gets
    /// the same alias (edwind spec R9.19, the console page).
    pub fn load(root: &Path) -> Result<Self> {
        let mut assets = HashMap::new();
        let mut total = 0;
        walk(root, "", 0, &mut assets, &mut total)?;
        ensure!(
            assets.contains_key("/index.html"),
            "webRoot {} has no index.html",
            root.display()
        );
        let indexes: Vec<(String, Asset)> = assets
            .iter()
            .filter_map(|(key, asset)| {
                let dir = key.strip_suffix("index.html")?;
                Some((dir.to_owned(), asset.clone()))
            })
            .collect();
        for (dir, asset) in indexes {
            assets.insert(dir, asset);
        }
        Ok(Assets(assets))
    }
}

fn walk(
    dir: &Path,
    prefix: &str,
    depth: usize,
    assets: &mut HashMap<String, Asset>,
    total: &mut u64,
) -> Result<()> {
    ensure!(
        depth <= DEPTH_MAX,
        "webRoot is nested deeper than {DEPTH_MAX} directories at {}",
        dir.display()
    );
    let entries = fs::read_dir(dir).with_context(|| format!("cannot read {}", dir.display()))?;
    for entry in entries {
        let path = entry
            .with_context(|| format!("cannot read {}", dir.display()))?
            .path();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| anyhow!("{} is not a UTF-8 name", path.display()))?;
        if name.starts_with('.') {
            continue;
        }
        let key = format!("{prefix}/{name}");
        let meta =
            fs::metadata(&path).with_context(|| format!("cannot stat {}", path.display()))?;
        if meta.is_dir() {
            walk(&path, &key, depth + 1, assets, total)?;
        } else if meta.is_file() {
            ensure!(
                meta.len() <= FILE_MAX,
                "{} is larger than 32 MiB",
                path.display()
            );
            let body =
                fs::read(&path).with_context(|| format!("cannot read {}", path.display()))?;
            *total += body.len() as u64;
            ensure!(*total <= TOTAL_MAX, "webRoot holds more than 128 MiB");
            let ctype = mime(name);
            assets.insert(
                key,
                Asset {
                    etag: etag(&body),
                    body: body.into(),
                    ctype,
                },
            );
        }
    }
    Ok(())
}

/// `"<first 16 bytes of sha256 as 32 hex chars>"`.
fn etag(body: &[u8]) -> HeaderValue {
    let digest = Sha256::digest(body);
    let mut tag = String::from("\"");
    for b in &digest[..16] {
        let _ = write!(tag, "{b:02x}");
    }
    tag.push('"');
    HeaderValue::try_from(tag).expect("hex is a valid header value")
}

/// The content type for a file name.
pub fn mime(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        // Scheme sources the frame runtime fetches from `/edwin/scm/` (R9.19).
        Some("txt" | "scm") => "text/plain; charset=utf-8",
        Some("md") => "text/markdown; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// `If-None-Match` equal to the tag (weak comparison), a list holding it, or `*`.
fn not_modified(req: &HeaderMap, etag: &HeaderValue) -> bool {
    req.get_all(IF_NONE_MATCH)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .any(|t| t == "*" || t.strip_prefix("W/").unwrap_or(t).as_bytes() == etag.as_bytes())
}

/// The router's fallback: GET/HEAD of an asset, 404 for any other path whatever the
/// method, 405 for other methods on an asset.
pub async fn serve(
    State(app): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let Some(asset) = app.assets.0.get(uri.path()) else {
        return ApiError::new(StatusCode::NOT_FOUND, "not found").into_response();
    };
    if method != Method::GET && method != Method::HEAD {
        return ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method not allowed").into_response();
    }
    let mut res = if not_modified(&headers, &asset.etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut res = Response::new(Body::from(asset.body.clone()));
        res.headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(asset.ctype));
        res
    };
    let h = res.headers_mut();
    h.insert(ETAG, asset.etag.clone());
    h.insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_is_the_quoted_sha256_prefix() {
        assert_eq!(etag(b""), "\"e3b0c44298fc1c149afbf4c8996fb924\"");
        assert_eq!(etag(b"abc"), "\"ba7816bf8f01cfea414140de5dae2223\"");
        assert_ne!(etag(b"a"), etag(b"b"));
    }

    #[test]
    fn if_none_match_forms() {
        let tag = etag(b"abc");
        let check = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert(IF_NONE_MATCH, HeaderValue::from_str(v).unwrap());
            not_modified(&h, &tag)
        };
        assert!(check("\"ba7816bf8f01cfea414140de5dae2223\""));
        assert!(check("W/\"ba7816bf8f01cfea414140de5dae2223\""));
        assert!(check("\"x\", \"ba7816bf8f01cfea414140de5dae2223\""));
        assert!(check("*"));
        assert!(!check("\"x\""));
        assert!(!check("ba7816bf8f01cfea414140de5dae2223"));
        assert!(!not_modified(&HeaderMap::new(), &tag));
    }

    #[test]
    fn load_maps_paths_and_skips_dot_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "<p>hi</p>").unwrap();
        fs::create_dir(dir.path().join("fonts")).unwrap();
        fs::write(dir.path().join("fonts/a.ttf"), "f").unwrap();
        fs::write(dir.path().join(".hidden"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("index.html"), dir.path().join("link.html"))
            .unwrap();
        let assets = Assets::load(dir.path()).unwrap();
        let mut keys: Vec<_> = assets.0.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["/", "/fonts/a.ttf", "/index.html", "/link.html"]);
        assert_eq!(assets.0["/"].body, "<p>hi</p>");
        assert_eq!(assets.0["/fonts/a.ttf"].ctype, "font/ttf");
        assert_eq!(assets.0["/"].etag, etag(b"<p>hi</p>"));
    }

    #[test]
    fn every_directory_with_an_index_gets_the_slash_alias() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "root").unwrap();
        fs::create_dir_all(dir.path().join("edwin/src")).unwrap();
        fs::create_dir_all(dir.path().join("edwin/scm")).unwrap();
        fs::write(dir.path().join("edwin/index.html"), "console").unwrap();
        fs::write(dir.path().join("edwin/src/scheme.js"), "1").unwrap();
        fs::write(dir.path().join("edwin/scm/emacs.scm"), "(define x 1)").unwrap();
        let assets = Assets::load(dir.path()).unwrap();
        let mut keys: Vec<_> = assets.0.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "/",
                "/edwin/",
                "/edwin/index.html",
                "/edwin/scm/emacs.scm",
                "/edwin/src/scheme.js",
                "/index.html",
            ]
        );
        assert_eq!(assets.0["/edwin/"].body, "console");
        assert_eq!(assets.0["/edwin/"].etag, assets.0["/edwin/index.html"].etag);
        assert_eq!(assets.0["/"].body, "root");
        assert_eq!(
            assets.0["/edwin/scm/emacs.scm"].ctype,
            "text/plain; charset=utf-8"
        );
        // No alias for a directory without an index, and none for a plain file.
        assert!(!assets.0.contains_key("/edwin/src/"));
        assert!(!assets.0.contains_key("/edwin/src/scheme.js/"));
    }

    #[test]
    fn a_missing_index_is_fatal() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("app.js"), "1").unwrap();
        assert!(Assets::load(dir.path()).is_err());
    }

    #[test]
    fn a_symlink_loop_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("index.html"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("loop")).unwrap();
        assert!(Assets::load(dir.path()).is_err());
    }

    #[test]
    fn mime_table() {
        assert_eq!(mime("a.otf"), "font/otf");
        assert_eq!(mime("a.TTF"), "font/ttf");
        assert_eq!(mime("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime("vendor.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime("manifest.webmanifest"), "application/manifest+json");
        assert_eq!(mime("noext"), "application/octet-stream");
        assert_eq!(mime("emacs.scm"), "text/plain; charset=utf-8");
    }
}
