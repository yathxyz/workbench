//! `GET /v1/stream` (design §3.8.4): the hub's sessions and the observed ones as
//! server-sent events, a snapshot first and every change after it.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use futures_util::Stream;
use futures_util::stream::unfold;
use serde::Serialize;
use serde_json::json;
use tokio::sync::broadcast::{Receiver, error::RecvError};

use super::{ApiState, Read};
use crate::hub::HubStatus;
use crate::observed::Change;
use crate::{AppState, FeedMsg};

/// A comment line goes out this often, so a dead peer is noticed.
const KEEPALIVE: Duration = Duration::from_secs(15);

pub fn routes() -> Router<ApiState> {
    Router::new().route("/stream", get(stream))
}

fn event(name: &str, data: &impl Serialize) -> Event {
    // `data` is one line: serde_json writes no raw newline.
    Event::default()
        .event(name)
        .data(serde_json::to_string(data).unwrap_or_default())
}

/// `hub`, and while the hub is up one `session` for every session it knows. A client
/// drops the hub sessions it held when a `hub` event arrives.
fn hub_events(app: &AppState, out: &mut VecDeque<Event>) -> Receiver<FeedMsg> {
    // Replace both the snapshot and the cursor. Feed writers hold this lock so no
    // delta superseded by the snapshot can be queued after the new subscription.
    let (hub, status, sessions) = {
        let state = app.hub.state();
        let sessions: Vec<_> = state.sessions.values().cloned().collect();
        (app.feed.subscribe(), state.status.name(), sessions)
    };
    out.push_back(event("hub", &json!({"status": status})));
    for session in sessions {
        out.push_back(event("session", &app.session_summary(&session)));
    }
    hub
}

fn observed_event(change: &Change) -> Event {
    match change {
        Change::Upsert(session) => event("observed", session),
        Change::Gone { id, key } => event("observed_gone", &json!({"id": id, "key": key})),
    }
}

struct Feed {
    app: AppState,
    hub: Receiver<FeedMsg>,
    observed: Receiver<Change>,
    /// Events not yet sent.
    out: VecDeque<Event>,
}

impl Feed {
    /// The next event; `None` ends the stream: wb-web is stopping, or this client
    /// lagged so far that events were lost.
    async fn next(&mut self) -> Option<Event> {
        loop {
            if let Some(event) = self.out.pop_front() {
                return Some(event);
            }
            tokio::select! {
                () = self.app.stopped() => return None,
                msg = self.hub.recv() => match msg {
                    Ok(FeedMsg::Hub(HubStatus::Up(_))) => {
                        self.hub = hub_events(&self.app, &mut self.out);
                    }
                    Ok(FeedMsg::Hub(status)) => {
                        self.out.push_back(event("hub", &json!({"status": status.name()})));
                    }
                    Ok(FeedMsg::Session(session)) => {
                        self.out.push_back(event("session", &self.app.session_summary(&session)));
                    }
                    Ok(FeedMsg::Gone { sid, epoch }) => {
                        self.out.push_back(event("gone", &json!({"sid": sid, "epoch": epoch})));
                    }
                    Ok(FeedMsg::Board { .. } | FeedMsg::Notes { .. }) => {}
                    Err(RecvError::Lagged(_) | RecvError::Closed) => return None,
                },
                change = self.observed.recv() => match change {
                    Ok(change) => self.out.push_back(observed_event(&change)),
                    Err(RecvError::Lagged(_) | RecvError::Closed) => return None,
                },
            }
        }
    }
}

async fn stream(
    _: Read,
    State(api): State<ApiState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let app = api.app.clone();
    let observed = api.changes.subscribe();
    let mut out = VecDeque::new();
    let hub = hub_events(&app, &mut out);
    for session in api.registry.list() {
        out.push_back(event("observed", &session));
    }
    out.push_back(event("ready", &json!({})));
    let feed = Feed {
        app,
        hub,
        observed,
        out,
    };
    let events = unfold(feed, |mut feed| async move {
        feed.next().await.map(|event| (Ok(event), feed))
    });
    Sse::new(events).keep_alive(KeepAlive::new().interval(KEEPALIVE))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;
    use tokio::sync::{Mutex, broadcast, watch};
    use wb_proto::hub::{Kind, Summary};

    #[tokio::test]
    async fn obsolete_up_drops_queued_session_deltas() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "test").unwrap();
        let cfg: crate::config::Config = serde_json::from_value(json!({
            "listen": "127.0.0.1:0", "publicOrigin": "http://localhost",
            "trustedProxy": "127.0.0.1", "proxySecretFile": dir.path().join("unused"),
            "hubSocket": dir.path().join("no-hub"), "stateDir": dir.path(),
            "webRoot": dir.path(), "boardsDir": dir.path(), "notesDir": dir.path(),
            "host": "local"
        }))
        .unwrap();
        let (tx, hub) = broadcast::channel(8);
        let (_stop, shutdown) = watch::channel(false);
        let (_changes, observed) = broadcast::channel(8);
        let app = std::sync::Arc::new(crate::App {
            hub: crate::hub::spawn_control(cfg.hub_socket.clone(), tx.clone()),
            assets: crate::static_files::Assets::load(&cfg.web_root, None).unwrap(),
            floor: crate::auth::Floor {
                trusted_proxy: cfg.trusted_proxy,
                secret: Box::default(),
                expected_host: String::new(),
                expected_origin: String::new(),
            },
            cfg,
            edit: None,
            feed: tx.clone(),
            observed: None,
            git_metadata: Default::default(),
            board_lock: Mutex::default(),
            pages: Default::default(),
            shutdown,
            sockets: watch::channel(0).0,
        });
        let mut feed = Feed {
            app,
            hub,
            observed,
            out: VecDeque::new(),
        };
        // The control task is already down before the client reads any of this batch.
        tx.send(FeedMsg::Hub(HubStatus::Up(crate::hub::HubInfo {
            version: String::new(),
            build: None,
            proto: 1,
            started_at: 1,
            host: "local".into(),
            agents: vec![],
            hosts: vec![],
            acp_config: false,
            acp_worktree: false,
            acp_task: false,
            session_action_epoch: false,
            shells: vec![],
            default_shell: String::new(),
            stale: false,
        })))
        .unwrap();
        tx.send(FeedMsg::Session(std::sync::Arc::new(Summary {
            sid: "obsolete".into(),
            kind: Kind::Pty,
            host: "local".into(),
            created_at: 1,
            updated_at: 2,
            alive: true,
            viewers: 0,
            cwd: "/".into(),
            fault: None,
            pty: None,
            acp: None,
        })))
        .unwrap();
        tx.send(FeedMsg::Hub(HubStatus::Down)).unwrap();

        let first = feed.next().await.unwrap();
        let body = Sse::new(futures_util::stream::once(async {
            Ok::<_, Infallible>(first)
        }))
        .into_response()
        .into_body();
        assert_eq!(
            to_bytes(body, 1024).await.unwrap().as_ref(),
            b"event: hub\ndata: {\"status\":\"down\"}\n\n"
        );
        assert!(futures_util::poll!(std::pin::pin!(feed.next())).is_pending());
    }
}
