//! ACP v1 conformance of JSON-RPC messages, judged by `agent-client-protocol-schema`.

use std::collections::HashMap;

use agent_client_protocol_schema::v1 as acp;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// Who sent a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
    Agent,
    Client,
}

impl Side {
    fn other(self) -> Side {
        match self {
            Side::Agent => Side::Client,
            Side::Client => Side::Agent,
        }
    }
}

/// Checks a conversation message by message. A response is judged by the method of the
/// request it answers, so the checker must see that request first.
#[derive(Default)]
pub struct Checker {
    /// The method of every request still unanswered, by sender and encoded id.
    asked: HashMap<(Side, String), String>,
}

impl Checker {
    /// Panics unless `msg` from `from` is well-formed ACP v1. The fake's deliberate
    /// extras pass unchecked: an unknown `sessionUpdate` variant (`fake_future_update`)
    /// and `_`-prefixed extension methods.
    pub fn check(&mut self, from: Side, msg: &Value) {
        assert_eq!(msg["jsonrpc"], "2.0", "{msg}");
        let params = &msg["params"];
        match (msg["method"].as_str(), msg.get("id")) {
            (Some(method), _) if method.starts_with('_') => {}
            (Some(method), Some(id)) => {
                request(from, method, params);
                self.asked.insert((from, id.to_string()), method.to_owned());
            }
            (Some(method), None) => notification(from, method, params),
            (None, Some(id)) => {
                let method = self
                    .asked
                    .remove(&(from.other(), id.to_string()))
                    .unwrap_or_else(|| panic!("a response to no request: {msg}"));
                match msg.get("error") {
                    Some(error) => {
                        assert!(error["code"].is_i64(), "{msg}");
                        assert!(error["message"].is_string(), "{msg}");
                    }
                    None => response(from, &method, &msg["result"]),
                }
            }
            (None, None) => panic!("neither request nor response: {msg}"),
        }
    }
}

fn request(from: Side, method: &str, p: &Value) {
    match (from, method) {
        (Side::Client, "initialize") => conforms::<acp::InitializeRequest>(method, p),
        (Side::Client, "session/new") => conforms::<acp::NewSessionRequest>(method, p),
        (Side::Client, "session/load") => conforms::<acp::LoadSessionRequest>(method, p),
        (Side::Client, "session/resume") => conforms::<acp::ResumeSessionRequest>(method, p),
        (Side::Client, "session/prompt") => conforms::<acp::PromptRequest>(method, p),
        (Side::Client, "session/set_mode") => conforms::<acp::SetSessionModeRequest>(method, p),
        (Side::Client, "authenticate") => conforms::<acp::AuthenticateRequest>(method, p),
        (Side::Agent, "session/request_permission") => {
            conforms::<acp::RequestPermissionRequest>(method, p);
        }
        (Side::Agent, "elicitation/create") => conforms::<acp::CreateElicitationRequest>(method, p),
        (Side::Agent, "fs/read_text_file") => conforms::<acp::ReadTextFileRequest>(method, p),
        _ => panic!("{from:?} sent an unexpected request {method}: {p}"),
    }
}

fn notification(from: Side, method: &str, p: &Value) {
    match (from, method) {
        (Side::Client, "session/cancel") => conforms::<acp::CancelNotification>(method, p),
        (Side::Agent, "session/update") if p["update"]["sessionUpdate"] == "fake_future_update" => {
        }
        (Side::Agent, "session/update") => conforms::<acp::SessionNotification>(method, p),
        (Side::Agent, "elicitation/complete") => {
            conforms::<acp::CompleteElicitationNotification>(method, p);
        }
        (_, "$/cancel_request") => conforms::<acp::CancelRequestNotification>(method, p),
        _ => panic!("{from:?} sent an unexpected notification {method}: {p}"),
    }
}

fn response(from: Side, method: &str, r: &Value) {
    let what = format!("{method} result");
    match (from, method) {
        (Side::Agent, "initialize") => conforms::<acp::InitializeResponse>(&what, r),
        (Side::Agent, "session/new") => conforms::<acp::NewSessionResponse>(&what, r),
        (Side::Agent, "session/load") => conforms::<acp::LoadSessionResponse>(&what, r),
        (Side::Agent, "session/resume") => conforms::<acp::ResumeSessionResponse>(&what, r),
        (Side::Agent, "session/prompt") => conforms::<acp::PromptResponse>(&what, r),
        (Side::Agent, "session/set_mode") => conforms::<acp::SetSessionModeResponse>(&what, r),
        (Side::Agent, "authenticate") => conforms::<acp::AuthenticateResponse>(&what, r),
        (Side::Client, "session/request_permission") => {
            conforms::<acp::RequestPermissionResponse>(&what, r);
        }
        (Side::Client, "elicitation/create") => {
            conforms::<acp::CreateElicitationResponse>(&what, r)
        }
        _ => panic!("{from:?} answered {method} with a result: {r}"),
    }
}

/// Panics unless `v` decodes as `T` and encoding it again keeps everything `v` said: the
/// schema has a field for every key and accepts every value (fields that fall back to
/// their default on a bad value would otherwise hide one).
pub fn conforms<T: Serialize + DeserializeOwned>(what: &str, v: &Value) {
    let typed: T =
        serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{what}: {e}\n  {v}"));
    let back = serde_json::to_value(typed).unwrap();
    if let Err(at) = covers(v, &back, "") {
        panic!("{what}: {at} did not survive the schema\n  sent {v}\n  read {back}");
    }
}

/// Whether `back` says everything `sent` says, or the path where it does not. A key may
/// be missing from `back` only when its value is one the schema leaves out as a default:
/// null, false, an empty array or object, or a tool call's `pending` status or `other`
/// kind.
fn covers(sent: &Value, back: &Value, at: &str) -> Result<(), String> {
    match (sent, back) {
        (Value::Object(s), Value::Object(b)) => {
            for (k, v) in s {
                let at = format!("{at}.{k}");
                match b.get(k) {
                    Some(bv) => covers(v, bv, &at)?,
                    None if is_default(v) => {}
                    None => return Err(at),
                }
            }
            Ok(())
        }
        (Value::Array(s), Value::Array(b)) if s.len() == b.len() => s
            .iter()
            .zip(b)
            .enumerate()
            .try_for_each(|(i, (s, b))| covers(s, b, &format!("{at}[{i}]"))),
        (Value::Number(s), Value::Number(b)) if s.as_f64() == b.as_f64() => Ok(()),
        (s, b) if s == b => Ok(()),
        _ => Err(at.to_owned()),
    }
}

fn is_default(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => true,
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        Value::String(s) => s == "pending" || s == "other",
        _ => false,
    }
}
