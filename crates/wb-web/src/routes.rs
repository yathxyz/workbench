//! The router: the one place that merges each module's `routes()` (design §5, W-1).
//!
//! Modules serving `/api` give paths relative to it; the socket modules give their
//! own top-level path.

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::middleware::{from_fn_with_state, map_response};
use axum::response::Response;

use crate::http::{ApiError, no_store, not_found};
use crate::{
    AppState, artifacts, auth, blobs, board, fsapi, host, info, media, notes, relay_acp,
    relay_edit, relay_pty, rpc, static_files,
};

/// Request bodies outside the routes that set their own limit.
const BODY_MAX: usize = 1 << 20;

pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .merge(info::routes())
        .merge(board::routes())
        .merge(fsapi::routes())
        .merge(notes::routes())
        .merge(host::routes())
        .merge(artifacts::routes())
        .merge(blobs::api_routes())
        .merge(media::routes())
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .layer(map_response(api_no_store));
    Router::new()
        .nest("/api", api)
        .merge(relay_pty::routes())
        .merge(relay_acp::routes())
        .merge(relay_edit::routes())
        .merge(rpc::routes())
        .merge(blobs::routes())
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(static_files::serve)
        .layer(DefaultBodyLimit::max(BODY_MAX))
        // Last, so it wraps every route and fallback above.
        .layer(from_fn_with_state(state.clone(), auth::floor))
        .with_state(state)
}

async fn api_no_store(res: Response) -> Response {
    no_store(res)
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method not allowed")
}
