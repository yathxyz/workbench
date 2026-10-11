//! Placeholder until the hub work package replaces it.
#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("usage: wb-hub --config PATH");
    ExitCode::from(2)
}
