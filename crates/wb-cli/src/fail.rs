//! Failures with an exit code (spec §13.1) and how they are printed, as text on
//! stderr or as `{"error":{code,message}}` on stdout under `--json` (R13.4).

use std::fmt;
use std::process::ExitCode;

use serde_json::{Map, Value, json};

/// A failure that ends the command with `exit`.
#[derive(Debug)]
pub struct Fail {
    pub exit: u8,
    /// A §7.8 protocol code, a condition name or a wb-local word.
    pub code: String,
    pub message: String,
    /// Extra lines printed under the message in text mode.
    pub detail: Vec<String>,
    /// Extra fields of the `error` object in JSON mode.
    pub extra: Map<String, Value>,
}

impl Fail {
    pub fn new(exit: u8, code: &str, message: impl Into<String>) -> Fail {
        Fail {
            exit,
            code: code.to_owned(),
            message: message.into(),
            detail: Vec::new(),
            extra: Map::new(),
        }
    }

    /// A protocol `error{code, msg}` mapped to its exit code.
    pub fn protocol(code: &str, msg: &str) -> Fail {
        Fail::new(exit_for(code), code, msg)
    }

    pub fn detail(mut self, lines: Vec<String>) -> Fail {
        self.detail = lines;
        self
    }

    pub fn extra(mut self, key: &str, value: Value) -> Fail {
        self.extra.insert(key.to_owned(), value);
        self
    }
}

impl fmt::Display for Fail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Fail {}

/// The exit code of a §7.8 protocol error.
pub fn exit_for(code: &str) -> u8 {
    match code {
        "no_buffer" => 3,
        "read_only" | "refused_path" | "not_text" => 4,
        "stale_base" => 5,
        _ => 1,
    }
}

/// Prints `fail` the way the mode asks.
pub fn print(fail: &Fail, json: bool) {
    if json {
        let mut err = Map::new();
        err.insert("code".to_owned(), Value::String(fail.code.clone()));
        err.insert("message".to_owned(), Value::String(fail.message.clone()));
        for (k, v) in &fail.extra {
            err.insert(k.clone(), v.clone());
        }
        println!("{}", json!({ "error": err }));
    } else {
        eprintln!("wb: {}", fail.message);
        for line in &fail.detail {
            eprintln!("{line}");
        }
    }
}

/// Prints any error and gives the exit code: a `Fail`'s own, else 1.
pub fn report(err: &anyhow::Error, json: bool) -> ExitCode {
    match err.downcast_ref::<Fail>() {
        Some(fail) => {
            print(fail, json);
            ExitCode::from(fail.exit)
        }
        None => {
            print(&Fail::new(1, "error", format!("{err:#}")), json);
            ExitCode::from(1)
        }
    }
}
