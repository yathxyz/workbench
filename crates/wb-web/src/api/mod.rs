//! The mesh API (design §3.8.1, §3.8.2): a listener of its own that serves `/v1` to
//! clients on the mesh. A client is its token; the token's scopes say what it may do.
//!
//! The gate wraps every route and fallback, so a request without a valid token gets
//! 401 before it can learn whether a path exists.

mod observed;
mod sessions;
mod stream;

use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};
use std::os::unix::fs::DirBuilderExt;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Request, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::request::Parts;
use axum::http::{Method, StatusCode};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, spawn_blocking};
use tokio::time::{MissedTickBehavior, interval};

use crate::AppState;
use crate::http::{ApiError, not_found};
use crate::observed::{Change, OBS_PUSH_EVERY, OBS_SAVE_EVERY, OBS_SWEEP, Registry};
use crate::routes::method_not_allowed;
use crate::util::now_ms;

/// The largest request body, an event included.
pub const API_BODY_MAX: usize = 1 << 20;

/// What a token may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Send session events.
    Events,
    /// Every `GET`.
    Read,
    /// Start, prompt, answer and end sessions.
    Control,
}

/// A client of the API. Deliberately not `Debug`: it holds the token.
pub struct Client {
    pub name: String,
    pub token: Box<[u8]>,
    pub scopes: BTreeSet<Scope>,
    /// The host its events are filed under.
    pub host: Option<String>,
    /// The only peer address the token is accepted from, in canonical form.
    pub address: Option<IpAddr>,
}

/// The clients a request is checked against.
pub struct Gate {
    pub clients: Vec<Arc<Client>>,
}

impl Gate {
    /// The client whose token the request carries, if it comes from an address that
    /// client may use. `X-Forwarded-For` is never read.
    pub fn client(&self, peer: IpAddr, headers: &HeaderMap) -> Option<&Arc<Client>> {
        let mut values = headers.get_all(header::AUTHORIZATION).iter();
        let (Some(value), None) = (values.next(), values.next()) else {
            return None;
        };
        let token = value.as_bytes().strip_prefix(b"Bearer ")?;
        // Every client is compared, in constant time for equal lengths; the length is
        // not secret.
        let mut found = None;
        for client in &self.clients {
            if bool::from(token.ct_eq(&client.token)) {
                found = Some(client);
            }
        }
        found.filter(|c| c.address.is_none_or(|a| a == peer.to_canonical()))
    }
}

/// What the API's handlers share.
pub struct Api {
    pub app: AppState,
    gate: Gate,
    /// The observed sessions (§3.8.3).
    pub registry: Registry,
    /// Every change of the registry, for the event streams.
    pub changes: broadcast::Sender<Change>,
}

pub type ApiState = Arc<Api>;

/// Changes a slow event stream may fall behind by before it is disconnected.
const CHANGES_CAPACITY: usize = 1024;

/// Loads the registry and serves the API on `listener` until `app` stops. The registry
/// is saved when the stop begins, and again once the last request has ended, which is
/// where the task ends.
pub fn start(app: AppState, gate: Gate, listener: TcpListener) -> Result<JoinHandle<()>> {
    let state_dir = &app.cfg.state_dir;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state_dir)
        .with_context(|| format!("cannot create {}", state_dir.display()))?;
    let registry = Registry::load(state_dir, &app.cfg.host, Path::new("/proc"), now_ms());
    let api = Arc::new(Api {
        app,
        gate,
        registry,
        changes: broadcast::channel(CHANGES_CAPACITY).0,
    });
    tracing::info!("api listening on {}", listener.local_addr()?);
    let service = router(api.clone()).into_make_service_with_connect_info::<SocketAddr>();
    Ok(tokio::spawn(async move {
        let ticker = tokio::spawn(tick(api.clone()));
        let stopping = api.clone();
        let served = axum::serve(listener, service)
            .with_graceful_shutdown(async move { stopping.app.stopped().await })
            .await;
        if let Err(e) = served {
            tracing::error!(error = %e, "api server failed");
        }
        let _ = ticker.await;
        save(&api.registry).await;
    }))
}

/// Publishes the registry's changes, ends the sessions that are over, and saves it,
/// each at its own pace, until the web stops; then saves it once more.
async fn tick(api: ApiState) {
    let every = |period| {
        let mut ticks = interval(period);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ticks
    };
    let (mut push, mut sweep, mut saving) = (
        every(OBS_PUSH_EVERY),
        every(OBS_SWEEP),
        every(OBS_SAVE_EVERY),
    );
    loop {
        tokio::select! {
            () = api.app.stopped() => return save(&api.registry).await,
            _ = push.tick() => {
                for change in api.registry.drain() {
                    // No stream is listening: nothing to tell.
                    let _ = api.changes.send(change);
                }
            }
            _ = sweep.tick() => api.registry.sweep(now_ms()),
            _ = saving.tick() => save(&api.registry).await,
        }
    }
}

