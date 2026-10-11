//! `/rpc` (design §3.5.3), the feed so far: `hub{…}` and `sessions{…}` on connect and
//! whenever the hub comes up, then `session`, `gone` and `board{etag}` as they happen.
//! Client messages are read for the cap and the keepalive, and otherwise ignored.

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
use crate::hub::{HubStatus, with_state};
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

/// `hub{status, version?, build?, startedAt?, stale?}`.
fn hub_msg(status: &HubStatus) -> Value {
    let mut msg = json!({"t": "hub", "status": status.name()});
    if let HubStatus::Up(info) = status {
        msg["version"] = info.version.as_str().into();
        msg["startedAt"] = info.started_at.into();
        msg["stale"] = info.stale.into();
        if let Some(build) = &info.build {
            msg["build"] = build.as_str().into();
        }
    }
    msg
}

/// The hub status, and while the hub is up every session it knows.
fn snapshot(app: &AppState) -> Vec<Value> {
    let status = app.hub.status.borrow().clone();
    let mut msgs = vec![hub_msg(&status)];
    if let HubStatus::Up(_) = status {
        let sessions: Vec<Value> = app.hub.sessions().iter().map(with_state).collect();
        msgs.push(json!({"t": "sessions", "sessions": sessions}));
    }
    msgs
}

async fn run(app: AppState, mut ws: WebSocket) {
    // Subscribe before the snapshot, so no change falls between the two. A change in
    // both arrives twice, and applying it again is harmless.
    let mut feed = app.feed.subscribe();
    for msg in snapshot(&app) {
        if send_json(&mut ws, &msg).await.is_err() {
            return;
        }
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
                // The control task fills the session map before it reports up.
                Ok(FeedMsg::Hub(HubStatus::Up(_))) => snapshot(&app),
                Ok(FeedMsg::Hub(status)) => vec![hub_msg(&status)],
                Ok(FeedMsg::Session(session)) => {
                    vec![json!({"t": "session", "session": with_state(&session)})]
                }
                Ok(FeedMsg::Gone { sid, epoch }) => vec![json!({"t": "gone", "sid": sid, "epoch": epoch})],
                Ok(FeedMsg::Board { etag }) => vec![json!({"t": "board", "etag": etag})],
                // Missed messages: resend what can be resent.
                Err(RecvError::Lagged(_)) => snapshot(&app),
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
        for msg in out {
            if send_json(&mut ws, &msg).await.is_err() {
                return;
            }
        }
    }
}
