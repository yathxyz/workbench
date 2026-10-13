//! `wb edit FILE [+LINE] [--wait]`: `call{cmd:"server-edit"}` (§13.1).

use std::process::ExitCode;

use anyhow::Result;
use serde_json::json;

use crate::client::Client;
use crate::eval::condition_fail;
use crate::id;

/// Opens `file` in a frame; with `wait`, blocks until the buffer is finished and
/// exits 0 when it was saved, 1 when it was killed unsaved.
pub fn edit(
    client: &mut Client,
    file: &str,
    line: Option<u64>,
    wait: bool,
    json: bool,
) -> Result<ExitCode> {
    let buf = id::normalize(file);
    let res = client.call_cmd("server-edit", json!([buf, line]), json!({"wait": wait}))?;
    if let Some(err) = res.get("error") {
        return Err(condition_fail(err).into());
    }
    let value = &res["value"];
    if json {
        println!("{value}");
    }
    match value["exit"].as_u64() {
        Some(0) | None => Ok(ExitCode::SUCCESS),
        Some(code) => {
            if !json {
                eprintln!(
                    "wb: {}: edit finished without saving",
                    value["buf"].as_str().unwrap_or(&buf)
                );
            }
            Ok(ExitCode::from(u8::try_from(code).unwrap_or(1)))
        }
    }
}
