//! The Anthropic Messages client behind `/rpc` `sample` arrives with M5; until then
//! `sample` is off.

/// Whether `/rpc` serves `sample`.
pub fn enabled() -> bool {
    false
}