/// Saves the registry off the runtime's threads; a failure is logged and the next
/// save tries again.
async fn save(registry: &Registry) {
    let registry = registry.clone();
    match spawn_blocking(move || registry.save()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!(error = %e, "observed sessions not saved"),
        Err(e) => tracing::warn!(error = %e, "observed sessions not saved"),
    }
}

/// The API's router, behind the gate.
fn router(state: ApiState) -> Router {
    let v1 = Router::new()
        .merge(sessions::routes())
        .merge(observed::routes())
        .merge(stream::routes());
    Router::new()
        .nest("/v1", v1)
        .method_not_allowed_fallback(method_not_allowed)
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(API_BODY_MAX))
        // Last, so it wraps every route and fallback above.
        .layer(from_fn_with_state(state.clone(), gate))
        .with_state(state)
}

/// The gate middleware: 401 unless the request carries a client's token.
async fn gate(
    State(api): State<ApiState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    mut req: Request,
    next: Next,
) -> Response {
    let client = api.gate.client(peer.ip(), req.headers()).cloned();
    let mut res = match client {
        Some(client) => {
            req.extensions_mut().insert(client);
            next.run(req).await
        }
        None => {
            refused(peer.ip(), req.method(), req.uri().path(), None);
            let mut res = ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
            res.headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            res
        }
    };
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

/// Logs a refusal: the path without its query, and no header value. `client` is the
/// name of the client whose token the request carried, when it carried one.
fn refused(peer: IpAddr, method: &Method, path: &str, client: Option<&str>) {
    let client = client.unwrap_or("-");
    tracing::warn!(%peer, %method, path, client, "api request refused");
}

/// The client the gate let in, if its token has `scope`; else 403.
fn need(parts: &Parts, scope: Scope) -> Result<Arc<Client>, ApiError> {
    let client = parts.extensions.get::<Arc<Client>>();
    match client {
        Some(client) if client.scopes.contains(&scope) => Ok(client.clone()),
        _ => {
            let peer = parts.extensions.get::<ConnectInfo<SocketAddr>>();
            if let Some(ConnectInfo(peer)) = peer {
                let name = client.map(|c| c.name.as_str());
                refused(peer.ip(), &parts.method, parts.uri.path(), name);
            }
            Err(ApiError::new(StatusCode::FORBIDDEN, "forbidden"))
        }
    }
}

/// Lets a handler run for a client with the `read` scope. Every handler takes one of
/// these three first, so the scope is checked before anything else of the request.
pub struct Read;

/// As [`Read`], for the `control` scope.
pub struct Control;

/// As [`Read`], for the `events` scope; carries the client, whose `host` files the event.
pub struct Events(pub Arc<Client>);

impl<S: Send + Sync> FromRequestParts<S> for Read {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        need(parts, Scope::Read).map(|_| Read)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Control {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        need(parts, Scope::Control).map(|_| Control)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Events {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, ApiError> {
        need(parts, Scope::Events).map(Events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const B: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

    fn gate() -> Gate {
        let client = |name: &str, token: &str, address: Option<&str>| {
            Arc::new(Client {
                name: name.into(),
                token: token.as_bytes().into(),
                scopes: [Scope::Read].into(),
                host: None,
                address: address.map(|a| a.parse().unwrap()),
            })
        };
        Gate {
            clients: vec![
                client("anywhere", A, None),
                client("pinned", B, Some("192.0.2.7")),
            ],
        }
    }

    fn headers(values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(header::AUTHORIZATION, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn a_token_names_its_client() {
        let gate = gate();
        let peer: IpAddr = "198.51.100.9".parse().unwrap();
        let name = |values: &[&str], peer: IpAddr| {
            gate.client(peer, &headers(values)).map(|c| c.name.clone())
        };
        assert_eq!(
            name(&[&format!("Bearer {A}")], peer).as_deref(),
            Some("anywhere")
        );
        // (what, the Authorization values)
        let refused: [(&str, Vec<String>); 8] = [
            ("no header", vec![]),
            ("another token", vec![format!("Bearer {}", "0".repeat(64))]),
            ("a short token", vec![format!("Bearer {}", &A[..63])]),
            ("a longer token", vec![format!("Bearer {A}0")]),
            ("no scheme", vec![A.to_owned()]),
            ("another scheme", vec![format!("Basic {A}")]),
            ("a lowercase scheme", vec![format!("bearer {A}")]),
            (
                "two headers",
                vec![format!("Bearer {A}"), format!("Bearer {A}")],
            ),
        ];
        for (what, values) in refused {
            let values: Vec<&str> = values.iter().map(String::as_str).collect();
            assert_eq!(name(&values, peer), None, "{what}");
        }
    }

    #[test]
    fn a_pinned_token_is_taken_from_its_address_only() {
        let gate = gate();
        let auth = headers(&[&format!("Bearer {B}")]);
        let from = |peer: &str| gate.client(peer.parse().unwrap(), &auth).is_some();
        assert!(from("192.0.2.7"));
        assert!(
            from("::ffff:192.0.2.7"),
            "an IPv4-mapped peer is its IPv4 address"
        );
        assert!(!from("192.0.2.8"));
        assert!(!from("198.51.100.9"));
    }
}
