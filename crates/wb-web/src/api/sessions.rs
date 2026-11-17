//! The hub's sessions over the API (design §3.8.2): what the hub knows, and the
//! requests that steer an ACP session. Each request that reaches the hub uses a hub
//! connection of its own, since no socket stays open between two HTTP requests.

use std::io::Read as _;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde::de::{DeserializeOwned, MapAccess, Visitor};
use serde_json::{Value, json};
use tokio::time::timeout;
use wb_proto::hub::{AcpOpenReply, ErrorCode, HubMessage, HubRequest, Kind, SpawnAcp, Summary};
use wb_proto::journal::{EventBody, JournalEvent};
use wb_proto::limits::CAPTURE_MAX;

use super::{ApiState, Control, Read};
use crate::AppState;
use crate::http::{ApiError, ApiQuery, Body, Param};
use crate::hub::{CallError, ConnectError, HubConn, HubInfo, HubStatus, REPLY_TIMEOUT, with_state};
use crate::info::hub_up;
use crate::util::valid_sid;

/// The rid of the one request a connection carries.
const RID: u64 = 1;
/// Mode and config changes wait for the hub's 30 s agent deadline.
const CONFIG_TIMEOUT: Duration = Duration::from_secs(40);
/// Lines a capture returns when the request does not say.
const CAPTURE_DEFAULT: usize = 200;

pub fn routes() -> Router<ApiState> {
    Router::new()
        .route("/info", get(info))
        .route("/sessions", get(list).post(create))
        .route("/sessions/{sid}", get(one).delete(kill))
        .route("/sessions/{sid}/events", get(events))
        .route("/sessions/{sid}/capture", get(capture))
        .route("/sessions/{sid}/prompt", post(prompt))
        .route("/sessions/{sid}/cancel", post(cancel))
        .route("/sessions/{sid}/permission", post(permission))
        .route("/sessions/{sid}/elicitation", post(elicitation))
        .route("/sessions/{sid}/mode", post(mode))
        .route("/sessions/{sid}/config", post(config))
        .route("/sessions/{sid}/revive", post(revive))
}

/// The status a hub error becomes (§3.8.1).
fn status_of(code: ErrorCode) -> StatusCode {
    use ErrorCode::{
        AlreadyResolved, BadOption, BadRequest, Busy, Faulted, KindMismatch, NotAlive, NotFound,
        NotRevivable, Stale, Timeout, UnknownAgent,
    };
    match code {
        BadRequest | BadOption | UnknownAgent => StatusCode::BAD_REQUEST,
        NotFound => StatusCode::NOT_FOUND,
        KindMismatch | Busy | NotAlive | AlreadyResolved | Stale | NotRevivable | Faulted => {
            StatusCode::CONFLICT
        }
        Timeout => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_GATEWAY,
    }
}

fn unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "hub unavailable")
}

fn silent() -> ApiError {
    ApiError::new(StatusCode::GATEWAY_TIMEOUT, "the hub did not answer")
}

fn call_error(e: CallError) -> ApiError {
    match e {
        CallError::Unavailable => unavailable(),
        CallError::Timeout => silent(),
        CallError::Refused(code, message) => ApiError::new(status_of(code), message).code(code),
    }
}

/// A hub connection for one request, and that connection's hello.
async fn connect(app: &AppState) -> Result<(HubConn, HubInfo), ApiError> {
    hub_up(app)?;
    HubConn::connect(&app.cfg.hub_socket)
        .await
        .map_err(|e| match e {
            ConnectError::Unavailable(_) => unavailable(),
            ConnectError::Incompatible(_) => {
                ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "hub incompatible")
            }
        })
}

/// Sends `req` (its rid is [`RID`]) on a connection of its own and answers `{}` for
/// the hub's `ok`.
async fn act(app: &AppState, req: HubRequest, wait: Duration) -> Result<Json<Value>, ApiError> {
    let call = async {
        let (mut conn, _) = connect(app).await?;
        conn.request(&req, RID).await.map_err(call_error)
    };
    timeout(wait, call)
        .await
        .unwrap_or_else(|_| Err(silent()))?;
    Ok(Json(json!({})))
}

/// The sid of a path, or 400.
fn sid_of(id: String) -> Result<String, ApiError> {
    if valid_sid(&id) {
        Ok(id)
    } else {
        Err(ApiError::new(StatusCode::BAD_REQUEST, "bad id"))
    }
}

