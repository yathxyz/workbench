//! The JSON-RPC envelope between the hub and an agent (10-hub §7.2): how a message from
//! the agent is classified, and every message the hub builds. The tests check each
//! built message against the ACP schema crate by round trip (H-18).

use serde_json::{Map, Value, json};

/// The only ACP version the hub speaks.
pub const PROTOCOL_VERSION: u64 = 1;

/// A message from the agent.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    /// An agent-to-client request; `id` is a number or a string, echoed verbatim.
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    /// The answer to a hub request: the `result`, or the `error` object.
    Response {
        id: u64,
        outcome: Result<Value, Value>,
    },
    /// Logged and dropped, for this reason.
    Dropped(&'static str),
    /// Not JSON-RPC; it goes to the stderr log.
    Junk(Map<String, Value>),
}

/// Sorts one JSON object from the agent. `jsonrpc` is not required.
pub fn classify(mut m: Map<String, Value>) -> Incoming {
    let method = m.get("method").and_then(Value::as_str).map(str::to_owned);
    let has_reply = m.contains_key("result") || m.contains_key("error");
    let id = m.get("id");
    let params = |m: &mut Map<String, Value>| m.remove("params").unwrap_or(Value::Null);
    match (method, id) {
        (Some(_), Some(Value::Null)) => Incoming::Dropped("a request with a null id"),
        (Some(method), Some(Value::Number(_) | Value::String(_))) => Incoming::Request {
            id: m.remove("id").unwrap_or_default(),
            params: params(&mut m),
            method,
        },
        (Some(method), None) => Incoming::Notification {
            params: params(&mut m),
            method,
        },
        (None, Some(id)) if has_reply && !m.contains_key("method") => {
            let Some(id) = id.as_u64() else {
                return Incoming::Dropped("a response to an id the hub never sent");
            };
            let outcome = match m.remove("error") {
                Some(error) => Err(error),
                None => Ok(m.remove("result").unwrap_or_default()),
            };
            Incoming::Response { id, outcome }
        }
        _ => Incoming::Junk(m),
    }
}

/// One message as a line for the agent's stdin.
pub fn encode(msg: &Value) -> Vec<u8> {
    let mut line = msg.to_string().into_bytes();
    line.push(b'\n');
    line
}

fn request(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

/// `initialize`: no file system, no terminal, no terminal auth; form and url
/// elicitation.
pub fn initialize(id: u64) -> Value {
    let params = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientInfo": {"name": "workbench", "version": env!("CARGO_PKG_VERSION")},
        "clientCapabilities": {
            "fs": {"readTextFile": false, "writeTextFile": false},
            "terminal": false,
            "auth": {"terminal": false},
            "elicitation": {"form": {}, "url": {}}
        }
    });
    request(id, "initialize", params)
}

pub fn new_session(id: u64, cwd: &str) -> Value {
    request(id, "session/new", json!({"cwd": cwd, "mcpServers": []}))
}

/// `mcpServers` is left out: the schema makes it optional for resume and never writes
/// it empty.
pub fn resume_session(id: u64, session_id: &str, cwd: &str) -> Value {
    request(
        id,
        "session/resume",
        json!({"sessionId": session_id, "cwd": cwd}),
    )
}

pub fn load_session(id: u64, session_id: &str, cwd: &str) -> Value {
    let params = json!({"sessionId": session_id, "cwd": cwd, "mcpServers": []});
    request(id, "session/load", params)
}

pub fn prompt(id: u64, session_id: &str, blocks: Vec<Value>) -> Value {
    let params = json!({"sessionId": session_id, "prompt": blocks});
    request(id, "session/prompt", params)
}

pub fn set_mode(id: u64, session_id: &str, mode_id: &str) -> Value {
    let params = json!({"sessionId": session_id, "modeId": mode_id});
    request(id, "session/set_mode", params)
}

pub fn authenticate(id: u64, method_id: &str) -> Value {
    request(id, "authenticate", json!({"methodId": method_id}))
}

pub fn close_session(id: u64, session_id: &str) -> Value {
    request(id, "session/close", json!({"sessionId": session_id}))
}

pub fn cancel(session_id: &str) -> Value {
    json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}})
}

