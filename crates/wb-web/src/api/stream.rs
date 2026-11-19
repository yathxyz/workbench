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
fn hub_events(app: &AppState, out: &mut VecDeque<Event>) {
    let (status, sessions) = app.hub.snapshot();
    out.push_back(event("hub", &json!({"status": status.name()})));
    for session in sessions {
        out.push_back(event("session", &app.session_summary(&session)));
    }
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
                    Ok(FeedMsg::Hub(HubStatus::Up(_))) => hub_events(&self.app, &mut self.out),
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
    // Subscribed before the snapshot is taken, so no change between the two is lost;
    // one that lands in both is sent twice, which a client folds to the same state.
    let app = api.app.clone();
    let hub = app.feed.subscribe();
    let observed = api.changes.subscribe();
    let mut out = VecDeque::new();
    hub_events(&app, &mut out);
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
