//! `/acp` arrives with M3; until then an upgrade to it is 404.

use axum::Router;

use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
}
