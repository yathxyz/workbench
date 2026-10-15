//! `/rpc` (design §3.5.3), the feed so far: `hub{…}`, `board{etag}` and `sessions{…}` on
//! connect, `hub{…}` and `sessions{…}` whenever the hub comes up, then `session`, `gone`,
//! `board{etag}` and `notes{gen}` as they happen. Client messages are read for the cap
//! and the keepalive; `sample`, `tool_result`, `tool_error`, `cancel` and `limits` go
//! through [`crate::sample`], `active` and `cmd_result` go to [`Pages`], and the rest
//! are ignored.
//!
//! [`Pages`] is the leader policy (design §3.3, W-4): a `wb` command from `web.sock`
//! goes to one page as `cmd{id, tool, input}`, and only that page's `cmd_result` with
//! the same `id` answers it.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use serde_json::{Map, Value, json};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, oneshot};
use wb_proto::limits::WS_MAX_RPC;

use crate::board;
use crate::edit_client::Delivery;
use crate::http::{Keepalive, Tick, close, send_json, upgrade_required, ws_close, ws_too_big};
use crate::hub::{HubStatus, with_state};
use crate::sample::Tab;
use crate::{AppState, FeedMsg};

const ROUTE: &str = "/rpc";

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
    ws.max_message_size(WS_MAX_RPC)
        .max_frame_size(WS_MAX_RPC)
        .on_upgrade(move |socket| async move {
            run(app, socket).await;
            drop(running);
        })
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

/// What a client gets on connect and after it lagged: [`snapshot`] with the board's tag
/// after the hub status. The tag covers a save between the page's `GET /api/board` and
/// this subscription, which no `board` notice reaches.
async fn connect_snapshot(app: &AppState) -> Vec<Value> {
    let mut msgs = snapshot(app);
    match board::etag_now(app).await {
        Ok(etag) => msgs.insert(1, json!({"t": "board", "etag": etag})),
        Err(e) => tracing::warn!(error = %e, "cannot read the board's tag"),
    }
    msgs
}

async fn run(app: AppState, mut ws: WebSocket) {
    // Subscribe before the snapshot, so no change falls between the two. A change in
    // both arrives twice, and applying it again is harmless.
    let mut feed = app.feed.subscribe();
    // Registered before the snapshot: a client that has read its first message can
    // already be chosen. Dropped on every return below, which fails its open calls.
    let (to_tab, mut deliveries) = mpsc::unbounded_channel();
    let page = app.pages.register(to_tab.clone());
    for msg in connect_snapshot(&app).await {
        if send_json(&mut ws, &msg).await.is_err() {
            return;
        }
    }
    // Dropped on every return below, which cancels the tab's open streams (R12.8).
    let mut tab = Tab::new(app.clone(), to_tab);
    let stop = app.stopped();
    tokio::pin!(stop);
    let mut keepalive = Keepalive::new();
    loop {
        let out = tokio::select! {
            msg = ws.recv() => match msg {
                None | Some(Ok(Message::Close(_))) => return,
                Some(Err(_)) => {
                    // A closing page is not chosen any more.
                    drop(page);
                    return ws_too_big(ws, ROUTE).await;
                }
                Some(Ok(Message::Text(text))) => {
                    keepalive.seen();
                    match serde_json::from_str::<Value>(text.as_str()) {
                        Ok(msg) if msg.is_object() => match msg["t"].as_str() {
                            Some("active") => {
                                page.active(&msg["ago"]);
                                continue;
                            }
                            Some("cmd_result") => {
                                page.answer(&msg);
                                continue;
                            }
                            _ => tab.client_msg(&msg).await,
                        },
                        _ => continue,
                    }
                }
                Some(Ok(_)) => {
                    keepalive.seen();
                    continue;
                }
            },
            Some(delivery) = deliveries.recv() => match delivery {
                Delivery::Stream { sid, msg } => {
                    tab.stream_msg(&sid, &msg);
                    vec![msg]
                }
                Delivery::Plain(msg) => vec![msg],
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
                Ok(FeedMsg::Notes { generation }) => vec![json!({"t": "notes", "gen": generation})],
                // Missed messages: resend what can be resent.
                Err(RecvError::Lagged(_)) => connect_snapshot(&app).await,
                Err(RecvError::Closed) => return,
            },
            tick = keepalive.tick() => match tick {
                Tick::Ping => {
                    if ws.send(Message::Ping(Bytes::new())).await.is_err() {
                        return;
                    }
                    continue;
                }
                Tick::Dead => {
                    drop(page);
                    return ws_close(ws, ROUTE, close::GOING_AWAY, "no answer").await;
                }
            },
            () = &mut stop => {
                drop(page);
                return ws_close(ws, ROUTE, close::RESTART, "wb-web restarting").await;
            }
        };
        for msg in out {
            if send_json(&mut ws, &msg).await.is_err() {
                return;
            }
        }
    }
}

/// A page's answer to a `cmd`.
#[derive(Debug, PartialEq)]
pub enum Answer {
    /// `cmd_result{result}`: the tool's text.
    Result(String),
    /// `cmd_result{error}`: the tool threw.
    Error(String),
}

/// The `/rpc` clients that can run a `wb` command. Clones share one registry.
#[derive(Clone)]
pub struct Pages(Arc<Mutex<Registry>>);

