//! `/pty` (design §3.5.1): one browser terminal socket relayed to a hub connection of
//! its own. Wire-compatible with the prototype frontend plus the additive fields.

use std::collections::{BTreeMap, HashMap};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use serde_json::{Map, Value, json};
use tokio::time::{Instant, sleep_until};
use wb_proto::hub::{ErrorCode, HubMessage, HubRequest, PtyOpenReply, Resume, SpawnPty};
use wb_proto::limits::{CARD_OPEN_DEADLINE, PTY_INPUT_FRAME, WS_MAX_PTY};

use crate::AppState;
use crate::http::{Keepalive, Tick, close, send_json, upgrade_required, ws_close, ws_too_big};
use crate::hub::{HubConn, HubStatus, REPLY_TIMEOUT};
use crate::util::{sanitize_sid, split_utf8};

const ROUTE: &str = "/pty";
const OVERFLOW_NOTICE: &str = "\r\n[workbench: paste dropped, input queue full]\r\n";

pub fn routes() -> Router<AppState> {
    Router::new().route(ROUTE, get(upgrade))
}

async fn upgrade(
    State(app): State<AppState>,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    match ws {
        Ok(ws) => ws
            .max_message_size(WS_MAX_PTY)
            .max_frame_size(WS_MAX_PTY)
            .on_upgrade(move |socket| run(app, socket)),
        Err(_) => upgrade_required(),
    }
}

