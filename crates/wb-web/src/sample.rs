//! `sample` on `/rpc` (design §3.5.3, edwind spec §12.2): the browser's `sample`,
//! `tool_result`, `tool_error`, `cancel` and `limits` are forwarded to edwind over
//! `edit.sock`, and the stream edwind answers with comes back to the tab that asked.
//! The browser contract is unchanged; this module only maps the tab's `id` to a
//! stream id (`sid`) unique in this process.

use std::collections::HashMap;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::AppState;
use crate::edit_client::{Delivery, EditError, Stream};

/// The `error.message` of a `sample` while no model is served.
const SAMPLE_OFF: &str = "no language model is available on this server: sample is off until workbench-edit runs with a model backend";

/// Fields of a `sample` the browser sends that edwind reads (§12.2).
const SAMPLE_FIELDS: [&str; 6] = ["input", "modelTier", "model", "effort", "images", "tools"];

/// Whether `/rpc` serves `sample`: edwind is up and reports a model backend.
pub async fn enabled(app: &AppState) -> bool {
    app.edit_status().await.is_some_and(|s| s["sample"] == true)
}

/// One `/rpc` socket's streams. Dropping it cancels what is still open (R12.8).
pub struct Tab {
    app: AppState,
    /// This socket's id, sent to edwind as `tab`.
    pub id: String,
    /// `sid` to the tab's `id`, for every stream not yet ended.
    open: HashMap<String, Value>,
    to: mpsc::UnboundedSender<Delivery>,
}

impl Tab {
    /// A tab whose deliveries go to `to`; the socket's loop reads the other end.
    pub fn new(app: AppState, to: mpsc::UnboundedSender<Delivery>) -> Tab {
        let id = match &app.edit {
            Some(edit) => edit.next_id(),
            None => "tab".to_owned(),
        };
        Tab {
            app,
            id,
            open: HashMap::new(),
            to,
        }
    }

    /// Handles one message from the browser; returns what to answer right away.
    /// Messages this module does not know are ignored.
    pub async fn client_msg(&mut self, msg: &Value) -> Vec<Value> {
        let id = &msg["id"];
        match msg["t"].as_str() {
            Some("sample") => self.sample(msg).await.into_iter().collect(),
            Some(t @ ("tool_result" | "tool_error" | "cancel")) => {
                self.forward(t, msg);
                Vec::new()
            }
            Some("limits") => {
                self.limits(id.clone());
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// A stream message from edwind: `done` and `error` end the stream.
    pub fn stream_msg(&mut self, sid: &str, msg: &Value) {
        if matches!(msg["t"].as_str(), Some("done" | "error")) {
            self.open.remove(sid);
        }
    }

    async fn sample(&mut self, msg: &Value) -> Option<Value> {
        let id = msg["id"].clone();
        let off = || Some(sample_off(id.clone()));
        if !enabled(&self.app).await {
            return off();
        }
        let edit = self.app.edit.as_ref()?;
        let sid = edit.next_id();
        let mut out = json!({"t": "sample", "sid": sid, "tab": self.id});
        for key in SAMPLE_FIELDS {
            if let Some(v) = msg.get(key) {
                out[key] = v.clone();
            }
        }
        edit.open_stream(
            sid.clone(),
            Stream {
                id: id.clone(),
                to: self.to.clone(),
            },
        );
        match edit.send(out) {
            Ok(()) => {
                self.open.insert(sid, id);
                None
            }
            Err(_) => {
                edit.close_stream(&sid);
                off()
            }
        }
    }

    /// `tool_result`, `tool_error` and `cancel` go to edwind with the stream's `sid`.
    fn forward(&self, t: &str, msg: &Value) {
        let Some(edit) = self.app.edit.as_ref() else {
            return;
        };
        let Some(sid) = self.sid_of(&msg["id"]) else {
            return;
        };
        let mut out = json!({"t": t, "sid": sid});
        for key in ["callId", "result", "message"] {
            if let Some(v) = msg.get(key) {
                out[key] = v.clone();
            }
        }
        if let Err(e) = edit.send(out) {
            tracing::debug!(t, error = ?e, "sample message not forwarded");
        }
    }

    /// `ok{id, value}` with `sample-limits`, or `null` when edwind cannot say.
    fn limits(&self, id: Value) {
        let app = self.app.clone();
        let to = self.to.clone();
        tokio::spawn(async move {
            let value = match &app.edit {
                Some(edit) if enabled(&app).await => edit
                    .call("sample-limits", json!([]))
                    .await
                    .unwrap_or(Value::Null),
                _ => Value::Null,
            };
            let _ = to.send(Delivery::Plain(
                json!({"t": "ok", "id": id, "value": value}),
            ));
        });
    }

    fn sid_of(&self, id: &Value) -> Option<String> {
        self.open
            .iter()
            .find(|(_, tab_id)| *tab_id == id)
            .map(|(sid, _)| sid.clone())
    }
}

impl Drop for Tab {
    fn drop(&mut self) {
        let Some(edit) = self.app.edit.as_ref() else {
            return;
        };
        for sid in self.open.keys() {
            edit.close_stream(sid);
            match edit.send(json!({"t": "cancel", "sid": sid})) {
                Ok(()) | Err(EditError::Down) => {}
                Err(e) => tracing::debug!(error = ?e, "cancel not sent"),
            }
        }
    }
}

fn sample_off(id: Value) -> Value {
    json!({"t": "error", "id": id, "code": "sampling_disabled", "message": SAMPLE_OFF})
}