struct Registry {
    /// Wall-clock ms when `started` was taken; [`Registry::now_ms`] counts on from it
    /// on the monotonic clock.
    epoch_ms: u64,
    started: Instant,
    next_serial: u64,
    next_cmd: u64,
    /// By serial, which is connection order.
    pages: BTreeMap<u64, Entry>,
}

struct Entry {
    /// `None` until the first valid `active`.
    last_active: Option<u64>,
    to: mpsc::UnboundedSender<Delivery>,
    /// Open calls sent to this page, by `cmd` id.
    pending: HashMap<String, oneshot::Sender<Answer>>,
}

impl Registry {
    fn now_ms(&self) -> u64 {
        let elapsed = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.epoch_ms.saturating_add(elapsed)
    }

    /// The greatest `lastActive`; `Some` ranks above `None`, and on a tie the newer
    /// connection wins.
    fn leader(&self) -> Option<u64> {
        self.pages
            .iter()
            .max_by_key(|(serial, e)| (e.last_active, **serial))
            .map(|(serial, _)| *serial)
    }
}

impl Default for Pages {
    fn default() -> Self {
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        Pages(Arc::new(Mutex::new(Registry {
            epoch_ms,
            started: Instant::now(),
            next_serial: 0,
            next_cmd: 0,
            pages: BTreeMap::new(),
        })))
    }
}

impl Pages {
    /// Every critical section leaves the registry consistent, so a poisoned lock is
    /// still usable.
    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds a `/rpc` client whose messages go to `to`.
    pub fn register(&self, to: mpsc::UnboundedSender<Delivery>) -> Page {
        let mut r = self.lock();
        r.next_serial += 1;
        let serial = r.next_serial;
        let entry = Entry {
            last_active: None,
            to,
            pending: HashMap::new(),
        };
        r.pages.insert(serial, entry);
        Page {
            pages: self.clone(),
            serial,
        }
    }

    /// Sends `cmd{id, tool, input}` to the leader, chosen now. `None` when no page is
    /// connected.
    pub fn call(&self, tool: &str, input: Map<String, Value>) -> Option<Call> {
        let mut r = self.lock();
        let serial = r.leader()?;
        r.next_cmd += 1;
        let id = format!("w{}", r.next_cmd);
        let (tx, rx) = oneshot::channel();
        let entry = r.pages.get_mut(&serial)?;
        let msg = json!({"t": "cmd", "id": id, "tool": tool, "input": input});
        // A page whose loop has ended drops `tx` here, which is `page_gone`.
        if entry.to.send(Delivery::Plain(msg)).is_ok() {
            entry.pending.insert(id.clone(), tx);
        }
        tracing::debug!(tool, id = %id, page = serial, "wb command sent to the leader");
        Some(Call {
            pages: self.clone(),
            serial,
            id,
            rx,
        })
    }
}

/// One registered `/rpc` client. Dropping it removes the client and fails its open
/// calls with `page_gone`.
pub struct Page {
    pages: Pages,
    serial: u64,
}

impl Page {
    /// `active{ago}`: `lastActive` is now minus `ago` ms. A non-number, negative or
    /// non-finite `ago` is ignored.
    pub fn active(&self, ago: &Value) {
        let Some(ago) = ago.as_f64().filter(|a| a.is_finite() && *a >= 0.0) else {
            return;
        };
        let mut r = self.pages.lock();
        // The cast saturates.
        let at = r.now_ms().saturating_sub(ago as u64);
        if let Some(e) = r.pages.get_mut(&self.serial) {
            e.last_active = Some(at);
        }
    }

    /// `cmd_result{id, result | error}`: answers the call with that `id` if it was sent
    /// to this page, else does nothing. A non-string value goes on as its JSON text.
    pub fn answer(&self, msg: &Value) {
        let Some(id) = msg["id"].as_str() else {
            return;
        };
        let tx = self
            .pages
            .lock()
            .pages
            .get_mut(&self.serial)
            .and_then(|e| e.pending.remove(id));
        let Some(tx) = tx else {
            return;
        };
        let answer = match msg.get("error") {
            Some(e) if !e.is_null() => Answer::Error(text(e)),
            _ => Answer::Result(msg.get("result").map(text).unwrap_or_default()),
        };
        let _ = tx.send(answer);
    }
}

impl Drop for Page {
    fn drop(&mut self) {
        // The entry's senders drop with it.
        self.pages.lock().pages.remove(&self.serial);
    }
}

/// A `cmd` sent to one page. Dropping it forgets the call, so a late `cmd_result` is
/// ignored.
pub struct Call {
    pages: Pages,
    serial: u64,
    id: String,
    rx: oneshot::Receiver<Answer>,
}

/// The page closed before it answered.
#[derive(Debug)]
pub struct PageGone;

impl Call {
    pub async fn answer(&mut self) -> Result<Answer, PageGone> {
        (&mut self.rx).await.map_err(|_| PageGone)
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if let Some(e) = self.pages.lock().pages.get_mut(&self.serial) {
            e.pending.remove(&self.id);
        }
    }
}

/// A string as is, `null` as empty text, anything else as its JSON text.
fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => v.to_string(),
    }
}
