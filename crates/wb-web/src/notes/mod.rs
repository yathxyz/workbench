//! Notes, tasks, reviews and cards. Until M5 these are stubs answering with the shapes
//! of an empty `notesDir` (design §3.5.5). Paths are relative to `/api`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::AppState;
use crate::http::{ApiError, Param};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/nodes", get(nodes))
        .route("/links", get(links))
        .route("/cards", get(cards))
        .route("/reviews", get(reviews))
        .route("/tasks", get(tasks))
        .route("/task/{id}", get(task))
}

/// Whether the notes directory is in use; the frontend hides notes features otherwise.
pub fn exists() -> bool {
    false
}

async fn nodes(State(app): State<AppState>) -> Json<Value> {
    Json(json!({"root": app.cfg.notes_dir, "nodes": []}))
}

async fn links() -> Json<Value> {
    Json(json!({"links": [], "backlinks": {}, "outlinks": {}, "files": []}))
}

async fn cards(State(app): State<AppState>) -> Json<Value> {
    Json(json!({"root": app.cfg.notes_dir, "exists": exists(), "cards": []}))
}

async fn reviews(State(app): State<AppState>) -> Json<Value> {
    Json(json!({"dir": app.cfg.notes_dir.join(".reviews"), "reviews": []}))
}

async fn tasks(State(app): State<AppState>) -> Json<Value> {
    Json(json!({"host": app.cfg.host, "tasks": []}))
}

async fn task(Param(id): Param<String>) -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, format!("no task {id}"))
}
