//! `GET /api/info` and `GET /api/sessions` (design §3.5.5). Paths are relative to
//! `/api`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use wb_proto::hub::Summary;

use crate::AppState;
use crate::http::ApiError;
use crate::hub::HubStatus;
use crate::{notes, sample};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/info", get(info))
        .route("/sessions", get(sessions))
}

async fn info(State(app): State<AppState>) -> Json<Value> {
    let status = app.hub.status.borrow().clone();
    let (agents, hub) = match &status {
        HubStatus::Up {
            version,
            build,
            proto,
            started_at,
            agents,
        } => (
            json!(agents),
            json!({"status": "up", "version": version, "build": build, "proto": proto, "startedAt": started_at}),
        ),
        HubStatus::Incompatible { proto } => (
            json!([]),
            json!({"status": "incompatible", "version": null, "build": null, "proto": proto, "startedAt": null}),
        ),
        HubStatus::Down => (
            json!([]),
            json!({"status": "down", "version": null, "build": null, "proto": null, "startedAt": null}),
        ),
    };
    Json(json!({
        "host": app.cfg.host,
        "home": std::env::var("HOME").ok(),
        "sample": sample::enabled(),
        "notes": app.cfg.notes_dir,
        "notesExists": notes::exists(),
        "state": app.cfg.state_dir,
        "dist": null,
        "tmux": false,
        "artifactOrigin": null,
        "agents": agents,
        "hub": hub,
    }))
}

async fn sessions(State(app): State<AppState>) -> Response {
    let status = app.hub.status.borrow().clone();
    match status {
        HubStatus::Up { .. } => {}
        HubStatus::Down => {
            return ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "hub unavailable")
                .into_response();
        }
        HubStatus::Incompatible { .. } => {
            return ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "hub incompatible")
                .into_response();
        }
    }
    let sessions: Vec<Summary> = app
        .hub
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .cloned()
        .collect();
    Json(json!({"host": app.cfg.host, "sessions": sessions})).into_response()
}
