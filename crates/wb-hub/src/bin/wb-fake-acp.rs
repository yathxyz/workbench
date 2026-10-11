//! Placeholder until the fake-agent work package replaces it.
#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("usage: wb-fake-acp [--scenario NAME]");
    ExitCode::from(2)
}
