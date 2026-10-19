//! `GET /api/info`, `/api/sessions`, `/api/status` and `/api/pty/{id}/capture` (design
//! §3.5.5, 20 §5.6). `sample`, `models` and `notesExists` in `/api/info` and the `edit`
//! block of `/api/status` come from edwind's `status` command (edwind spec R15.11);
//! `edit` and `editUp` in `/api/info` say whether frames are on and edwind is reachable
//! (R9.20).
//! Paths are relative to `/api`.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use wb_proto::hub::ErrorCode;
use wb_proto::limits::CAPTURE_MAX;
use wb_proto::state::derive;

use crate::AppState;
use crate::edit_client::EditHandle;
use crate::http::{ApiError, ApiQuery, Param};
use crate::hub::{CallError, HubStatus, with_state};
use crate::util::sanitize_sid;
use crate::{media, notes, sample};

/// Lines a capture returns when the request does not say.
const CAPTURE_DEFAULT: usize = 200;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/info", get(info))
        .route("/sessions", get(sessions))
        .route("/status", get(status))
        .route("/pty/{id}/capture", get(capture))
}

async fn info(State(app): State<AppState>) -> Json<Value> {
    let edit = app.edit_status().await;
    let status = app.hub.status.borrow().clone();
    let (agents, shells, default_shell, hub) = match &status {
        HubStatus::Up(h) => (
            json!(h.agents),
            json!(h.shells),
            Some(h.default_shell.clone()).filter(|s| !s.is_empty()),
            json!({
                "status": "up",
                "version": h.version,
                "build": h.build,
                "proto": h.proto,
                "startedAt": h.started_at,
                "stale": h.stale,
            }),
        ),
        HubStatus::Incompatible { proto } => (
            json!([]),
            json!([]),
            None,
            json!({"status": "incompatible", "version": null, "build": null, "proto": proto, "startedAt": null, "stale": null}),
        ),
        HubStatus::Down => (
            json!([]),
            json!([]),
            None,
            json!({"status": "down", "version": null, "build": null, "proto": null, "startedAt": null, "stale": null}),
        ),
    };
    Json(json!({
        "host": app.cfg.host,
        "home": std::env::var("HOME").ok(),
        "edit": frames_on(&app),
        "editUp": app.edit.as_ref().is_some_and(EditHandle::is_up),
        "sample": sample::enabled(&app).await,
        "models": edit.as_ref().map_or(json!({}), |s| match &s["models"] {
            Value::Object(models) => Value::Object(models.clone()),
            _ => json!({}),
        }),
        "notes": app.cfg.notes_dir,
        "notesExists": notes::exists(&app).await,
        "media": media::catalog(&app),
        "state": app.cfg.state_dir,
        "dist": null,
        "tmux": false,
        "artifactOrigin": null,
        "agents": agents,
        "shells": shells,
        "defaultShell": default_shell,
        "hub": hub,
    }))
}

/// Frames are on (R9.20): `frames` in `web.json` and an `editSocket` to serve them
/// over. Without the socket `/edit` could only close with 1013, so the flag alone does
/// not switch the board editor.
fn frames_on(app: &AppState) -> bool {
    app.cfg.frames.unwrap_or(false) && app.cfg.edit_socket.is_some()
}

/// 503 unless the hub is up.
fn hub_up(app: &AppState) -> Result<(), ApiError> {
    match *app.hub.status.borrow() {
        HubStatus::Up(_) => Ok(()),
        HubStatus::Down => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "hub unavailable",
        )),
        HubStatus::Incompatible { .. } => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "hub incompatible",
        )),
    }
}

async fn sessions(State(app): State<AppState>) -> Result<Json<Value>, ApiError> {
    hub_up(&app)?;
    let sessions: Vec<Value> = app.hub.sessions().iter().map(with_state).collect();
    Ok(Json(json!({"host": app.cfg.host, "sessions": sessions})))
}

/// R15.11: `{up, version, build, clients, buffers, journalBytes, imageGen,
/// loopLagP95Ms, ackP95Ms}` from edwind's `status`, or `null` while it is down.
fn edit_block(status: Option<Value>) -> Value {
    let Some(status) = status else {
        return Value::Null;
    };
    let mut block = json!({"up": true});
    for key in [
        "version",
        "build",
        "clients",
        "buffers",
        "journalBytes",
        "imageGen",
        "loopLagP95Ms",
        "ackP95Ms",
    ] {
        block[key] = status.get(key).cloned().unwrap_or(Value::Null);
    }
    block
}

async fn status(State(app): State<AppState>) -> Json<Value> {
    let (edit, units) = tokio::join!(app.edit_status(), crate::host::unit_counts());
    let edit = edit_block(edit);
    let host = tokio::task::spawn_blocking(host_status)
        .await
        .unwrap_or_default();
    let sessions = match hub_up(&app) {
        Ok(()) => {
            let sessions = app.hub.sessions();
            let mut by_state = BTreeMap::new();
            for s in &sessions {
                let state = serde_json::to_value(derive(s)).unwrap_or_default();
                *by_state
                    .entry(state.as_str().unwrap_or_default().to_owned())
                    .or_insert(0u32) += 1;
            }
            let alive = sessions.iter().filter(|s| s.alive).count();
            json!({"alive": alive, "tmux": 0, "byState": by_state})
        }
        Err(_) => json!({"alive": null, "tmux": null, "byState": null}),
    };
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_secs());
    Json(json!({
        "host": app.cfg.host,
        "time": time,
        "load": host.load,
        "mem": host.mem,
        "uptime": host.uptime,
        "disk": host.disk,
        "sessions": sessions,
        "units": units,
        "edit": edit,
    }))
}