/// The body as the JSON an endpoint takes, or 400.
fn parse<T: DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(body).map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "bad body"))
}

async fn info(_: Read, State(api): State<ApiState>) -> Json<Value> {
    let app = &api.app;
    let status = app.hub.status.borrow().clone();
    let (hub, agents, hosts) = match &status {
        HubStatus::Up(h) => (
            json!({
                "status": "up",
                "version": h.version,
                "build": h.build,
                "proto": h.proto,
                "startedAt": h.started_at,
                "stale": h.stale,
            }),
            json!(h.agents),
            json!(h.hosts),
        ),
        other => {
            let proto = match other {
                HubStatus::Incompatible { proto } => Some(*proto),
                _ => None,
            };
            (
                json!({"status": other.name(), "version": null, "build": null, "proto": proto, "startedAt": null, "stale": null}),
                json!([]),
                json!([]),
            )
        }
    };
    Json(json!({
        "host": app.cfg.host,
        "version": env!("CARGO_PKG_VERSION"),
        "hub": hub,
        "agents": agents,
        "hosts": hosts,
    }))
}

async fn list(_: Read, State(api): State<ApiState>) -> Result<Json<Value>, ApiError> {
    let app = &api.app;
    hub_up(app)?;
    let sessions: Vec<Value> = app.hub.sessions().iter().map(with_state).collect();
    Ok(Json(json!({"host": app.cfg.host, "sessions": sessions})))
}

/// The Summary of `sid` as the control connection last heard it, or 404.
fn summary(app: &AppState, sid: &str) -> Result<Summary, ApiError> {
    hub_up(app)?;
    let sessions = app.hub.sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions
        .get(sid)
        .cloned()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("no session {sid}")))
}

async fn one(
    _: Read,
    State(api): State<ApiState>,
    Param(id): Param<String>,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    Ok(Json(with_state(&summary(&api.app, &sid)?)))
}

#[derive(Deserialize)]
struct EventsQuery {
    since: Option<u64>,
}

/// `acp.open` without `spawn`, read up to `acp.replayed`; the connection then closes,
/// which detaches it.
async fn events(
    _: Read,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    ApiQuery(query): ApiQuery<EventsQuery>,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    let open = HubRequest::AcpOpen {
        rid: RID,
        sid: sid.clone(),
        since: query.since.unwrap_or(0),
        epoch: None,
        spawn: None,
    };
    let replay = async {
        let (mut conn, _) = connect(&api.app).await?;
        let reply = conn.request(&open, RID).await.map_err(call_error)?;
        let reply: AcpOpenReply =
            serde_json::from_value(Value::Object(reply)).map_err(|_| bad_reply())?;
        let mut events: Vec<Box<JournalEvent>> = Vec::new();
        loop {
            match conn.recv().await {
                // An unknown kind decodes without its payload, so it is left out, as
                // the browser's relay leaves it out.
                Some(HubMessage::AcpEv { ev, .. }) if ev.body == EventBody::Unknown => {
                    tracing::warn!(seq = ev.seq, "unknown journal event not returned");
                }
                Some(HubMessage::AcpEv { ev, .. }) => events.push(ev),
                Some(HubMessage::AcpReplayed {
                    head, truncated, ..
                }) => {
                    return Ok(json!({
                        "sid": sid,
                        "epoch": reply.summary.created_at,
                        "head": head,
                        "from": reply.from,
                        "reset": reply.reset,
                        "truncated": truncated,
                        "events": events,
                    }));
                }
                Some(_) => {}
                None => return Err(unavailable()),
            }
        }
    };
    let body = timeout(REPLY_TIMEOUT, replay)
        .await
        .unwrap_or_else(|_| Err(silent()))?;
    Ok(Json(body))
}

fn bad_reply() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "the hub's reply was not understood",
    )
}

#[derive(Deserialize)]
struct CaptureQuery {
    lines: Option<usize>,
}

