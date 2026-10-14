//! Notes, tasks, reviews, cards, the journal and appends (design §3.5.5, edwind spec
//! §11.3): each route is a `call` to edwind over `edit.sock`, and the `value` of its
//! `result` is the response body. While edwind is unreachable every route is 503
//! (R11.8). Without `editSocket` in `web.json` the GET routes answer the shapes of an
//! empty `notesDir`, as before edwind existed (R15.5). Paths are relative to `/api`.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::edit_client::{EditHandle, NOT_RUNNING};
use crate::http::{ApiError, ApiQuery, Body, Param, not_found};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/nodes", get(nodes))
        .route("/links", get(links))
        .route("/cards", get(cards))
        .route("/reviews", get(reviews).post(reviews_append))
        // Creating tasks is a removed feature (design §3.5.5), not a wrong method.
        .route("/tasks", get(tasks).post(not_found))
        .route("/task/{id}", get(task).post(task_set))
        // `GET /api/journal` was removed with the prototype (design §3.5.5).
        .route("/journal", post(journal).get(not_found))
        .route("/notes/append", post(append))
}

/// Whether the notes directory is in use; the frontend hides notes features otherwise.
/// From edwind's `status` (`notesExists`), false while edwind is not up.
pub async fn exists(app: &AppState) -> bool {
    app.edit_status()
        .await
        .is_some_and(|s| s["notesExists"] == true)
}

type Reply = Result<Json<Value>, ApiError>;

/// `call cmd args` on edwind, or 503 when there is none to call.
async fn forward(edit: Option<&EditHandle>, cmd: &str, args: Value) -> Reply {
    let Some(edit) = edit else {
        return Err(not_running());
    };
    edit.call(cmd, args)
        .await
        .map(Json)
        .map_err(|e| e.into_api())
}

fn not_running() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, NOT_RUNNING)
}

/// The request body as a JSON object; anything else is 400.
fn object(body: &[u8]) -> Result<Map<String, Value>, ApiError> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid request: expected a JSON object",
        )),
        Err(e) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid request: {e}"),
        )),
    }
}

/// A required string field of a request body.
fn required_str<'a>(body: &'a Map<String, Value>, key: &str) -> Result<&'a str, ApiError> {
    body.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, format!("{key} required")))
}

#[derive(Deserialize)]
struct NodesQuery {
    limit: Option<u64>,
}

async fn nodes(State(app): State<AppState>, ApiQuery(q): ApiQuery<NodesQuery>) -> Reply {
    match &app.edit {
        None => Ok(Json(json!({"root": app.cfg.notes_dir, "nodes": []}))),
        edit => forward(edit.as_ref(), "notes-nodes", json!([{"limit": q.limit}])).await,
    }
}

async fn links(State(app): State<AppState>) -> Reply {
    match &app.edit {
        None => Ok(Json(
            json!({"links": [], "backlinks": {}, "outlinks": {}, "files": []}),
        )),
        edit => forward(edit.as_ref(), "notes-links", json!([])).await,
    }
}

async fn cards(State(app): State<AppState>) -> Reply {
    match &app.edit {
        None => Ok(Json(
            json!({"root": app.cfg.notes_dir, "exists": false, "cards": []}),
        )),
        edit => forward(edit.as_ref(), "notes-cards", json!([])).await,
    }
}

async fn reviews(State(app): State<AppState>) -> Reply {
    match &app.edit {
        None => Ok(Json(
            json!({"dir": app.cfg.notes_dir.join(".reviews"), "reviews": []}),
        )),
        edit => forward(edit.as_ref(), "notes-reviews", json!([])).await,
    }
}

async fn reviews_append(State(app): State<AppState>, Body(body): Body) -> Reply {
    let body = object(&body)?;
    let reviews = body
        .get("reviews")
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "reviews required"))?;
    forward(
        app.edit.as_ref(),
        "notes-reviews-append",
        json!([{"reviews": reviews}]),
    )
    .await
}

async fn tasks(State(app): State<AppState>) -> Reply {
    match &app.edit {
        None => Ok(Json(json!({"host": app.cfg.host, "tasks": []}))),
        edit => forward(edit.as_ref(), "notes-tasks", json!([])).await,
    }
}

async fn task(State(app): State<AppState>, Param(id): Param<String>) -> Reply {
    match &app.edit {
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("no task {id}"),
        )),
        edit => forward(edit.as_ref(), "notes-task", json!([{"id": id}])).await,
    }
}

/// `{kw, set?}`: the keyword, and the fields to set on the task line. The edit is
/// attributed to the frame kind, as the board's own edits are.
async fn task_set(
    State(app): State<AppState>,
    Param(id): Param<String>,
    Body(body): Body,
) -> Reply {
    let body = object(&body)?;
    let kw = required_str(&body, "kw")?;
    let set = body.get("set").cloned().unwrap_or(Value::Null);
    forward(
        app.edit.as_ref(),
        "notes-task-set",
        json!([{"id": id, "kw": kw, "set": set, "by": {"kind": "frame"}}]),
    )
    .await
}

async fn journal(State(app): State<AppState>, Body(body): Body) -> Reply {
    let body = object(&body)?;
    let day = required_str(&body, "day")?;
    forward(app.edit.as_ref(), "notes-journal", json!([{"day": day}])).await
}

/// `{path, text, by}`; `by` defaults to this web when the caller gives none.
async fn append(State(app): State<AppState>, Body(body): Body) -> Reply {
    let body = object(&body)?;
    let path = required_str(&body, "path")?;
    let text = required_str(&body, "text")?;
    let by = body
        .get("by")
        .filter(|by| by.is_object())
        .cloned()
        .unwrap_or_else(|| json!({"kind": "web"}));
    forward(
        app.edit.as_ref(),
        "notes-append",
        json!([{"path": path, "text": text, "by": by}]),
    )
    .await
}
