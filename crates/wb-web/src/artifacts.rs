//! Artifact versions and per-node db. Until M5 these are stubs answering as if no
//! artifact existed (design §3.5.5). Paths are relative to `/api`.

use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::AppState;
use crate::http::not_found;

pub fn routes() -> Router<AppState> {
    Router::new()
        // Deleting artifacts is a removed feature (design §3.5.5), not a wrong method.
        .route("/artifact/{node}", get(artifact).delete(not_found))
        .route("/db/{node}", get(db))
}

async fn artifact() -> Json<Value> {
    Json(json!({
        "meta": {"head": null, "versions": [], "capabilities": {}},
        "content": null,
        "url": null,
    }))
}

async fn db() -> Json<Value> {
    Json(json!({}))
}
