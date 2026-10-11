//! The JSON error envelope, extractors that reject in JSON instead of axum's plain
//! text, and the WebSocket plumbing shared by the socket routes.

use std::pin::Pin;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::extract::{FromRequest, FromRequestParts, Path, Request};
use axum::http::header::CACHE_CONTROL;
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::time::{Instant, Interval, MissedTickBehavior, Sleep, interval_at, sleep, timeout};
use wb_proto::limits::{WS_DEAD, WS_PING};

/// `{"error": message}` with `Cache-Control: no-store`.
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        no_store((self.status, Json(json!({ "error": self.message }))).into_response())
    }
}

/// Sets `Cache-Control: no-store`; every `/api` response passes through it.
pub fn no_store(mut res: Response) -> Response {
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// The raw request body. Over the route's limit it is 413 JSON.
pub struct Body(pub Bytes);

impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        match Bytes::from_request(req, state).await {
            Ok(bytes) => Ok(Body(bytes)),
            Err(r) if r.status() == StatusCode::PAYLOAD_TOO_LARGE => Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request body too large",
            )),
            Err(_) => Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "cannot read the request body",
            )),
        }
    }
}

/// Path parameters. A malformed one is 400 JSON.
pub struct Param<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned + Send> FromRequestParts<S> for Param<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        match Path::<T>::from_request_parts(parts, state).await {
            Ok(Path(t)) => Ok(Param(t)),
            Err(_) => Err(ApiError::new(StatusCode::BAD_REQUEST, "bad path")),
        }
    }
}

/// The answer to a plain GET on a socket route.
pub fn upgrade_required() -> Response {
    ApiError::new(StatusCode::BAD_REQUEST, "websocket upgrade required").into_response()
}

/// Close codes wb-web sends (design §3.5.4).
pub mod close {
    /// Final: `gone`, and the frontend does not reconnect.
    pub const FINAL: u16 = 1000;
    /// The browser stopped answering pings.
    pub const GOING_AWAY: u16 = 1001;
    /// Protocol violation or open deadline.
    pub const POLICY: u16 = 1008;
    /// Message larger than the route's cap.
    pub const TOO_BIG: u16 = 1009;
    /// The hub connection under the socket ended.
    pub const HUB_LOST: u16 = 1011;
    /// wb-web is shutting down.
    pub const RESTART: u16 = 1012;
    /// No usable hub.
    pub const HUB_UNAVAILABLE: u16 = 1013;
}

/// How long a closing socket waits for the browser before it is dropped.
const CLOSE_LINGER: Duration = Duration::from_millis(500);

/// Sends `v` as a text frame.
pub async fn send_json(ws: &mut WebSocket, v: &Value) -> Result<(), axum::Error> {
    ws.send(Message::Text(v.to_string().into())).await
}

/// Sends a close frame, then waits briefly for the browser's close reply so the socket
/// is not reset under the frame.
pub async fn ws_close(mut ws: WebSocket, route: &str, code: u16, reason: &'static str) {
    tracing::info!(route, code, reason, "websocket closed");
    let frame = CloseFrame {
        code,
        reason: reason.into(),
    };
    if ws.send(Message::Close(Some(frame))).await.is_ok() {
        let _ = timeout(CLOSE_LINGER, async {
            while let Some(Ok(_)) = ws.recv().await {}
        })
        .await;
    }
}

/// Closes with 1009 after a failed read.
///
/// Every read error is answered this way: a browser that follows the protocol can only
/// cause one by exceeding the cap, and a peer that broke the connection never sees the
/// code. The rest of the oversized message stays unread, and the socket cannot be read
/// any more, so the linger is a plain sleep that lets the browser read the close frame
/// before the drop resets the connection.
pub async fn ws_too_big(mut ws: WebSocket, route: &str) {
    tracing::info!(
        route,
        code = close::TOO_BIG,
        "websocket closed: message too big"
    );
    let frame = CloseFrame {
        code: close::TOO_BIG,
        reason: "message too big".into(),
    };
    if ws.send(Message::Close(Some(frame))).await.is_ok() {
        sleep(CLOSE_LINGER).await;
    }
}

/// Ping every `WS_PING`; give up after `WS_DEAD` without any frame from the browser.
pub struct Keepalive {
    ping: Interval,
    dead: Pin<Box<Sleep>>,
}

pub enum Tick {
    Ping,
    Dead,
}

impl Keepalive {
    pub fn new() -> Self {
        let mut ping = interval_at(Instant::now() + WS_PING, WS_PING);
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        Keepalive {
            ping,
            dead: Box::pin(sleep(WS_DEAD)),
        }
    }

    /// Records a frame from the browser.
    pub fn seen(&mut self) {
        self.dead.as_mut().reset(Instant::now() + WS_DEAD);
    }

    /// Resolves when a ping is due or the browser has been silent too long.
    pub async fn tick(&mut self) -> Tick {
        tokio::select! {
            _ = self.ping.tick() => Tick::Ping,
            () = &mut self.dead => Tick::Dead,
        }
    }
}
