//! `/rpc` (design §3.5.3). M0 sends the feed only: `hub{…}` on connect and on every
//! change, and `board{etag}` after every board write. Client messages are read for the
//! cap and the keepalive, and otherwise ignored.

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use serde_json::{Value, json};
use tokio::sync::broadcast::error::RecvError;
use wb_proto::limits::WS_MAX_RPC;

use crate::http::{Keepalive, Tick, close, send_json, upgrade_required, ws_close, ws_too_big};
use crate::hub::HubStatus;
use crate::{AppState, FeedMsg};

const ROUTE: &str = "/rpc";

pub fn routes() -> Router<AppState> {
    Router::new().route(ROUTE, get(upgrade))
}

async fn upgrade(
    State(app): State<AppState>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    match ws {
        Ok(ws) => ws
            .max_message_size(WS_MAX_RPC)
            .max_frame_size(WS_MAX_RPC)
            .on_upgrade(move |socket| run(app, socket)),
        Err(_) => upgrade_required(),
    }
}

/// `hub{status, version?, build?, startedAt?}`.
fn hub_msg(status: &HubStatus) -> Value {
    let mut msg = json!({"t": "hub", "status": status.name()});
    if let HubStatus::Up {
        version,
        build,
        started_at,
        ..
    } = status
    {
        msg["version"] = version.as_str().into();
        msg["startedAt"] = (*started_at).into();
        if let Some(build) = build {
            msg["build"] = build.as_str().into();
        }
    }
    msg
}

async fn run(app: AppState, mut ws: WebSocket) {
    // Subscribe before reading the status, so no change falls between the two.
    let mut feed = app.feed.subscribe();
    let first = hub_msg(&app.hub.status.borrow());
    if send_json(&mut ws, &first).await.is_err() {
        return;
    }
    let stop = app.stopped();
    tokio::pin!(stop);
    let mut keepalive = Keepalive::new();
    loop {
        let out = tokio::select! {
            msg = ws.recv() => match msg {
                None | Some(Ok(Message::Close(_))) => return,
                Some(Err(_)) => return ws_too_big(ws, ROUTE).await,
                Some(Ok(_)) => {
                    keepalive.seen();
                    continue;
                }
            },
            msg = feed.recv() => match msg {
                Ok(FeedMsg::Hub(status)) => hub_msg(&status),
                Ok(FeedMsg::Board { etag }) => json!({"t": "board", "etag": etag}),
                // Missed messages: the status is all that can be resent.
                Err(RecvError::Lagged(_)) => hub_msg(&app.hub.status.borrow()),
                Err(RecvError::Closed) => return,
            },
            tick = keepalive.tick() => match tick {
                Tick::Ping => {
                    if ws.send(Message::Ping(Bytes::new())).await.is_err() {
                        return;
                    }
                    continue;
                }
                Tick::Dead => return ws_close(ws, ROUTE, close::GOING_AWAY, "no answer").await,
            },
            () = &mut stop => return ws_close(ws, ROUTE, close::RESTART, "wb-web restarting").await,
        };
        if send_json(&mut ws, &out).await.is_err() {
            return;
        }
    }
}