/// What `/proc` and `statvfs` say; each part is `None` when it cannot be read.
#[derive(Default)]
struct HostStatus {
    load: Option<[f64; 3]>,
    mem: Option<Value>,
    uptime: Option<u64>,
    disk: Option<Value>,
}

fn host_status() -> HostStatus {
    let read = |path| std::fs::read_to_string(path).ok();
    HostStatus {
        load: read("/proc/loadavg").and_then(|t| parse_loadavg(&t)),
        mem: read("/proc/meminfo").and_then(|t| parse_meminfo(&t)),
        uptime: read("/proc/uptime").and_then(|t| parse_uptime(&t)),
        disk: rustix::fs::statvfs("/").ok().map(|st| {
            json!({
                "total": st.f_blocks * st.f_frsize,
                "free": st.f_bavail * st.f_frsize,
            })
        }),
    }
}

fn parse_loadavg(text: &str) -> Option<[f64; 3]> {
    let mut fields = text.split_whitespace().map(|f| f.parse().ok());
    Some([fields.next()??, fields.next()??, fields.next()??])
}

/// `{total, available}` in bytes; meminfo counts kB.
fn parse_meminfo(text: &str) -> Option<Value> {
    let field = |name: &str| {
        text.lines().find_map(|line| {
            let kb = line.strip_prefix(name)?.strip_prefix(':')?;
            kb.split_whitespace().next()?.parse::<u64>().ok()
        })
    };
    let total = field("MemTotal")?;
    let available = field("MemAvailable")?;
    Some(json!({"total": total * 1024, "available": available * 1024}))
}

/// Whole seconds.
fn parse_uptime(text: &str) -> Option<u64> {
    let secs: f64 = text.split_whitespace().next()?.parse().ok()?;
    Some(secs as u64)
}

#[derive(Deserialize)]
struct CaptureQuery {
    lines: Option<usize>,
}

async fn capture(
    State(app): State<AppState>,
    Param(id): Param<String>,
    ApiQuery(query): ApiQuery<CaptureQuery>,
) -> Result<Json<Value>, ApiError> {
    let sid = sanitize_sid(&id);
    if sid.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad id"));
    }
    hub_up(&app)?;
    let lines = query.lines.unwrap_or(CAPTURE_DEFAULT).clamp(1, CAPTURE_MAX) as u32;
    match app.hub.capture(sid.clone(), lines).await {
        Ok(text) => Ok(Json(json!({"id": sid, "tmux": false, "text": text}))),
        Err(CallError::Refused(ErrorCode::NotFound | ErrorCode::KindMismatch, _)) => Err(
            ApiError::new(StatusCode::NOT_FOUND, format!("no terminal {sid}")),
        ),
        Err(CallError::Unavailable) => Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "hub unavailable",
        )),
        Err(CallError::Timeout) => Err(ApiError::new(
            StatusCode::GATEWAY_TIMEOUT,
            "the hub did not answer",
        )),
        Err(CallError::Refused(_, message)) => Err(ApiError::new(StatusCode::BAD_GATEWAY, message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_files_parse() {
        assert_eq!(
            parse_loadavg("0.52 0.58 0.59 1/389 12345\n"),
            Some([0.52, 0.58, 0.59])
        );
        assert_eq!(parse_loadavg("0.52 0.58\n"), None);
        let meminfo =
            "MemTotal:       16000000 kB\nMemFree:  1000 kB\nMemAvailable:    8000000 kB\n";
        assert_eq!(
            parse_meminfo(meminfo),
            Some(json!({"total": 16_384_000_000u64, "available": 8_192_000_000u64}))
        );
        assert_eq!(parse_meminfo("MemTotal: 5 kB\n"), None);
        assert_eq!(parse_uptime("12345.67 54321.00\n"), Some(12345));
        assert_eq!(parse_uptime(""), None);
    }

    #[test]
    fn the_edit_block_picks_the_status_fields_or_is_null() {
        assert_eq!(edit_block(None), Value::Null);
        let status = json!({"version": "1.2", "build": "1.2", "clients": 3, "buffers": 7,
            "journalBytes": 100, "imageGen": 4, "loopLagP95Ms": 1.5, "ackP95Ms": null,
            "notesExists": true, "sample": false});
        assert_eq!(
            edit_block(Some(status)),
            json!({"up": true, "version": "1.2", "build": "1.2", "clients": 3, "buffers": 7,
                "journalBytes": 100, "imageGen": 4, "loopLagP95Ms": 1.5, "ackP95Ms": null})
        );
    }
}