/// Why the relay stopped.
enum End {
    /// Close the browser socket with this code.
    Close(u16, &'static str),
    /// The browser socket is already gone.
    Gone,
}

const HUB_LOST: End = End::Close(close::HUB_LOST, "hub connection lost");

async fn run(app: AppState, mut ws: WebSocket) {
    let status = app.hub.status.borrow().clone();
    let reason = match status {
        HubStatus::Up { .. } => None,
        HubStatus::Down => Some("hub unavailable"),
        HubStatus::Incompatible { .. } => Some("hub incompatible"),
    };
    if let Some(reason) = reason {
        return ws_close(ws, ROUTE, close::HUB_UNAVAILABLE, reason).await;
    }
    let hub = match HubConn::connect(&app.cfg.hub_socket).await {
        Ok((hub, _)) => hub,
        Err(_) => return ws_close(ws, ROUTE, close::HUB_UNAVAILABLE, "hub unavailable").await,
    };
    let stop = app.stopped();
    tokio::pin!(stop);
    let mut relay = Relay {
        shell: app.cfg.shell.clone(),
        hub,
        next_rid: 0,
        cur: None,
        pending: None,
        superseded: HashMap::new(),
    };
    let mut open_by = Some(Instant::now() + CARD_OPEN_DEADLINE);
    let mut keepalive = Keepalive::new();
    let end = loop {
        let reply_by = relay.pending.as_ref().map(|p| p.2);
        let step = tokio::select! {
            msg = ws.recv() => match msg {
                None | Some(Ok(Message::Close(_))) => Err(End::Gone),
                Some(Err(_)) => return ws_too_big(ws, ROUTE).await,
                Some(Ok(msg)) => {
                    keepalive.seen();
                    match msg {
                        Message::Text(text) => relay.browser(&mut ws, text.as_str(), &mut open_by).await,
                        _ => Ok(()),
                    }
                }
            },
            msg = relay.hub.recv() => match msg {
                Some(msg) => relay.hub_msg(&mut ws, msg).await,
                None => Err(HUB_LOST),
            },
            () = sleep_until(open_by.unwrap_or_else(Instant::now)), if open_by.is_some() => {
                Err(End::Close(close::POLICY, "no open in time"))
            }
            () = sleep_until(reply_by.unwrap_or_else(Instant::now)), if reply_by.is_some() => {
                Err(End::Close(close::HUB_LOST, "the hub did not answer open"))
            }
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

struct Relay {
    shell: String,
    hub: HubConn,
    next_rid: u64,
    /// The attached sid; only its events reach the browser.
    cur: Option<String>,
    /// The latest open waiting for its reply: rid, sid, deadline.
    pending: Option<(u64, String, Instant)>,
    /// Opens replaced by a later open before their reply; each is detached once its
    /// `ok` arrives, unless a later open is for the same sid.
    superseded: HashMap<u64, String>,
}

impl Relay {
    fn rid(&mut self) -> u64 {
        self.next_rid += 1;
        self.next_rid
    }

    async fn send(&mut self, req: &HubRequest) -> Result<(), End> {
        self.hub.send(req).await.map_err(|_| HUB_LOST)
    }

    async fn browser(
        &mut self,
        ws: &mut WebSocket,
        text: &str,
        open_by: &mut Option<Instant>,
    ) -> Result<(), End> {
        // Non-JSON frames and unknown types are ignored, as in the prototype.
        let Ok(Value::Object(m)) = serde_json::from_str(text) else {
            return Ok(());
        };
        match m.get("t").and_then(Value::as_str) {
            Some("open") => {
                *open_by = None;
                self.open(ws, &m).await
            }
            Some("in") => {
                let (Some(sid), Some(d)) = (self.cur.clone(), m.get("d").and_then(Value::as_str))
                else {
                    return Ok(());
                };
                for piece in split_utf8(d, PTY_INPUT_FRAME) {
                    let input = HubRequest::PtyInput {
                        sid: sid.clone(),
                        d: piece.to_owned(),
                    };
                    self.send(&input).await?;
                }
                Ok(())
            }
            Some("resize") => {
                let (Some(sid), Some(cols), Some(rows)) =
                    (self.cur.clone(), dim(&m, "cols"), dim(&m, "rows"))
                else {
                    return Ok(());
                };
                self.send(&HubRequest::PtyResize { sid, cols, rows }).await
            }
            Some("kill") => {
                let Some(sid) = self.cur.clone() else {
                    return Ok(());
                };
                let rid = self.rid();
                // `session` absent (undefined in the browser) means forget.
                let forget = !m.contains_key("session");
                self.send(&HubRequest::PtyKill { rid, sid, forget }).await
            }
            _ => Ok(()),
        }
    }

    async fn open(&mut self, ws: &mut WebSocket, m: &Map<String, Value>) -> Result<(), End> {
        let sid = sanitize_sid(text(m, "id"));
        if sid.is_empty() {
            send_json(ws, &json!({"t": "error", "error": "bad id"}))
                .await
                .map_err(|_| End::Gone)?;
            return Err(End::Close(close::POLICY, "bad id"));
        }
        if let Some(old) = self.cur.take() {
            let rid = self.rid();
            self.send(&HubRequest::PtyDetach { rid, sid: old }).await?;
        }
        if let Some((rid, old, _)) = self.pending.take() {
            self.superseded.insert(rid, old);
        }
        let rid = self.rid();
        tracing::info!(sid, "pty open");
        let req = HubRequest::PtyOpen {
            rid,
            sid: sid.clone(),
            cols: dim(m, "cols").unwrap_or(80),
            rows: dim(m, "rows").unwrap_or(24),
            spawn: spawn_requested(m).then(|| self.spawn(m)),
            resume: m
                .get("resume")
                .and_then(|r| serde_json::from_value::<Resume>(r.clone()).ok()),
        };
        self.send(&req).await?;
        self.pending = Some((rid, sid, Instant::now() + REPLY_TIMEOUT));
        Ok(())
    }

    fn spawn(&self, m: &Map<String, Value>) -> SpawnPty {
        let cmd = text(m, "cmd");
        let argv = if cmd.is_empty() {
            vec![self.shell.clone()]
        } else {
            vec![self.shell.clone(), "-c".into(), cmd.into()]
        };
        let cwd = Some(text(m, "cwd"))
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        let cwd_from = Some(sanitize_sid(text(m, "parent"))).filter(|p| !p.is_empty());
        // Only string values; the hub validates keys, sizes and counts.
        let env: BTreeMap<String, String> = m
            .get("env")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
            .collect();
        SpawnPty {
            argv,
            shell: None,
            cwd,
            cwd_from,
            env: (!env.is_empty()).then_some(env),
        }
    }

    fn is_cur(&self, sid: &str) -> bool {
        self.cur.as_deref() == Some(sid)
    }

    async fn hub_msg(&mut self, ws: &mut WebSocket, msg: HubMessage) -> Result<(), End> {
        let out = match msg {
            HubMessage::Ok { rid, result } => {
                if let Some((_, sid, _)) = self.pending.take_if(|p| p.0 == rid) {
                    let reply: PtyOpenReply = serde_json::from_value(Value::Object(result))
                        .map_err(|_| End::Close(close::HUB_LOST, "bad hub reply"))?;
                    return self.opened(ws, sid, reply).await;
                }
                if let Some(sid) = self.superseded.remove(&rid) {
                    // A later open of the same sid keeps it attached; detaching would undo it.
                    let reopened = self.pending.as_ref().is_some_and(|p| p.1 == sid);
                    if !reopened && !self.is_cur(&sid) {
                        let rid = self.rid();
                        self.send(&HubRequest::PtyDetach { rid, sid }).await?;
                    }
                }
                return Ok(());
            }
            HubMessage::Err {
                rid: Some(rid),
                code,
                message,
                ..
            } => {
                self.superseded.remove(&rid);
                if self.pending.take_if(|p| p.0 == rid).is_none() {
                    tracing::debug!(?code, message, "hub refused a request");
                    return Ok(());
                }
                // The socket stays open: Enter on the card sends a new open.
                json!({"t": "error", "error": message, "code": code})
            }
            HubMessage::Err {
                rid: None,
                sid,
                code,
                message,
            } => {
                if code == ErrorCode::InputOverflow
                    && sid.as_deref().is_some_and(|s| self.is_cur(s))
                {
                    json!({"t": "out", "d": OVERFLOW_NOTICE})
                } else {
                    tracing::warn!(?code, message, "hub error");
                    return Ok(());
                }
            }
            HubMessage::PtyOut { sid, d, out } if self.is_cur(&sid) => {
                json!({"t": "out", "d": d, "out": out})
            }
            HubMessage::PtyFg { sid, comm, cwd } if self.is_cur(&sid) => {
                json!({"t": "fg", "comm": comm, "cwd": cwd})
            }
            HubMessage::PtyExit {
                sid,
                code,
                signal,
                reason,
            } if self.is_cur(&sid) => {
                json!({"t": "exit", "code": code, "signal": signal, "reason": reason})
            }
            HubMessage::Gone { sid, epoch } if self.is_cur(&sid) => {
                send_json(ws, &json!({"t": "gone", "epoch": epoch}))
                    .await
                    .map_err(|_| End::Gone)?;
                return Err(End::Close(close::FINAL, "session gone"));
            }
            // Events for an earlier sid can race a detach; they are dropped.
            _ => return Ok(()),
        };
        send_json(ws, &out).await.map_err(|_| End::Gone)
    }

    async fn opened(
        &mut self,
        ws: &mut WebSocket,
        sid: String,
        reply: PtyOpenReply,
    ) -> Result<(), End> {
        let mut hello = json!({
            "t": "hello",
            "new": reply.new,
            "resumed": reply.resumed,
            "stream": reply.stream,
            "out": reply.out,
            "epoch": reply.epoch,
            "cwd": reply.cwd,
        });
        if let Some(replay) = reply.replay {
            hello["replay"] = replay.into();
        }
        send_json(ws, &hello).await.map_err(|_| End::Gone)?;
        if let Some(exit) = reply.exit {
            let exit = json!({"t": "exit", "code": exit.code, "signal": exit.signal, "reason": exit.reason});
            send_json(ws, &exit).await.map_err(|_| End::Gone)?;
        }
        self.cur = Some(sid);
        Ok(())
    }
}

/// M0 only: the unchanged frontend sends no `spawn`, so an absent flag spawns. From M1
/// on an absent flag means attach only (SEC-2).
fn spawn_requested(m: &Map<String, Value>) -> bool {
    m.get("spawn").is_none_or(|s| *s == Value::Bool(true))
}

fn text<'a>(m: &'a Map<String, Value>, key: &str) -> &'a str {
    m.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// A terminal dimension: any JSON number, saturated into `u32`; the hub clamps it.
fn dim(m: &Map<String, Value>, key: &str) -> Option<u32> {
    m.get(key).and_then(Value::as_f64).map(|n| n as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(v: Value) -> Map<String, Value> {
        let Value::Object(m) = v else { panic!() };
        m
    }

    #[test]
    fn absent_spawn_spawns_in_m0_and_anything_but_true_does_not() {
        assert!(spawn_requested(&obj(json!({"t": "open"}))));
        assert!(spawn_requested(&obj(json!({"spawn": true}))));
        for v in [json!(false), json!(null), json!("true"), json!(1)] {
            assert!(!spawn_requested(&obj(json!({"spawn": v}))), "{v}");
        }
    }

    #[test]
    fn dims_saturate() {
        let m = obj(json!({"a": 80, "b": -3, "c": 1e12, "d": "80", "e": 100.7}));
        assert_eq!(dim(&m, "a"), Some(80));
        assert_eq!(dim(&m, "b"), Some(0));
        assert_eq!(dim(&m, "c"), Some(u32::MAX));
        assert_eq!(dim(&m, "d"), None);
        assert_eq!(dim(&m, "e"), Some(100));
        assert_eq!(dim(&m, "missing"), None);
    }
}
