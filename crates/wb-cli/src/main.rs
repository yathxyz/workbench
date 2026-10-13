//! wb: the command-line client of edwind (spec §13.1). It speaks the edit protocol
//! (§7) over `edit.sock` to list, read and write live buffers, evaluate forms in the
//! server image and open files in a frame.
#![forbid(unsafe_code)]

mod args;
mod buf;
mod client;
mod diff;
mod edit;
mod eval;
mod fail;
mod id;
mod patch;
mod text;

use std::process::ExitCode;

use anyhow::Result;

use crate::args::{Args, Command};

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match args::parse(&argv) {
        Ok(args) => args,
        Err(usage) => {
            if !usage.0.is_empty() {
                eprintln!("wb: {}", usage.0);
            }
            eprint!("{}", args::USAGE);
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(code) => code,
        Err(err) => fail::report(&err, args.json),
    }
}

/// Runs one parsed command; the exit code of a command that completed its protocol
/// exchange but reports a non-zero status (`wb edit --wait` aborted) comes back as `Ok`.
fn run(args: &Args) -> Result<ExitCode> {
    let json = args.json;
    let mut client = client::connect()?;
    match &args.cmd {
        Command::BufLs => buf::ls(&mut client, json)?,
        Command::BufRead { name, lines, ver } => {
            buf::read(&mut client, name, lines.as_ref(), *ver, json)?;
        }
        Command::BufWrite { name, how, create } => {
            buf::write(&mut client, name, how, *create, json)?;
        }
        Command::BufSave { name } => buf::save(&mut client, name, "save", json)?,
        Command::BufRevert { name } => buf::save(&mut client, name, "revert", json)?,
        Command::Eval { source } => eval::eval(&mut client, source, json)?,
        Command::Edit { file, line, wait } => {
            return edit::edit(&mut client, file, *line, *wait, json);
        }
        Command::Repl => eval::repl(&mut client, json)?,
    }
    Ok(ExitCode::SUCCESS)
}
