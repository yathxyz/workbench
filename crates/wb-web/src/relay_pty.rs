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
use tokio::time::{Instant, sleep_until, timeout_at};
use wb_proto::hub::{ErrorCode, HubMessage, HubRequest, PtyOpenReply, Resume, SpawnPty};
use wb_proto::limits::{CARD_OPEN_DEADLINE, PTY_INPUT_FRAME, WS_MAX_PTY};

use crate::AppState;
use crate::http::{self, End, Keepalive, Tick, close, send_json, ws_close, ws_too_big};
use crate::hub::{HUB_LOST, HubConn, REPLY_TIMEOUT, connect_relay};
use crate::observed::Registry;
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
    http::upgrade(app, ws, WS_MAX_PTY, run)
}

async fn run(app: AppState, mut ws: WebSocket) {
    let (hub, info) = match connect_relay(&app).await {
        Ok(conn) => conn,
        Err(reason) => return ws_close(ws, ROUTE, close::HUB_UNAVAILABLE, reason).await,
    };
    let stop = app.stopped();
    tokio::pin!(stop);
    let mut relay = Relay {
        default_shell: info.default_shell,
        hub,
        next_rid: 0,
        cur: None,
        pending: None,
        superseded: HashMap::new(),
    };
    let mut open_by = Some(Instant::now() + CARD_OPEN_DEADLINE);
    let mut keepalive = Keepalive::new();
    let mut read_error = false;
    let end = loop {
        let reply_by = relay
            .pending
            .iter()
            .chain(relay.superseded.values().filter(|p| p.kill.is_some()))
            .map(|p| p.deadline)
            .min();
        let step = tokio::select! {
            msg = ws.recv() => match msg {
                None | Some(Ok(Message::Close(_))) => Err(End::Gone),
                Some(Err(_)) => {
                    read_error = true;
                    Err(End::Gone)
                }
                Some(Ok(msg)) => {
                    keepalive.seen();
                    match msg {
                        Message::Text(text) => relay.browser(&app, &mut ws, text.as_str(), &mut open_by).await,
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
    // Dropping HubConn only detaches: retain it until an explicitly cancelled open
    // has answered, even when the browser has already closed.
    let (_, cleanup) = tokio::join!(
        async {
            if read_error {
                ws_too_big(ws, ROUTE).await;
            } else {
                end.close(ws, ROUTE).await;
            }
        },
        relay.finish_kills(),
    );
    if cleanup.is_err() {
        tracing::warn!("hub lost while cleaning up a pending pty kill");
    }
}

struct Relay {
    /// From this connection's hello; names the shell in `argv[0]` when the browser
    /// names none.
    default_shell: String,
    hub: HubConn,
    next_rid: u64,
    /// The attached sid; only its events reach the browser.
    cur: Option<String>,
    /// The latest open waiting for its reply.
    pending: Option<PendingOpen>,
    /// Opens replaced by a later open before their reply; each is detached (or
    /// killed if requested) once its `ok` arrives, unless a later open is for the same sid.
    superseded: HashMap<u64, PendingOpen>,
}

struct PendingOpen {
    rid: u64,
    sid: String,
    deadline: Instant,
    /// `Some(forget)` remembers a kill received before this open answered.
    kill: Option<bool>,
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
        app: &AppState,
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
                self.open(app, ws, &m).await
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
                // `session` absent (undefined in the browser) means forget.
                let forget = !m.contains_key("session");
                if let Some(open) = &mut self.pending {
                    open.kill = Some(open.kill.unwrap_or(false) || forget);
                    return Ok(());
                }
                let Some(sid) = self.cur.clone() else {
                    return Ok(());
                };
                let rid = self.rid();
                self.send(&HubRequest::PtyKill {
                    rid,
                    sid,
                    epoch: None,
                    forget,
                })
                .await
            }
            _ => Ok(()),
        }
    }

    async fn open(
        &mut self,
        app: &AppState,
        ws: &mut WebSocket,
        m: &Map<String, Value>,
    ) -> Result<(), End> {
        let sid = sanitize_sid(text(m, "id"));
        if sid.is_empty() {
            send_json(ws, &json!({"t": "error", "error": "bad id"}))
                .await
                .map_err(|_| End::Gone)?;
            return Err(End::Close(close::POLICY, "bad id"));
        }
        let spawn = if spawn_requested(m) {
            match self.spawn(app, m) {
                Ok(spawn) => Some(spawn),
                Err(error) => {
                    send_json(ws, &json!({"t": "error", "error": error}))
                        .await
                        .map_err(|_| End::Gone)?;
                    return Ok(());
                }
            }
        } else {
            None
        };
        if let Some(old) = self.cur.take() {
            let rid = self.rid();
            self.send(&HubRequest::PtyDetach { rid, sid: old }).await?;
        }
        if let Some(old) = self.pending.take() {
            self.superseded.insert(old.rid, old);
        }
        let rid = self.rid();
        tracing::info!(sid, "pty open");
        let req = HubRequest::PtyOpen {
            rid,
            sid: sid.clone(),
            cols: dim(m, "cols").unwrap_or(80),
            rows: dim(m, "rows").unwrap_or(24),
            spawn,
            resume: m
                .get("resume")
                .and_then(|r| serde_json::from_value::<Resume>(r.clone()).ok()),
        };
        self.send(&req).await?;
        self.pending = Some(PendingOpen {
            rid,
            sid,
            deadline: Instant::now() + REPLY_TIMEOUT,
            kill: None,
        });
        Ok(())
    }

    /// The hub runs one of its configured shells, never a path from here, and puts
    /// that shell's path in `argv[0]`; the web sends the name there (DELTA-1 §B.2).
    fn spawn(&self, app: &AppState, m: &Map<String, Value>) -> Result<SpawnPty, &'static str> {
        let attach = m.get("attach");
        let shell = if attach.is_some() {
            None
        } else {
            Some(text(m, "shell")).filter(|s| !s.is_empty())
        };
        let name = shell.unwrap_or(&self.default_shell).to_owned();
        let command = if let Some(attach) = attach {
            if m.contains_key("cmd") {
                return Err("attach and cmd are mutually exclusive");
            }
            let id = attach
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("bad attach id")?;
            Some(attach_command(
                app.cfg.attach_command.as_deref(),
                app.observed.as_ref().map(|o| &o.registry),
                id,
            )?)
        } else {
            None
        };
        let cmd = command.as_deref().unwrap_or_else(|| text(m, "cmd"));
        let argv = if cmd.is_empty() {
            vec![name]
        } else {
            vec![name, "-c".into(), cmd.into()]
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
        Ok(SpawnPty {
            argv,
            shell: shell.map(str::to_owned),
            cwd,
            cwd_from,
            env: (!env.is_empty()).then_some(env),
        })
    }

    fn is_cur(&self, sid: &str) -> bool {
        self.cur.as_deref() == Some(sid)
    }

    async fn hub_msg(&mut self, ws: &mut WebSocket, msg: HubMessage) -> Result<(), End> {
        let out = match msg {
            HubMessage::Ok { rid, result } => {
                if let Some((sid, reply)) = self.open_ok(rid, result).await? {
                    return self.opened(ws, sid, reply).await;
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
                if self.pending.take_if(|p| p.rid == rid).is_none() {
                    tracing::debug!(?code, message, "hub refused a request");
                    return Ok(());
                }
                let error = json!({"t": "error", "error": message, "code": code});
                send_json(ws, &error).await.map_err(|_| End::Gone)?;
                // Final: the card shows the error, and Enter opens a new socket.
                return Err(End::Close(close::FINAL, "open failed"));
            }
            HubMessage::Err {
                rid: None,
                sid,
                code,
                message,
            } => {
                let cur = sid.as_deref().is_some_and(|s| self.is_cur(s));
                match code {
                    ErrorCode::InputOverflow if cur => json!({"t": "out", "d": OVERFLOW_NOTICE}),
                    // "session reloaded": the hub dropped the attachment, so the browser
                    // reconnects and opens again with `resume`.
                    ErrorCode::Internal if cur => {
                        return Err(End::Close(close::HUB_LOST, "session reloaded"));
                    }
                    _ => {
                        tracing::warn!(?code, message, "hub error");
                        return Ok(());
                    }
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

    /// Resolve the open before writing its hello: a failed browser write must not
    /// lose the kill that was requested while the hub was opening.
    async fn open_ok(
        &mut self,
        rid: u64,
        result: Map<String, Value>,
    ) -> Result<Option<(String, PtyOpenReply)>, End> {
        if let Some(open) = self.pending.take_if(|p| p.rid == rid) {
            let reply: PtyOpenReply = serde_json::from_value(Value::Object(result))
                .map_err(|_| End::Close(close::HUB_LOST, "bad hub reply"))?;
            if let Some(forget) = open.kill {
                let rid = self.rid();
                self.send(&HubRequest::PtyKill {
                    rid,
                    sid: open.sid.clone(),
                    epoch: None,
                    forget,
                })
                .await?;
            }
            return Ok(Some((open.sid, reply)));
        }
        if let Some(open) = self.superseded.remove(&rid) {
            // A later open of the same sid keeps it attached; old cleanup must not
            // detach or kill the session that the newer open is using.
            let reopened = self.pending.as_ref().is_some_and(|p| p.sid == open.sid);
            if !reopened && !self.is_cur(&open.sid) {
                let rid = self.rid();
                let req = match open.kill {
                    Some(forget) => HubRequest::PtyKill {
                        rid,
                        sid: open.sid,
                        epoch: None,
                        forget,
                    },
                    None => HubRequest::PtyDetach { rid, sid: open.sid },
                };
                self.send(&req).await?;
            }
        }
        Ok(None)
    }

    /// No browser remains to receive replies, but its pending kills still own
    /// their opens. Refusals and the original open deadlines end that ownership.
    async fn finish_kills(&mut self) -> Result<(), End> {
        loop {
            let now = Instant::now();
            self.pending
                .take_if(|p| p.kill.is_some() && p.deadline <= now);
            self.superseded
                .retain(|_, p| p.kill.is_none() || p.deadline > now);
            let deadline = self
                .pending
                .iter()
                .chain(self.superseded.values())
                .filter(|p| p.kill.is_some())
                .map(|p| p.deadline)
                .min();
            let Some(deadline) = deadline else {
                return Ok(());
            };
            match timeout_at(deadline, self.hub.recv()).await {
                Ok(Some(HubMessage::Ok { rid, result })) => {
                    if let Some((sid, _)) = self.open_ok(rid, result).await? {
                        self.cur = Some(sid);
                    }
                }
                Ok(Some(HubMessage::Err {
                    rid: Some(rid),
                    code,
                    message,
                    ..
                })) => {
                    self.pending.take_if(|p| p.rid == rid);
                    self.superseded.remove(&rid);
                    tracing::debug!(?code, message, "hub refused a request during pty cleanup");
                }
                Ok(Some(_)) => {}
                Ok(None) => return Err(HUB_LOST),
                Err(_) => tracing::warn!("hub did not answer an open with a pending pty kill"),
            }
        }
    }

    async fn opened(
        &mut self,
        ws: &mut WebSocket,
        sid: String,
        reply: PtyOpenReply,
    ) -> Result<(), End> {
        self.cur = Some(sid);
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
        Ok(())
    }
}

/// The path and address are safe bare shell words; neither is browser-supplied.
fn attach_command(
    command: Option<&str>,
    registry: Option<&Registry>,
    id: &str,
) -> Result<String, &'static str> {
    let command = command.ok_or("terminal attachment is not configured")?;
    if !crate::config::valid_attach_command(command) {
        return Err("invalid attachCommand");
    }
    let session = registry
        .and_then(|registry| registry.get(id))
        .ok_or("unknown observed session")?;
    if session.ended_at.is_some() {
        return Err("observed session has ended");
    }
    let attach = session
        .attach
        .ok_or("observed session has no terminal attachment")?;
    let address = attach
        .address(&session.host)
        .ok_or("invalid terminal attachment address")?;
    Ok(format!("{command} {address}"))
}

/// Only `spawn: true` may start a process; absent means attach only (SEC-2).
fn spawn_requested(m: &Map<String, Value>) -> bool {
    m.get("spawn") == Some(&Value::Bool(true))
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
    fn attach_command_rechecks_config_and_stored_addresses() {
        assert_eq!(
            attach_command(None, None, "o_x"),
            Err("terminal attachment is not configured")
        );
        assert_eq!(
            attach_command(Some("/bin/a;id"), None, "o_x"),
            Err("invalid attachCommand")
        );
        assert_eq!(
            attach_command(Some("/bin/a"), None, "o_x"),
            Err("unknown observed session")
        );
        for (host, attachment) in [
            ("bad_host", json!({"kind": "claude", "id": "deadbeef"})),
            ("devbox", json!({"kind": "claude", "id": "deadbeef;id"})),
            (
                "devbox",
                json!({"kind": "tmux", "socket": "/tmp/a;id", "pane": 0}),
            ),
            (
                "devbox",
                json!({"kind": "tmux", "socket": "/tmp/s", "pane": 1000000}),
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let proc_root = dir.path().join("proc");
            let registry = Registry::load(dir.path(), "local", &proc_root, 1);
            registry
                .ingest(
                    host,
                    json!({
                        "harness": "pi", "payload": {"session_id": "s", "kind": "start"},
                        "attach": {"kind": "claude", "id": "deadbeef"}
                    }),
                    1,
                )
                .unwrap();
            let id = registry.list()[0].id.clone();
            registry.save().unwrap();
            let path = dir.path().join("observed.json");
            let mut stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            stored["sessions"][0]["attach"] = attachment;
            std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
            let registry = Registry::load(dir.path(), "local", &proc_root, 2);
            assert_eq!(
                attach_command(Some("/bin/a"), Some(&registry), &id),
                Err("invalid terminal attachment address"),
                "{host}"
            );
        }
    }

    #[test]
    fn only_spawn_true_spawns() {
        assert!(!spawn_requested(&obj(json!({"t": "open"}))));
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
