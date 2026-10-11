//! `/acp` (design §3.5.2, W-3): one browser socket per agent card, relayed to a hub
//! connection of its own. The first message names the session; every later one maps
//! onto one `acp.*` request for it.

use std::collections::HashMap;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::{Instant, sleep_until};
use wb_proto::hub::{
    AcpOpenReply, AcpSessionInfo, ErrorCode, HubMessage, HubRequest, SpawnAcp, Summary,
};
use wb_proto::journal::EventBody;
use wb_proto::limits::{CARD_OPEN_DEADLINE, MAX_LINE, WS_MAX_ACP};
use wb_proto::line;

use crate::AppState;
use crate::http::{Keepalive, Tick, close, send_json, upgrade_required, ws_close, ws_too_big};
use crate::hub::{HubConn, HubStatus, REPLY_TIMEOUT, with_state};
use crate::util::sanitize_sid;

const ROUTE: &str = "/acp";

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
    ws.max_message_size(WS_MAX_ACP)
        .max_frame_size(WS_MAX_ACP)
        .on_upgrade(move |socket| async move {
            run(app, socket).await;
            drop(running);
        })
}

/// A browser message (§3.5.2), without its optional `rid`.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
enum Browser {
    #[serde(rename = "open")]
    Open {
        id: String,
        since: u64,
        epoch: Option<u64>,
        agent: Option<String>,
        cwd: Option<String>,
    },
    #[serde(rename = "prompt")]
    Prompt { blocks: Vec<Value> },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "permission")]
    Permission {
        req: u64,
        epoch: u64,
        outcome: Value,
    },
    #[serde(rename = "elicitation")]
    Elicitation {
        req: u64,
        epoch: u64,
        response: Value,
    },
    #[serde(rename = "set_mode")]
    SetMode { mode_id: String },
    #[serde(rename = "seen")]
    Seen { seq: u64 },
    #[serde(rename = "revive")]
    Revive,
    #[serde(rename = "authenticate")]
    Authenticate { method_id: String },
    #[serde(rename = "kill")]
    Kill { forget: bool },
}

/// Splits a browser frame into its `rid` (any non-null JSON value, echoed verbatim on
/// `error`) and the message. `Err` carries the rid of a frame that does not decode.
fn decode(text: &str) -> Result<(Option<Value>, Browser), Option<Value>> {
    let Ok(Value::Object(mut m)) = serde_json::from_str::<Value>(text) else {
        return Err(None);
    };
    let rid = m.remove("rid").filter(|r| !r.is_null());
    match serde_json::from_value(Value::Object(m)) {
        Ok(msg) => Ok((rid, msg)),
        Err(_) => Err(rid),
    }
}

/// Spawn fields only when both `agent` and `cwd` are non-empty (SEC-2): a page load or
/// a reconnect sends neither and must never start an agent.
fn spawn(agent: Option<String>, cwd: Option<String>) -> Option<SpawnAcp> {
    match (agent, cwd) {
        (Some(agent), Some(cwd)) if !agent.is_empty() && !cwd.is_empty() => {
            Some(SpawnAcp { agent, cwd })
        }
        _ => None,
    }
}

/// `AcpInfo` = Summary + `{state, session?}`. `session` is left out when it equals
/// `last`, the one this socket sent last (ROB-16); otherwise it becomes `last`.
fn info(summary: &Summary, session: AcpSessionInfo, last: &mut Option<AcpSessionInfo>) -> Value {
    let mut info = with_state(summary);
    if last.as_ref() != Some(&session) {
        info["session"] = json!(session);
        *last = Some(session);
    }
    info
}