async fn capture(
    _: Read,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    ApiQuery(query): ApiQuery<CaptureQuery>,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    hub_up(&api.app)?;
    let lines = query.lines.unwrap_or(CAPTURE_DEFAULT).clamp(1, CAPTURE_MAX) as u32;
    let text = api
        .app
        .hub
        .capture(sid.clone(), lines)
        .await
        .map_err(call_error)?;
    Ok(Json(json!({"sid": sid, "text": text})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    agent: String,
    cwd: String,
    host: Option<String>,
    sid: Option<String>,
    config: Option<StartConfig>,
}

/// JSON member order matters: changing a model may change the remaining options.
struct StartConfig(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for StartConfig {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Ordered;
        impl<'de> Visitor<'de> for Ordered {
            type Value = StartConfig;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of config option ids to values")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<StartConfig, M::Error> {
                let mut options = Vec::new();
                while let Some(option) = map.next_entry()? {
                    options.push(option);
                }
                Ok(StartConfig(options))
            }
        }
        deserializer.deserialize_map(Ordered)
    }
}

/// `api_` and 16 random hex digits.
fn random_sid() -> std::io::Result<String> {
    let mut bytes = [0u8; 8];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().fold("api_".to_owned(), |mut sid, b| {
        sid.push_str(&format!("{b:02x}"));
        sid
    }))
}

/// The `host` a spawn carries: none for the hub's own host, and a name only when this
/// hub's hello lists it. A hub that predates §3.8.5 would ignore the field and start
/// the agent locally, so it is never asked.
fn spawn_host(info: &HubInfo, host: Option<String>) -> Result<Option<String>, ApiError> {
    match host {
        None => Ok(None),
        Some(h) if h == info.host => Ok(None),
        Some(h) if info.hosts.iter().any(|known| known.name == h) => Ok(Some(h)),
        Some(h) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("no host {h}"),
        )),
    }
}

async fn create(
    _: Control,
    State(api): State<ApiState>,
    Body(body): Body,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let body: Create = parse(&body)?;
    let sid = match body.sid {
        Some(sid) => sid_of(sid)?,
        None => random_sid().map_err(|e| {
            tracing::error!(error = %e, "no random source for a sid");
            ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "cannot make a sid")
        })?,
    };
    let open = async {
        let (mut conn, info) = connect(&api.app).await?;
        let req = HubRequest::AcpOpen {
            rid: RID,
            sid: sid.clone(),
            since: 0,
            epoch: None,
            spawn: Some(SpawnAcp {
                agent: body.agent,
                cwd: body.cwd,
                host: spawn_host(&info, body.host)?,
            }),
        };
        let reply = conn.request(&req, RID).await.map_err(call_error)?;
        Ok::<_, ApiError>((conn, reply))
    };
    let (mut conn, reply) = timeout(REPLY_TIMEOUT, open)
        .await
        .unwrap_or_else(|_| Err(silent()))?;
    let mut reply: AcpOpenReply =
        serde_json::from_value(Value::Object(reply)).map_err(|_| bad_reply())?;
    if !reply.new {
        return Err(ApiError::new(StatusCode::CONFLICT, "session exists"));
    }
    let mut errors = Vec::new();
    if let Some(StartConfig(options)) = body.config
        && !options.is_empty()
    {
        let ready = timeout(CONFIG_TIMEOUT, config_ready(&mut conn, &mut reply.summary))
            .await
            .unwrap_or(Err(CallError::Timeout));
        for (index, (id, value)) in options.into_iter().enumerate() {
            let rid = index as u64 + 2;
            let result = match &ready {
                Ok(()) => {
                    let req = HubRequest::AcpSetConfigOption {
                        rid,
                        sid: sid.clone(),
                        epoch: reply.summary.created_at,
                        config_id: id.clone(),
                        value: value.clone(),
                    };
                    timeout(
                        CONFIG_TIMEOUT,
                        configure(&mut conn, req, rid, &mut reply.summary),
                    )
                    .await
                    .unwrap_or(Err(CallError::Timeout))
                }
                Err(e) => Err(match e {
                    CallError::Unavailable => CallError::Unavailable,
                    CallError::Timeout => CallError::Timeout,
                    CallError::Refused(code, message) => CallError::Refused(*code, message.clone()),
                }),
            };
            if let Err(e) = result {
                let (code, error) = match e {
                    CallError::Unavailable => (None, "hub unavailable".to_owned()),
                    CallError::Timeout => (
                        Some(ErrorCode::Timeout),
                        "the hub did not answer".to_owned(),
                    ),
                    CallError::Refused(code, message) => (Some(code), message),
                };
                let mut failure = json!({"id": id, "value": value, "error": error});
                if let Some(code) = code {
                    failure["code"] = json!(code);
                }
                errors.push(failure);
            }
        }
    }
    let created = json!({
        "sid": sid,
        "session": with_state(&reply.summary),
        "configErrors": errors,
    });
    Ok((StatusCode::CREATED, Json(created)))
}