/// The answer to an agent request.
pub fn result(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub fn method_not_found(id: &Value) -> Value {
    let error = json!({"code": -32601, "message": "Method not found"});
    json!({"jsonrpc": "2.0", "id": id, "error": error})
}

/// The `session/request_permission` result for an outcome
/// (`{"outcome":"selected","optionId":…}` or `{"outcome":"cancelled"}`).
pub fn permission_result(outcome: &Value) -> Value {
    json!({"outcome": outcome})
}

/// The permission outcome that cancels.
pub fn permission_cancelled() -> Value {
    json!({"outcome": "cancelled"})
}

/// The elicitation response that cancels.
pub fn elicitation_cancelled() -> Value {
    json!({"action": "cancel"})
}

#[cfg(test)]
mod tests {
    use agent_client_protocol_schema::rpc::Response;
    use agent_client_protocol_schema::v1::{
        AuthenticateRequest, CancelNotification, CloseSessionRequest, CreateElicitationResponse,
        Error, InitializeRequest, JsonRpcMessage, LoadSessionRequest, NewSessionRequest,
        Notification, PromptRequest, Request, RequestPermissionResponse, ResumeSessionRequest,
        SetSessionModeRequest,
    };
    use serde::Serialize;
    use serde::de::DeserializeOwned;

    use super::*;

    /// H-18: `msg` deserializes into `T` and serializes back to exactly `msg`, so no
    /// field is misnamed, missing or ignored.
    fn round_trip<T: DeserializeOwned + Serialize>(msg: &Value) {
        let typed: T = serde_json::from_value(msg.clone())
            .unwrap_or_else(|e| panic!("{msg} does not deserialize: {e}"));
        assert_eq!(&serde_json::to_value(&typed).unwrap(), msg);
    }

    type Req<T> = JsonRpcMessage<Request<T>>;
    type Resp<T> = JsonRpcMessage<Response<T, Error>>;

    #[test]
    fn hub_requests_conform() {
        let init = initialize(1);
        round_trip::<Req<InitializeRequest>>(&init);
        let caps = &init["params"]["clientCapabilities"];
        assert!(caps["elicitation"]["form"].is_object());
        assert!(caps["elicitation"]["url"].is_object());
        assert_eq!(
            caps["fs"],
            json!({"readTextFile": false, "writeTextFile": false})
        );
        assert_eq!(caps["terminal"], json!(false));

        round_trip::<Req<NewSessionRequest>>(&new_session(2, "/home/alice/proj"));
        round_trip::<Req<ResumeSessionRequest>>(&resume_session(2, "s-1", "/home/alice"));
        round_trip::<Req<LoadSessionRequest>>(&load_session(3, "s-1", "/home/alice"));
        round_trip::<Req<SetSessionModeRequest>>(&set_mode(4, "s-1", "plan"));
        round_trip::<Req<AuthenticateRequest>>(&authenticate(5, "login"));
        round_trip::<Req<CloseSessionRequest>>(&close_session(6, "s-1"));
        round_trip::<JsonRpcMessage<Notification<CancelNotification>>>(&cancel("s-1"));
    }

    #[test]
    fn prompts_conform() {
        let blocks = vec![
            json!({"type": "text", "text": "fix the test"}),
            json!({"type": "resource_link", "uri": "file:///home/alice/a.rs", "name": "a.rs"}),
            json!({"type": "image", "data": "aGk=", "mimeType": "image/png"}),
            json!({"type": "audio", "data": "aGk=", "mimeType": "audio/wav"}),
            json!({"type": "resource", "resource": {"uri": "file:///home/alice/b.rs", "text": "fn b() {}"}}),
        ];
        round_trip::<Req<PromptRequest>>(&prompt(7, "s-1", blocks));
    }

    #[test]
    fn hub_responses_conform() {
        for id in [json!(12), json!("req-a")] {
            let selected = json!({"outcome": "selected", "optionId": "allow_once"});
            round_trip::<Resp<RequestPermissionResponse>>(&result(
                &id,
                permission_result(&selected),
            ));
            let cancelled = permission_result(&permission_cancelled());
            round_trip::<Resp<RequestPermissionResponse>>(&result(&id, cancelled));
            let accept = json!({"action": "accept", "content": {"name": "x", "n": 3, "ok": true, "tags": ["a", "b"]}});
            for response in [
                accept,
                json!({"action": "decline"}),
                elicitation_cancelled(),
            ] {
                round_trip::<Resp<CreateElicitationResponse>>(&result(&id, response));
            }
            round_trip::<Resp<Value>>(&method_not_found(&id));
        }
    }

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => unreachable!(),
        }
    }

    #[test]
    fn classifies() {
        let req = classify(obj(
            json!({"jsonrpc": "2.0", "id": "a", "method": "fs/read_text_file", "params": {"path": "/x"}}),
        ));
        assert_eq!(
            req,
            Incoming::Request {
                id: json!("a"),
                method: "fs/read_text_file".into(),
                params: json!({"path": "/x"}),
            }
        );
        let req = classify(obj(
            json!({"id": 4, "method": "session/request_permission"}),
        ));
        assert!(matches!(req, Incoming::Request { id, params: Value::Null, .. } if id == json!(4)));
        assert_eq!(
            classify(obj(json!({"id": null, "method": "x"}))),
            Incoming::Dropped("a request with a null id")
        );
        assert_eq!(
            classify(obj(json!({"method": "session/update", "params": {"u": 1}}))),
            Incoming::Notification {
                method: "session/update".into(),
                params: json!({"u": 1}),
            }
        );
        assert_eq!(
            classify(obj(
                json!({"jsonrpc": "2.0", "id": 3, "result": {"sessionId": "s"}})
            )),
            Incoming::Response {
                id: 3,
                outcome: Ok(json!({"sessionId": "s"})),
            }
        );
        assert_eq!(
            classify(obj(json!({"id": 3, "result": null}))),
            Incoming::Response {
                id: 3,
                outcome: Ok(Value::Null),
            }
        );
        let error = json!({"code": -32000, "message": "auth"});
        assert_eq!(
            classify(obj(json!({"id": 9, "error": error}))),
            Incoming::Response {
                id: 9,
                outcome: Err(error),
            }
        );
        assert!(matches!(
            classify(obj(json!({"id": "s", "result": {}}))),
            Incoming::Dropped(_)
        ));
        for junk in [
            json!({"id": 1}),
            json!({"hello": "world"}),
            json!({"method": 7, "id": 1}),
            json!({"id": {"x": 1}, "method": "m"}),
        ] {
            assert!(
                matches!(classify(obj(junk.clone())), Incoming::Junk(_)),
                "{junk}"
            );
        }
    }

    #[test]
    fn encodes_one_line() {
        let line = encode(&cancel("s\n1"));
        assert_eq!(line.iter().filter(|&&b| b == b'\n').count(), 1);
        assert_eq!(line.last(), Some(&b'\n'));
    }
}
