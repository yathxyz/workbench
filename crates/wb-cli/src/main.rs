//! Placeholder until the CLI work package replaces it.
#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("usage: wb COMMAND [ARGS...]");
    ExitCode::from(2)
}
