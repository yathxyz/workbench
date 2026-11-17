//! Observed sessions over the API (design §3.8.3): the events the hosts send in, and
//! the records built from them.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use super::{ApiState, Events, Read};
use crate::http::{ApiError, Body, Param};
use crate::observed::ObservedSession;
use crate::util::now_ms;

pub fn routes() -> Router<ApiState> {
    Router::new()
        .route("/events", post(ingest))
        .route("/observed", get(list))
        .route("/observed/{id}", get(one))
}

/// Files one event under the client's host; a host named in the event is ignored.
async fn ingest(
    Events(client): Events,
    State(api): State<ApiState>,
    Body(body): Body,
) -> Result<StatusCode, ApiError> {
    let bad = |message: String| ApiError::new(StatusCode::BAD_REQUEST, message);
    let event: Value = serde_json::from_slice(&body).map_err(|_| bad("bad body".into()))?;
    // Config validation gives every client with the events scope a host.
    let host = client.host.as_deref().unwrap_or_default();
    api.registry.ingest(host, event, now_ms()).map_err(bad)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list(_: Read, State(api): State<ApiState>) -> Json<Value> {
    Json(json!({"sessions": api.registry.list()}))
}

async fn one(
    _: Read,
    State(api): State<ApiState>,
    Param(id): Param<String>,
) -> Result<Json<ObservedSession>, ApiError> {
    match api.registry.get(&id) {
        Some(session) => Ok(Json(session)),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no such observed session",
        )),
    }
}
