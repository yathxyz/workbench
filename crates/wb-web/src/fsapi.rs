//! `ls`, `stat`, `cat` and `mv` arrive with M1; until then these paths are 404.
//! Paths are relative to `/api`.

use axum::Router;

use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
}