/// `{t:"error", error, code, rid?}`.
fn error(message: &str, code: ErrorCode, rid: Option<Value>) -> Value {
    let mut e = json!({"t": "error", "error": message, "code": code});
    if let Some(rid) = rid {
        e["rid"] = rid;
    }
    e
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
        HubStatus::Up(_) => None,
        HubStatus::Down => Some("hub unavailable"),
        HubStatus::Incompatible { .. } => Some("hub incompatible"),
    };
    if let Some(reason) = reason {
        return ws_close(ws, ROUTE, close::HUB_UNAVAILABLE, reason).await;
    }
    let Ok((hub, _)) = HubConn::connect(&app.cfg.hub_socket).await else {
        return ws_close(ws, ROUTE, close::HUB_UNAVAILABLE, "hub unavailable").await;
    };
    let stop = app.stopped();
    tokio::pin!(stop);
    let mut relay = Relay {
        hub,
        next_rid: 0,
        sid: None,
        replies: HashMap::new(),
        deadline: Some(Instant::now() + CARD_OPEN_DEADLINE),
        session: None,
    };
    let mut keepalive = Keepalive::new();
    let end = loop {
        let deadline = relay.deadline;
        let step = tokio::select! {
            msg = ws.recv() => match msg {
                None | Some(Ok(Message::Close(_))) => Err(End::Gone),
                Some(Err(_)) => return ws_too_big(ws, ROUTE).await,
                Some(Ok(msg)) => {
                    keepalive.seen();
                    match msg {
                        Message::Text(text) => relay.browser(&mut ws, text.as_str()).await,
                        _ => Ok(()),
                    }
                }
            },
            msg = relay.hub.recv() => match msg {
                Some(msg) => relay.hub_msg(&mut ws, msg).await,
                None => Err(HUB_LOST),
            },
            () = sleep_until(deadline.unwrap_or_else(Instant::now)), if deadline.is_some() => {
                match relay.sid {
                    None => Err(End::Close(close::POLICY, "no open in time")),
                    Some(_) => Err(End::Close(close::HUB_LOST, "the hub did not answer open")),
                }
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

/// What a hub reply means to this socket.
enum Pending {
    /// The `acp.open`: its `ok` becomes `hello`, its `err` ends the socket.
    Open,
    /// An `acp.kill{forget:true}`: its `ok` ends the socket.
    Forget,
    /// Any other request: only an `err` reaches the browser.
    Command,
}

struct Relay {
    hub: HubConn,
    next_rid: u64,
    /// The session named by `open`, from the moment the open is sent; only its events
    /// reach the browser.
    sid: Option<String>,
    /// Requests waiting for their reply, by hub rid, with the browser's rid.
    replies: HashMap<u64, (Pending, Option<Value>)>,
    /// When the browser must have sent `open` (`CARD_OPEN_DEADLINE`), then when the
    /// hub must have answered it (`REPLY_TIMEOUT`).
    deadline: Option<Instant>,
    /// The session info this socket sent last.
    session: Option<AcpSessionInfo>,
}

impl Relay {
    fn rid(&mut self) -> u64 {
        self.next_rid += 1;
        self.next_rid
    }

    async fn send(&mut self, req: &HubRequest) -> Result<(), End> {
        self.hub.send(req).await.map_err(|_| HUB_LOST)
    }

    async fn browser(&mut self, ws: &mut WebSocket, text: &str) -> Result<(), End> {
        let (browser_rid, msg) = match decode(text) {
            Ok(decoded) => decoded,
            Err(rid) => {
                let e = error("malformed message", ErrorCode::BadRequest, rid);
                send_json(ws, &e).await.map_err(|_| End::Gone)?;
                // Before the open nothing can be relayed, so the socket is useless.
                return match self.sid {
                    None => Err(End::Close(close::POLICY, "malformed open")),
                    Some(_) => Ok(()),
                };
            }
        };
        let Some(sid) = self.sid.clone() else {
            return match msg {
                Browser::Open {
                    id,
                    since,
                    epoch,
                    agent,
                    cwd,
                } => {
                    let spawn = spawn(agent, cwd);
                    self.open(ws, &id, since, epoch, spawn, browser_rid).await
                }
                _ => {
                    let e = error("open must come first", ErrorCode::BadRequest, browser_rid);
                    send_json(ws, &e).await.map_err(|_| End::Gone)?;
                    Err(End::Close(close::POLICY, "open must come first"))
                }
            };
        };
        let rid = self.rid();
        let mut pending = Pending::Command;
        let req = match msg {
            Browser::Open { .. } => {
                let e = error("open was already sent", ErrorCode::BadRequest, browser_rid);
                return send_json(ws, &e).await.map_err(|_| End::Gone);
            }
            Browser::Prompt { blocks } => HubRequest::AcpPrompt {
                rid,
                sid,
                prompt: blocks,
            },
            Browser::Cancel => HubRequest::AcpCancel { rid, sid },
            Browser::Permission {
                req,
                epoch,
                outcome,
            } => HubRequest::AcpPermission {
                rid,
                sid,
                req,
                epoch,
                outcome,
            },
            Browser::Elicitation {
                req,
                epoch,
                response,
            } => HubRequest::AcpElicitation {
                rid,
                sid,
                req,
                epoch,
                response,
            },
            Browser::SetMode { mode_id } => HubRequest::AcpSetMode { rid, sid, mode_id },
            Browser::Seen { seq } => HubRequest::AcpSeen { rid, sid, seq },
            Browser::Revive => HubRequest::AcpRevive { rid, sid },
            Browser::Authenticate { method_id } => HubRequest::AcpAuthenticate {
                rid,
                sid,
                method_id,
            },
            Browser::Kill { forget } => {
                if forget {
                    pending = Pending::Forget;
                }
                HubRequest::AcpKill { rid, sid, forget }
            }
        };
        // Re-serialising can grow a browser value (`1e15` comes out as
        // `1000000000000000.0`), so the line is measured: one longer than the hub reads
        // (MAX_LINE, its `\n` aside) is refused here rather than ending the connection.
        let encoded = line::encode(&req);
        if encoded.len() > MAX_LINE + 1 {
            let e = error("message too large", ErrorCode::BadRequest, browser_rid);
            return send_json(ws, &e).await.map_err(|_| End::Gone);
        }
        self.hub.send_line(&encoded).await.map_err(|_| HUB_LOST)?;
        self.replies.insert(rid, (pending, browser_rid));
        Ok(())
    }

    async fn open(
        &mut self,
        ws: &mut WebSocket,
        id: &str,
        since: u64,
        epoch: Option<u64>,
        spawn: Option<SpawnAcp>,
        browser_rid: Option<Value>,
    ) -> Result<(), End> {
        let sid = sanitize_sid(id);
        if sid.is_empty() {
            let e = error("bad id", ErrorCode::BadRequest, browser_rid);
            send_json(ws, &e).await.map_err(|_| End::Gone)?;
            return Err(End::Close(close::POLICY, "bad id"));
        }
        let rid = self.rid();
        tracing::info!(sid, spawn = spawn.is_some(), "acp open");
        let req = HubRequest::AcpOpen {
            rid,
            sid: sid.clone(),
            since,
            epoch,
            spawn,
        };
        self.send(&req).await?;
        self.replies.insert(rid, (Pending::Open, browser_rid));
        self.deadline = Some(Instant::now() + REPLY_TIMEOUT);
        self.sid = Some(sid);
        Ok(())
    }

    fn is_ours(&self, sid: &str) -> bool {
        self.sid.as_deref() == Some(sid)
    }

    async fn hub_msg(&mut self, ws: &mut WebSocket, msg: HubMessage) -> Result<(), End> {
        let out = match msg {
            HubMessage::Ok { rid, result } => match self.replies.remove(&rid) {
                Some((Pending::Open, _)) => {
                    self.deadline = None;
                    let reply: AcpOpenReply = serde_json::from_value(Value::Object(result))
                        .map_err(|_| End::Close(close::HUB_LOST, "bad hub reply"))?;
                    self.hello(reply)
                }
                // The hub replies only after the session is deleted, so the card may
                // open a new one at once (H-3).
                Some((Pending::Forget, _)) => {
                    return Err(End::Close(close::FINAL, "session forgotten"));
                }
                Some((Pending::Command, _)) | None => return Ok(()),
            },
            HubMessage::Err {
                rid: Some(rid),
                code,
                message,
                ..
            } => {
                let Some((pending, browser_rid)) = self.replies.remove(&rid) else {
                    return Ok(());
                };
                send_json(ws, &error(&message, code, browser_rid))
                    .await
                    .map_err(|_| End::Gone)?;
                if let Pending::Open = pending {
                    // Final: the card shows the error and does not reconnect (ROB-18).
                    return Err(End::Close(close::FINAL, "open failed"));
                }
                return Ok(());
            }
            HubMessage::Err {
                rid: None,
                sid,
                code,
                message,
            } => {
                if !sid.as_deref().is_some_and(|s| self.is_ours(s)) {
                    tracing::warn!(?code, message, "hub error");
                    return Ok(());
                }
                // "session reloaded": the hub dropped the attachment, so the card
                // reconnects and opens again from its cursor, as `/pty` does.
                if code == ErrorCode::Internal {
                    return Err(End::Close(close::HUB_LOST, "session reloaded"));
                }
                error(&message, code, None)
            }
            HubMessage::AcpEv { sid, ev } if self.is_ours(&sid) => {
                // An unknown kind decodes without its payload; the browser skips
                // unknown kinds anyway, and the cursor allows the gap.
                if ev.body == EventBody::Unknown {
                    tracing::warn!(seq = ev.seq, "unknown journal event not relayed");
                    return Ok(());
                }
                json!({"t": "ev", "ev": ev})
            }
            HubMessage::AcpReplayed {
                sid,
                head,
                truncated,
            } if self.is_ours(&sid) => {
                json!({"t": "replayed", "head": head, "truncated": truncated})
            }
            HubMessage::AcpInfo {
                sid,
                summary,
                session,
            } if self.is_ours(&sid) => {
                json!({"t": "info", "info": info(&summary, *session, &mut self.session)})
            }
            HubMessage::Gone { sid, epoch } if self.is_ours(&sid) => {
                send_json(ws, &json!({"t": "gone", "epoch": epoch}))
                    .await
                    .map_err(|_| End::Gone)?;
                return Err(End::Close(close::FINAL, "session gone"));
            }
            _ => return Ok(()),
        };
        send_json(ws, &out).await.map_err(|_| End::Gone)
    }

    fn hello(&mut self, reply: AcpOpenReply) -> Value {
        json!({
            "t": "hello",
            "status": if reply.new { "new" } else { "attached" },
            "info": info(&reply.summary, reply.session, &mut self.session),
            "head": reply.head,
            "from": reply.from,
            "reset": reply.reset,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wb_proto::hub::{AcpFacts, Activity, Kind};

    #[test]
    fn spawn_needs_both_agent_and_cwd() {
        let s = |v: Option<&str>| v.map(str::to_owned);
        let table = [
            (None, None, false),
            (Some("claude"), None, false),
            (None, Some("/home/alice"), false),
            (Some(""), Some("/home/alice"), false),
            (Some("claude"), Some(""), false),
            (Some("claude"), Some("/home/alice"), true),
        ];
        for (agent, cwd, want) in table {
            assert_eq!(spawn(s(agent), s(cwd)).is_some(), want, "{agent:?} {cwd:?}");
        }
        assert_eq!(
            spawn(s(Some("claude")), s(Some("/home/alice"))),
            Some(SpawnAcp {
                agent: "claude".into(),
                cwd: "/home/alice".into()
            })
        );
    }

    #[test]
    fn decode_takes_the_rid_out_and_checks_each_field() {
        let open = json!({"t": "open", "id": "a1", "since": 7, "rid": 3}).to_string();
        assert_eq!(
            decode(&open),
            Ok((
                Some(json!(3)),
                Browser::Open {
                    id: "a1".into(),
                    since: 7,
                    epoch: None,
                    agent: None,
                    cwd: None
                }
            ))
        );
        // Unit messages tolerate other fields.
        let cancel = json!({"t": "cancel", "x": 1}).to_string();
        assert_eq!(decode(&cancel), Ok((None, Browser::Cancel)));
        let mode = json!({"t": "set_mode", "modeId": "plan", "rid": null}).to_string();
        assert_eq!(
            decode(&mode),
            Ok((
                None,
                Browser::SetMode {
                    mode_id: "plan".into()
                }
            ))
        );
        for (bad, rid) in [
            (
                json!({"t": "prompt", "blocks": "hi", "rid": 4}),
                Some(json!(4)),
            ),
            (json!({"t": "permission", "req": 2, "outcome": {}}), None),
            (json!({"t": "kill"}), None),
            (json!({"t": "open", "id": "a1", "since": -1}), None),
            (
                json!({"t": "open", "id": "a1", "since": 0, "agent": 5}),
                None,
            ),
            (json!({"t": "nope", "rid": "x"}), Some(json!("x"))),
            (json!([1]), None),
        ] {
            assert_eq!(decode(&bad.to_string()), Err(rid), "{bad}");
        }
        assert_eq!(decode("not json"), Err(None));
    }

    fn summary(head_seq: u64) -> Summary {
        Summary {
            sid: "a1".into(),
            kind: Kind::Acp,
            host: "testhost".into(),
            created_at: 1,
            updated_at: 2,
            alive: true,
            viewers: 1,
            cwd: "/home/alice".into(),
            fault: None,
            pty: None,
            acp: Some(AcpFacts {
                agent: "claude".into(),
                agent_session_id: None,
                revivable: false,
                activity: Activity::None,
                pending: Vec::new(),
                last: None,
                head_seq,
                seen_seq: 0,
                title: None,
                mode_id: None,
            }),
        }
    }

    #[test]
    fn info_leaves_out_a_session_it_already_sent() {
        let mut last = None;
        let first = AcpSessionInfo {
            protocol_version: Some(1),
            ..AcpSessionInfo::default()
        };
        let v = info(&summary(1), first.clone(), &mut last);
        assert_eq!(v["state"], "idle");
        assert_eq!(v["session"]["protocolVersion"], 1);
        assert_eq!(v["session"]["plan"], Value::Null);
        let v = info(&summary(2), first.clone(), &mut last);
        assert_eq!(v["acp"]["headSeq"], 2);
        assert!(v.get("session").is_none(), "{v}");
        let second = AcpSessionInfo {
            plan: Some(json!({"entries": []})),
            ..first
        };
        let v = info(&summary(3), second.clone(), &mut last);
        assert_eq!(v["session"]["plan"], json!({"entries": []}));
        assert_eq!(last, Some(second));
    }
}