/// Waits for this incarnation's setup, not an old session id left by a revive.
async fn config_ready(conn: &mut HubConn, summary: &mut Summary) -> Result<(), CallError> {
    let mut failure = None;
    while summary.acp.as_ref().is_none_or(|a| {
        a.agent_session_id.is_none() || a.activity == wb_proto::hub::Activity::Setup
    }) {
        match conn.recv().await {
            Some(HubMessage::AcpEv { sid, ev }) if sid == summary.sid => match ev.body {
                EventBody::SetupError { code, message, .. } => {
                    let code = if code == wb_proto::journal::SetupErrorCode::Timeout {
                        ErrorCode::Timeout
                    } else {
                        ErrorCode::AgentError
                    };
                    failure = Some(CallError::Refused(code, message));
                }
                EventBody::Exit { .. } => {
                    failure = Some(CallError::Refused(
                        ErrorCode::NotAlive,
                        "the agent exited during setup".into(),
                    ));
                }
                _ => {}
            },
            Some(HubMessage::AcpInfo {
                summary: current, ..
            }) if current.sid == summary.sid && current.created_at == summary.created_at => {
                *summary = *current;
                if let Some(fault) = &summary.fault {
                    return Err(CallError::Refused(
                        ErrorCode::Faulted,
                        fault.message.clone(),
                    ));
                }
                if let Some(error) = failure.take() {
                    return Err(error);
                }
            }
            Some(HubMessage::Gone { sid, epoch })
                if sid == summary.sid && epoch == summary.created_at =>
            {
                return Err(CallError::Refused(
                    ErrorCode::Stale,
                    "the session was forgotten".into(),
                ));
            }
            Some(_) => {}
            None => return Err(CallError::Unavailable),
        }
    }
    Ok(())
}

/// Keeps the snapshot updates that precede the config reply on this connection.
async fn configure(
    conn: &mut HubConn,
    req: HubRequest,
    rid: u64,
    summary: &mut Summary,
) -> Result<(), CallError> {
    conn.send(&req).await.map_err(|_| CallError::Unavailable)?;
    loop {
        match conn.recv().await {
            Some(HubMessage::Ok { rid: r, .. }) if r == rid => return Ok(()),
            Some(HubMessage::Err {
                rid: Some(r),
                code,
                message,
                ..
            }) if r == rid => {
                return Err(CallError::Refused(code, message));
            }
            Some(HubMessage::AcpInfo {
                summary: current, ..
            }) if current.sid == summary.sid && current.created_at == summary.created_at => {
                *summary = *current;
            }
            Some(HubMessage::Gone { sid, epoch })
                if sid == summary.sid && epoch == summary.created_at =>
            {
                return Err(CallError::Refused(
                    ErrorCode::Stale,
                    "the session was forgotten".into(),
                ));
            }
            Some(_) => {}
            None => return Err(CallError::Unavailable),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prompt {
    text: Option<String>,
    blocks: Option<Vec<Value>>,
}

async fn prompt(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    Body(body): Body,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    let body: Prompt = parse(&body)?;
    let prompt = match (body.text, body.blocks) {
        (Some(text), None) => vec![json!({"type": "text", "text": text})],
        (None, Some(blocks)) => blocks,
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "give text or blocks, one of them",
            ));
        }
    };
    let req = HubRequest::AcpPrompt {
        rid: RID,
        sid,
        prompt,
    };
    act(&api.app, req, REPLY_TIMEOUT).await
}

