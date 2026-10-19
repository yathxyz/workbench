//! `POST /api/blob` and `GET /blob/{hash}`: images and PDFs on the canvas (F-A32, F-A40).

mod common;

use std::os::unix::fs::PermissionsExt;

use common::Web;
use serde_json::json;
use sha2::{Digest, Sha256};

/// A 1×1 PNG.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_image_is_stored_once_by_its_hash_and_served_back() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));

    let res = web
        .req("POST", "/api/blob")
        .set("Content-Type", "text/html")
        .body(PNG)
        .send()
        .await;
    assert_eq!(res.status, 200, "{:?}", String::from_utf8_lossy(&res.body));
    assert_eq!(res.header("cache-control"), Some("no-store"));
    let v = res.json();
    let hash = v["hash"].as_str().unwrap().to_owned();
    let want: String = Sha256::digest(PNG)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(hash, want);
    assert_eq!(
        v,
        json!({"hash": hash, "type": "image/png", "size": PNG.len()})
    );

    let file = web.dir.path().join("state/blobs").join(&hash);
    assert_eq!(std::fs::read(&file).unwrap(), PNG);
    assert_eq!(
        std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );

    // The same bytes again: same answer, still one file.
    let again = web.req("POST", "/api/blob").body(PNG).send().await;
    assert_eq!(again.json(), v);
    assert_eq!(
        std::fs::read_dir(web.dir.path().join("state/blobs"))
            .unwrap()
            .count(),
        1
    );

    let res = web.req("GET", &format!("/blob/{hash}")).send().await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, PNG);
    assert_eq!(res.header("content-type"), Some("image/png"));
    assert_eq!(
        res.header("cache-control"),
        Some("private, max-age=31536000, immutable")
    );
    assert_eq!(res.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(
        res.header("content-security-policy"),
        Some("default-src 'none'; sandbox")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_raster_images_are_taken_and_only_hashes_are_served() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));

    for body in [
        &b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"[..],
        b"<!doctype html><script>alert(1)</script>",
        b"plain text",
    ] {
        let res = web
            .req("POST", "/api/blob")
            .set("Content-Type", "image/png")
            .body(body)
            .send()
            .await;
        assert_eq!(res.status, 415, "{body:?}");
        assert_eq!(
            res.json(),
            json!({"error": "not an image or a PDF: PNG, JPEG, GIF, WebP, AVIF or PDF"})
        );
    }
    let res = web.req("POST", "/api/blob").send().await;
    assert_eq!(res.status, 400);
    assert!(!web.dir.path().join("state/blobs").exists());

    // A POST needs the origin like every other mutation.
    let res = web
        .req("POST", "/api/blob")
        .without("Origin")
        .body(PNG)
        .send()
        .await;
    assert_eq!(res.status, 403);

    for path in [
        format!("/blob/{}", "0".repeat(64)),
        format!("/blob/{}", "A".repeat(64)),
        "/blob/..%2Fboards%2Ftesthost.json".to_owned(),
        "/blob/abc".to_owned(),
    ] {
        let res = web.req("GET", &path).send().await;
        assert_eq!(res.status, 404, "{path}");
    }
    // A GET on the upload path is not a download.
    assert_eq!(web.req("GET", "/api/blob").send().await.status, 405);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pdf_is_stored_and_served_as_an_attachment() {
    let dir = tempfile::tempdir().unwrap();
    let web = Web::start(&dir.path().join("hub.sock"));
    let pdf = b"%PDF-1.4\n%\xe2\xe3\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n";
    let res = web.req("POST", "/api/blob").body(&pdf[..]).send().await;
    assert_eq!(res.status, 200, "{:?}", String::from_utf8_lossy(&res.body));
    let v = res.json();
    assert_eq!(v["type"], "application/pdf");
    let res = web
        .req("GET", &format!("/blob/{}", v["hash"].as_str().unwrap()))
        .send()
        .await;
    assert_eq!(res.status, 200);
    assert_eq!(res.body, pdf);
    assert_eq!(res.header("content-type"), Some("application/pdf"));
    assert_eq!(res.header("content-disposition"), Some("attachment"));
    assert_eq!(
        res.header("content-security-policy"),
        Some("default-src 'none'; sandbox")
    );
}
