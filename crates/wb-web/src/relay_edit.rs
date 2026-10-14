//! `/edit` (edwind spec R9.16, R9.17): one browser WebSocket relayed verbatim to one
//! `edit.sock` connection. Each text frame becomes one line and each line one text
//! frame; nothing is parsed, so the browser sends `hello` itself (`kind: "frame"`).
//!
//! The close codes, in the order they are checked: no `editSocket` or a failed connect
//! is 1013; a binary frame or a text frame holding a newline is 1003; a frame or a line
//! over `MAX_LINE` is 1009; edwind closing its end is 1011; wb-web stopping is 1012;
//! a browser silent for `WS_DEAD` is 1001.

use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::net::unix::OwnedWriteHalf;
use tokio::time::timeout;
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};
use wb_proto::limits::MAX_LINE;

use crate::AppState;
use crate::http::{Keepalive, Tick, close, upgrade_required, ws_close, ws_too_big};

const ROUTE: &str = "/edit";
/// Largest browser message on `/edit`: the `edit.sock` line cap, so a frame that fits
/// is a line that fits. Larger closes the socket with 1009.
pub const WS_MAX_EDIT: usize = MAX_LINE;
/// Longest wait for edwind to accept the connection.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

pub fn routes() -> Router<AppState> {
    Router::new().route(ROUTE, get(upgrade))
}

async fn upgrade(
    State(app): State<AppState>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Ok(ws) = ws else {
        return upgrade_required();
    };
    let running = app.socket();
    ws.max_message_size(WS_MAX_EDIT)
        .max_frame_size(WS_MAX_EDIT)
        .on_upgrade(move |socket| async move {
            run(app, socket).await;
            drop(running);
        })
}

/// Why the relay stopped.
enum End {
    /// Close the browser socket with this code.
    Close(u16, &'static str),
    /// The browser socket is already gone.
    Gone,
}

const EDWIND_LOST: End = End::Close(close::HUB_LOST, "edwind connection lost");

async fn run(app: AppState, mut ws: WebSocket) {
    let Some(path) = &app.cfg.edit_socket else {
        return ws_close(
            ws,
            ROUTE,
            close::HUB_UNAVAILABLE,
            "workbench-edit is not configured",
        )
        .await;
    };
    let stream = match timeout(CONNECT_TIMEOUT, UnixStream::connect(path)).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "edwind connect failed");
            return ws_close(
                ws,
                ROUTE,
                close::HUB_UNAVAILABLE,
                "workbench-edit is not running",
            )
            .await;
        }
        Err(_) => {
            return ws_close(
                ws,
                ROUTE,
                close::HUB_UNAVAILABLE,
                "workbench-edit did not accept the connection",
            )
            .await;
        }
    };
    let (rx, mut tx) = stream.into_split();
    let mut lines = FramedRead::new(rx, LinesCodec::new_with_max_length(MAX_LINE));
    let stop = app.stopped();
    tokio::pin!(stop);
    let mut keepalive = Keepalive::new();
    let end = loop {
        let step = tokio::select! {
            msg = ws.recv() => match msg {
                None | Some(Ok(Message::Close(_))) => Err(End::Gone),
                Some(Err(_)) => return ws_too_big(ws, ROUTE).await,
                Some(Ok(msg)) => {
                    keepalive.seen();
                    match msg {
                        Message::Text(text) => to_edwind(&mut tx, text.as_str()).await,
                        Message::Binary(_) => {
                            Err(End::Close(close::UNSUPPORTED, "binary frames are not accepted"))
                        }
                        _ => Ok(()),
                    }
                }
            },
            line = lines.next() => match line {
                Some(Ok(line)) => ws.send(Message::Text(line.into())).await.map_err(|_| End::Gone),
                Some(Err(LinesCodecError::MaxLineLengthExceeded)) => {
                    Err(End::Close(close::TOO_BIG, "line too long"))
                }
                Some(Err(LinesCodecError::Io(_))) | None => Err(EDWIND_LOST),
            },
            tick = keepalive.tick() => match tick {
                Tick::Ping => ws.send(Message::Ping(Bytes::new())).await.map_err(|_| End::Gone),
                Tick::Dead => Err(End::Close(close::GOING_AWAY, "no answer")),
            },
            () = &mut stop => Err(End::Close(close::RESTART, "wb-web restarting")),
        };
        if let Err(end) = step {
            break end;
        }
    };
    if let End::Close(code, reason) = end {
        ws_close(ws, ROUTE, code, reason).await;
    }
}

/// One text frame as one line. The frame already fits `MAX_LINE` (the socket's
/// message cap), so only the framing is checked here.
async fn to_edwind(tx: &mut OwnedWriteHalf, text: &str) -> Result<(), End> {
    if text.contains('\n') {
        return Err(End::Close(
            close::UNSUPPORTED,
            "a frame must hold one line without a newline",
        ));
    }
    let mut line = Vec::with_capacity(text.len() + 1);
    line.extend_from_slice(text.as_bytes());
    line.push(b'\n');
    tx.write_all(&line).await.map_err(|e| {
        tracing::warn!(error = %e, "edwind connection failed");
        EDWIND_LOST
    })
}
