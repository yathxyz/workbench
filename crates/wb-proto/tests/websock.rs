//! Every JSON example and message shape of the `web.sock` protocol round-trips unchanged.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use wb_proto::line;
use wb_proto::websock::*;

fn round_trip<T: Serialize + DeserializeOwned>(json: Value) -> T {
    let text = json.to_string();
    let parsed: T = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}: {text}"));
    let back: Value = serde_json::from_slice(&line::encode(&parsed)).unwrap();
    assert_eq!(back, json);
    parsed
}

#[test]
fn hellos() {
    let msg: WbMessage =
        round_trip(json!({"t": "hello", "proto": 1, "server": "wb-web", "version": "0.1.0"}));
    assert_eq!(
        msg,
        WbMessage::Hello {
            proto: PROTO,
            server: "wb-web".into(),
            version: "0.1.0".into()
        }
    );
    let req: WbRequest = round_trip(json!({"t": "hello", "proto": 1, "client": "wb/0.1.0"}));
    assert_eq!(
        req,
        WbRequest::Hello {
            proto: 1,
            client: "wb/0.1.0".into()
        }
    );
}

#[test]
fn cmd() {
    let req: WbRequest = round_trip(json!({
        "t": "cmd", "rid": 1, "tool": "read_node", "input": {"id": "n_1", "depth": 2}, "timeout": 60
    }));
    let WbRequest::Cmd {
        rid,
        tool,
        input,
        timeout,
    } = req
    else {
        panic!("{req:?}")
    };
    assert_eq!((rid, tool.as_str(), timeout), (1, "read_node", Some(60)));
    assert_eq!(input["depth"], 2);

    let req: WbRequest =
        round_trip(json!({"t": "cmd", "rid": 1, "tool": "list_tasks", "input": {}}));
    assert!(matches!(req, WbRequest::Cmd { timeout: None, .. }));
}

#[test]
fn replies() {
    let msg: WbMessage = round_trip(json!({"t": "ok", "rid": 1, "result": "node n_1: hello"}));
    assert_eq!(
        msg,
        WbMessage::Ok {
            rid: 1,
            result: "node n_1: hello".into()
        }
    );
    for (text, code) in [
        ("no_page", WbErrorCode::NoPage),
        ("timeout", WbErrorCode::Timeout),
        ("page_gone", WbErrorCode::PageGone),
        ("tool", WbErrorCode::Tool),
        ("bad_request", WbErrorCode::BadRequest),
    ] {
        let msg: WbMessage =
            round_trip(json!({"t": "err", "rid": 1, "code": text, "message": "failed"}));
        assert_eq!(
            msg,
            WbMessage::Err {
                rid: Some(1),
                code,
                message: "failed".into()
            }
        );
    }
    let msg: WbMessage =
        round_trip(json!({"t": "err", "code": "bad_request", "message": "not JSON"}));
    assert!(matches!(msg, WbMessage::Err { rid: None, .. }));
}

#[test]
fn unknown_t_values_and_fields() {
    let req: WbRequest = serde_json::from_str(r#"{"t":"subscribe","rid":2}"#).unwrap();
    assert_eq!(req, WbRequest::Unknown);
    let msg: WbMessage = serde_json::from_str(r#"{"t":"progress","rid":2,"pct":50}"#).unwrap();
    assert_eq!(msg, WbMessage::Unknown);

    let req: WbRequest = serde_json::from_str(
        r#"{"t":"cmd","rid":3,"tool":"t","input":{},"timeout":5,"trace":"x"}"#,
    )
    .unwrap();
    assert!(matches!(req, WbRequest::Cmd { rid: 3, .. }));
    let msg: WbMessage =
        serde_json::from_str(r#"{"t":"ok","rid":3,"result":"r","took":12}"#).unwrap();
    assert!(matches!(msg, WbMessage::Ok { rid: 3, .. }));
    let msg: WbMessage =
        serde_json::from_str(r#"{"t":"err","rid":3,"code":"quota","message":"m"}"#).unwrap();
    assert!(matches!(
        msg,
        WbMessage::Err {
            code: WbErrorCode::Unknown,
            ..
        }
    ));
}
