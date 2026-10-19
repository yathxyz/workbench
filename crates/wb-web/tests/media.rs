//! `POST /api/media` and `/api/info`'s `media` (F-A41) against a stub provider that
//! speaks both protocols: the OpenAI image API under `/v1` and Hugging Face Inference
//! under `/hf`.

mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use common::{FakeHub, Web};
use serde_json::{Value, json};

/// A 1×1 PNG and its base64.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\0\x05\0\x01\xff\x89\x99=\x1d\0\0\0\0IEND\xaeB`\x82";
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/// What the stub saw: path, Authorization header, body.
type Seen = Arc<Mutex<Vec<(String, String, Vec<u8>)>>>;

async fn stub() -> (SocketAddr, Seen) {
    let seen: Seen = Arc::default();
    let note = |s: &Seen, path: String, h: &HeaderMap, body: &Bytes| {
        let auth = h
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        s.lock().unwrap().push((path, auth, body.to_vec()));
    };
    let app = Router::new()
        .route(
            "/v1/images/generations",
            post(
                move |State(s): State<Seen>, h: HeaderMap, body: Bytes| async move {
                    note(&s, "generations".into(), &h, &body);
                    let v: Value = serde_json::from_slice(&body).unwrap();
                    let n = v["n"].as_u64().unwrap_or(1) as usize;
                    axum::Json(json!({"data": vec![json!({"b64_json": PNG_B64}); n]}))
                },
            ),
        )
        .route(
            "/v1/images/edits",
            post(
                move |State(s): State<Seen>, h: HeaderMap, body: Bytes| async move {
                    note(&s, "edits".into(), &h, &body);
                    axum::Json(json!({"data": [{"b64_json": PNG_B64}]}))
                },
            ),
        )
        .route(
            "/hf/models/{*model}",
            post(
                move |State(s): State<Seen>,
                      Path(model): Path<String>,
                      h: HeaderMap,
                      body: Bytes| async move {
                    note(&s, format!("hf {model}"), &h, &body);
                    ([("content-type", "image/png")], PNG)
                },
            ),
        )
        .route(
            "/bad/images/generations",
            post(|| async {
                (
                    StatusCode::BAD_REQUEST,
                    axum::Json(json!({"error": {"message": "rejected by the content policy"}})),
                )
                    .into_response()
            }),
        )
        .route(
            "/text/images/generations",
            post(|| async { axum::Json(json!({"data": [{"b64_json": "aGVsbG8="}]})) }),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, seen)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn images_come_from_the_configured_provider_and_land_in_the_blob_store() {
    let hub = FakeHub::start();
    let (stub_addr, seen) = stub().await;
    let keys = tempfile::tempdir().unwrap();
    let key = keys.path().join("key");
    std::fs::write(&key, "sk-test-123\n").unwrap();
    let base = format!("http://{stub_addr}");
    let web = Web::start_with(&hub.path, |cfg| {
        cfg["media"] = json!({"providers": {
            "oai": {"api": "openai", "baseUrl": format!("{base}/v1"), "keyFile": key, "models": ["img-1", "img-2"]},
            "hf": {"api": "huggingface", "baseUrl": format!("{base}/hf"), "models": ["org/flux"]},
            "bad": {"api": "openai", "baseUrl": format!("{base}/bad"), "models": ["m"]},
            "text": {"api": "openai", "baseUrl": format!("{base}/text"), "models": ["m"]},
            "nokey": {"api": "openai", "baseUrl": format!("{base}/v1"), "keyFile": keys.path().join("missing"), "models": ["m"]},
        }});
    });

    let info = web.req("GET", "/api/info").send().await.json();
    assert_eq!(
        info["media"][2],
        json!({"name": "nokey", "api": "openai", "models": ["m"], "ops": ["imagine", "edit"]})
    );
    assert!(!info.to_string().contains("sk-test"));

    let run = |body: Value| {
        let req = web.req("POST", "/api/media").body(body.to_string());
        async move { req.send().await }
    };
    // imagine, two variations, on the OpenAI protocol with the key from the file
    let res = run(json!({"provider": "oai", "op": "imagine", "prompt": "a red square", "n": 2, "size": "512x512"})).await;
    assert_eq!(res.status, 200, "{:?}", String::from_utf8_lossy(&res.body));
    let v = res.json();
    let images = v["images"].as_array().unwrap();
    assert_eq!(images.len(), 2);
    assert_eq!(images[0]["type"], "image/png");
    let hash = images[0]["hash"].as_str().unwrap().to_owned();
    assert_eq!(
        std::fs::read(web.dir.path().join("state/blobs").join(&hash)).unwrap(),
        PNG
    );
    {
        let seen = seen.lock().unwrap();
        let (path, auth, body) = &seen[0];
        assert_eq!(path, "generations");
        assert_eq!(auth, "Bearer sk-test-123");
        let sent: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(
            sent,
            json!({"model": "img-1", "prompt": "a red square", "n": 2, "size": "512x512"})
        );
    }

    // edit sends the stored image as multipart
    let res = run(json!({"provider": "oai", "model": "img-2", "op": "edit", "prompt": "make it blue", "image": hash})).await;
    assert_eq!(res.status, 200, "{:?}", String::from_utf8_lossy(&res.body));
    {
        let seen = seen.lock().unwrap();
        let (path, _, body) = seen.last().unwrap();
        assert_eq!(path, "edits");
        let body = String::from_utf8_lossy(body);
        assert!(body.contains("name=\"model\"\r\n\r\nimg-2\r\n"), "{body}");
        assert!(
            body.contains("filename=\"image.png\"\r\nContent-Type: image/png"),
            "{body}"
        );
    }

    // Hugging Face: one request per image, no key, the image bytes as the answer
    let res =
        run(json!({"provider": "hf", "op": "imagine", "prompt": "fog", "n": 2, "size": "512x512"}))
            .await;
    assert_eq!(res.status, 200, "{:?}", String::from_utf8_lossy(&res.body));
    assert_eq!(res.json()["images"].as_array().unwrap().len(), 2);
    {
        let seen = seen.lock().unwrap();
        let hf: Vec<_> = seen.iter().filter(|s| s.0 == "hf org/flux").collect();
        assert_eq!(hf.len(), 2);
        assert_eq!(hf[0].1, "");
        let sent: Value = serde_json::from_slice(&hf[0].2).unwrap();
        assert_eq!(sent["inputs"], "fog");
        assert!(sent["parameters"]["seed"].is_u64());
        assert_eq!(sent["parameters"]["width"], 512);
    }
    // image to image takes the size as target_size
    let res = run(
        json!({"provider": "hf", "op": "edit", "prompt": "fog", "image": hash, "size": "512x512"}),
    )
    .await;
    assert_eq!(res.status, 200);
    {
        let seen = seen.lock().unwrap();
        let sent: Value = serde_json::from_slice(&seen.last().unwrap().2).unwrap();
        assert_eq!(sent["inputs"], PNG_B64);
        assert_eq!(sent["parameters"]["prompt"], "fog");
        assert_eq!(
            sent["parameters"]["target_size"],
            json!({"width": 512, "height": 512})
        );
        assert!(sent["parameters"].get("width").is_none());
    }

    // what fails, and how it says so
    for (body, status, needle) in [
        (
            json!({"provider": "none", "op": "imagine", "prompt": "x"}),
            400,
            "no media provider",
        ),
        (
            json!({"provider": "oai", "model": "dall-e", "op": "imagine", "prompt": "x"}),
            400,
            "offers no model",
        ),
        (
            json!({"provider": "oai", "op": "imagine", "prompt": "  "}),
            400,
            "prompt is empty",
        ),
        (
            json!({"provider": "oai", "op": "imagine", "prompt": "x", "size": "big"}),
            400,
            "size must be",
        ),
        (
            json!({"provider": "oai", "op": "edit", "prompt": "x"}),
            400,
            "edit needs an image",
        ),
        (
            json!({"provider": "oai", "op": "edit", "prompt": "x", "image": "0".repeat(64)}),
            400,
            "not on this server",
        ),
        (
            json!({"provider": "bad", "op": "imagine", "prompt": "x"}),
            502,
            "rejected by the content policy",
        ),
        (
            json!({"provider": "text", "op": "imagine", "prompt": "x"}),
            502,
            "not an image",
        ),
        (
            json!({"provider": "nokey", "op": "imagine", "prompt": "x"}),
            503,
            "key file cannot be read",
        ),
        (
            json!({"provider": "oai", "op": "paint", "prompt": "x"}),
            400,
            "invalid request",
        ),
    ] {
        let res = run(body.clone()).await;
        assert_eq!(
            res.status,
            status,
            "{body}: {:?}",
            String::from_utf8_lossy(&res.body)
        );
        let err = res.json()["error"].as_str().unwrap().to_owned();
        assert!(err.contains(needle), "{body}: {err}");
        assert!(!err.contains("sk-test"), "{err}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_providers_the_catalog_is_empty() {
    let hub = FakeHub::start();
    let web = Web::start(&hub.path);
    assert_eq!(
        web.req("GET", "/api/info").send().await.json()["media"],
        json!([])
    );
    let res = web
        .req("POST", "/api/media")
        .body(json!({"provider": "x", "op": "imagine", "prompt": "a"}).to_string())
        .send()
        .await;
    assert_eq!(res.status, 400);
}