async fn cancel(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    act(
        &api.app,
        HubRequest::AcpCancel { rid: RID, sid },
        REPLY_TIMEOUT,
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Permission {
    req: u64,
    epoch: u64,
    outcome: Value,
}

async fn permission(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    Body(body): Body,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    let body: Permission = parse(&body)?;
    let req = HubRequest::AcpPermission {
        rid: RID,
        sid,
        req: body.req,
        epoch: body.epoch,
        outcome: body.outcome,
    };
    act(&api.app, req, REPLY_TIMEOUT).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Elicitation {
    req: u64,
    epoch: u64,
    response: Value,
}

async fn elicitation(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    Body(body): Body,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    let body: Elicitation = parse(&body)?;
    let req = HubRequest::AcpElicitation {
        rid: RID,
        sid,
        req: body.req,
        epoch: body.epoch,
        response: body.response,
    };
    act(&api.app, req, REPLY_TIMEOUT).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Mode {
    mode_id: String,
}

async fn mode(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    Body(body): Body,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    let body: Mode = parse(&body)?;
    let req = HubRequest::AcpSetMode {
        rid: RID,
        sid,
        mode_id: body.mode_id,
    };
    act(&api.app, req, CONFIG_TIMEOUT).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    id: String,
    value: Value,
}

async fn config(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    Body(body): Body,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    let body: Config = parse(&body)?;
    let epoch = summary(&api.app, &sid)?.created_at;
    let req = HubRequest::AcpSetConfigOption {
        rid: RID,
        sid,
        epoch,
        config_id: body.id,
        value: body.value,
    };
    act(&api.app, req, CONFIG_TIMEOUT).await
}

async fn revive(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    act(
        &api.app,
        HubRequest::AcpRevive { rid: RID, sid },
        REPLY_TIMEOUT,
    )
    .await
}

#[derive(Deserialize)]
struct KillQuery {
    forget: Option<bool>,
}

/// `acp.kill` or `pty.kill`, by the kind the control connection last heard.
async fn kill(
    _: Control,
    State(api): State<ApiState>,
    Param(id): Param<String>,
    ApiQuery(query): ApiQuery<KillQuery>,
) -> Result<Json<Value>, ApiError> {
    let sid = sid_of(id)?;
    let forget = query.forget.unwrap_or(false);
    let req = match summary(&api.app, &sid)?.kind {
        Kind::Acp => HubRequest::AcpKill {
            rid: RID,
            sid,
            forget,
        },
        Kind::Pty => HubRequest::PtyKill {
            rid: RID,
            sid,
            forget,
        },
        Kind::Unknown => {
            return Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                "a session of a kind this version does not know",
            ));
        }
    };
    act(&api.app, req, REPLY_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use wb_proto::hub::{Agent, Host};

    #[test]
    fn hub_errors_become_statuses() {
        use ErrorCode::*;
        let table = [
            (BadRequest, 400),
            (BadOption, 400),
            (UnknownAgent, 400),
            (NotFound, 404),
            (KindMismatch, 409),
            (Busy, 409),
            (NotAlive, 409),
            (AlreadyResolved, 409),
            (Stale, 409),
            (NotRevivable, 409),
            (Faulted, 409),
            (Timeout, 504),
            (SpawnFailed, 502),
            (AgentError, 502),
            (InputOverflow, 502),
            (Proto, 502),
            (UnknownType, 502),
            (Internal, 502),
            (Unknown, 502),
        ];
        for (code, status) in table {
            assert_eq!(status_of(code).as_u16(), status, "{code:?}");
        }
    }

    #[test]
    fn a_spawn_names_only_a_host_the_hub_listed() {
        let info = |hosts: &[&str]| HubInfo {
            version: "0.1.0".into(),
            build: None,
            proto: 1,
            started_at: 0,
            host: "hubhost".into(),
            agents: Vec::new(),
            hosts: hosts
                .iter()
                .map(|name| Host {
                    name: (*name).into(),
                    agents: vec![Agent {
                        name: "claude".into(),
                        label: "Claude".into(),
                    }],
                })
                .collect(),
            shells: Vec::new(),
            default_shell: String::new(),
            stale: false,
        };
        let host = |info: &HubInfo, h: Option<&str>| {
            spawn_host(info, h.map(str::to_owned)).map_err(|_| ())
        };
        let new = info(&["laptop"]);
        assert_eq!(host(&new, None), Ok(None));
        assert_eq!(host(&new, Some("hubhost")), Ok(None), "the hub's own host");
        assert_eq!(host(&new, Some("laptop")), Ok(Some("laptop".into())));
        assert_eq!(host(&new, Some("desktop")), Err(()));
        // A hub that predates remote hosts lists none.
        assert_eq!(host(&info(&[]), Some("laptop")), Err(()));
    }

    #[test]
    fn random_sids_are_sids() {
        let a = random_sid().unwrap();
        assert_eq!(a.len(), 20);
        assert!(a.starts_with("api_") && valid_sid(&a), "{a}");
        assert_ne!(a, random_sid().unwrap());
    }
}
