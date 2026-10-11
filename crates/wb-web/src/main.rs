//! Placeholder until the web work package replaces it.
#![forbid(unsafe_code)]

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!("usage: wb-web --config PATH");
    ExitCode::from(2)
}
