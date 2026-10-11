//! Wire types shared by the hub, the web front and the `wb` CLI.
//!
//! Every message is one compact JSON object per line ([`line`]). Field names are
//! camelCase, the message discriminator is the key `t`, enum values are snake_case
//! strings, and times are integer milliseconds since the Unix epoch. Receivers ignore
//! unknown fields; an unknown `t` or enum value decodes as the `Unknown` variant.
#![forbid(unsafe_code)]

pub mod hub;
pub mod journal;
pub mod limits;
pub mod line;
pub mod state;
pub mod websock;
