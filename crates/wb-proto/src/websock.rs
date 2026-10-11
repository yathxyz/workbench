//! The `wb` CLI protocol on `web.sock`.
//!
//! Same framing as `hub.sock`. The server speaks first with [`WbMessage::Hello`]; the
//! client answers [`WbRequest::Hello`] and sends one [`WbRequest::Cmd`], which wb-web
//! runs in the leader page and answers with [`WbMessage::Ok`] or [`WbMessage::Err`].

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Protocol version carried by both hellos.
pub const PROTO: u32 = 1;

/// A line from the CLI to wb-web.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum WbRequest {
    #[serde(rename = "hello")]
    Hello { proto: u32, client: String },
    /// Run board tool `tool` with `input` in the leader page.
    #[serde(rename = "cmd")]
    Cmd {
        rid: u64,
        tool: String,
        input: Map<String, Value>,
        /// Seconds; absent means `CMD_TIMEOUT_DEFAULT`, clamped to `CMD_TIMEOUT_MAX`.
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    #[serde(other)]
    Unknown,
}

/// A line from wb-web to the CLI.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all_fields = "camelCase")]
pub enum WbMessage {
    #[serde(rename = "hello")]
    Hello {
        proto: u32,
        server: String,
        version: String,
    },
    /// The tool's result text.
    #[serde(rename = "ok")]
    Ok { rid: u64, result: String },
    /// `rid` is absent only when the request was too malformed to carry one.
    #[serde(rename = "err")]
    Err {
        #[serde(skip_serializing_if = "Option::is_none")]
        rid: Option<u64>,
        code: WbErrorCode,
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WbErrorCode {
    /// No page is connected.
    NoPage,
    /// The page did not answer within the timeout.
    Timeout,
    /// The leader page disconnected before answering; the call is never re-sent.
    PageGone,
    /// The tool reported an error.
    Tool,
    /// Malformed request.
    BadRequest,
    /// A code this version does not know.
    #[serde(other)]
    Unknown,
}
