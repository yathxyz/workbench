//! Processes and systemd units, read only. Until M5 the reads are stubs with empty
//! lists; unit control is refused for good (design §3.5.5). Paths are relative to
//! `/api`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use crate::AppState;
use crate::http::{ApiError, Param};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/proc", get(procs))
        .route("/units", get(units))
        .route("/unit/{name}", get(unit))
        .route("/unit/{name}/{verb}", post(unit_control))
}

async fn procs(State(app): State<AppState>) -> Json<Value> {
    Json(json!({"host": app.cfg.host, "procs": []}))
}

async fn units(State(app): State<AppState>) -> Json<Value> {
    Json(json!({"host": app.cfg.host, "units": [], "error": null}))
}

async fn unit(Param(name): Param<String>) -> Json<Value> {
    Json(json!({"unit": name, "props": {}, "status": "", "error": null, "procs": []}))
}

/// Workbench never starts or stops units.
async fn unit_control(Param((_, verb)): Param<(String, String)>) -> ApiError {
    match verb.as_str() {
        "start" | "stop" | "restart" => ApiError::new(
            StatusCode::FORBIDDEN,
            "unit control is disabled in Workbench; use ssh",
        ),
        _ => ApiError::new(StatusCode::NOT_FOUND, "not found"),
    }
}
