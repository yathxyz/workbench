//! `wb eval` and `wb repl`: `call{form}` against the server image (§13.1).

use std::io::{BufRead, IsTerminal, Write};

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::args::EvalSource;
use crate::client::Client;
use crate::fail::{self, Fail};

/// Backtrace frames shown under a condition report.
const FRAMES: usize = 12;

/// The `Fail` of a `result.error` (a Scheme condition): exit 6 for `timeout`, else 1.
pub fn condition_fail(err: &Value) -> Fail {
    let condition = err["condition"].as_str().unwrap_or("error");
    let report = err["report"]
        .as_str()
        .map_or_else(|| err.to_string(), str::to_owned);
    let backtrace: Vec<String> = err["backtrace"]
        .as_array()
        .map(|frames| {
            frames
                .iter()
                .map(|f| f.as_str().map_or_else(|| f.to_string(), str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let exit = if condition == "timeout" { 6 } else { 1 };
    let mut detail: Vec<String> = backtrace
        .iter()
        .take(FRAMES)
        .map(|f| format!("  {f}"))
        .collect();
    if backtrace.len() > FRAMES {
        detail.push(format!("  … {} more frames", backtrace.len() - FRAMES));
    }
    Fail::new(exit, condition, format!("{condition}: {report}"))
        .detail(detail)
        .extra("backtrace", json!(backtrace))
        .extra(
            "restarts",
            err.get("restarts").cloned().unwrap_or(json!([])),
        )
}

/// Prints one evaluation `result`: its output, echo message and value, or the
/// condition as a `Fail`.
fn show(res: &Value, json: bool) -> Result<()> {
    if let Some(err) = res.get("error") {
        return Err(condition_fail(err).into());
    }
    if json {
        let mut obj = json!({"value": res["value"]});
        if let Some(out) = res.get("out") {
            obj["out"] = out.clone();
        }
        if let Some(msg) = res.get("msg") {
            obj["msg"] = msg.clone();
        }
        println!("{obj}");
        return Ok(());
    }
    let mut stdout = std::io::stdout().lock();
    if let Some(out) = res["out"].as_str()
        && !out.is_empty()
    {
        stdout.write_all(out.as_bytes())?;
        if !out.ends_with('\n') {
            stdout.write_all(b"\n")?;
        }
    }
    if let Some(msg) = res["msg"].as_str()
        && !msg.is_empty()
    {
        eprintln!("{msg}");
    }
    match &res["value"] {
        Value::String(s) => writeln!(stdout, "{s}")?,
        Value::Null => {}
        other => writeln!(stdout, "{other}")?,
    }
    stdout.flush()?;
    Ok(())
}

/// `wb eval FORM` / `wb eval -f FILE`.
pub fn eval(client: &mut Client, source: &EvalSource, json: bool) -> Result<()> {
    let form = match source {
        EvalSource::Form(form) => form.clone(),
        EvalSource::File(path) => {
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?
        }
    };
    let res = client.call_form(&form)?;
    show(&res, json)
}

/// Whether `src` has no unclosed parenthesis outside strings, comments and `#\(`.
pub fn balanced(src: &str) -> bool {
    let mut depth: i64 = 0;
    let mut chars = src.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            match c {
                '\\' => {
                    chars.next();
                }
                '"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            ';' => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            '#' if chars.peek() == Some(&'\\') => {
                chars.next();
                chars.next();
            }
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            _ => {}
        }
    }
    !in_string && depth <= 0
}

/// `wb repl`: one `call{form}` per complete form read from stdin.
pub fn repl(client: &mut Client, json: bool) -> Result<()> {
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();
    let mut pending = String::new();
    loop {
        if interactive {
            let mut out = std::io::stdout().lock();
            out.write_all(if pending.is_empty() { b"wb> " } else { b"... " })?;
            out.flush()?;
        }
        let mut line = String::new();
        if stdin.lock().read_line(&mut line).context("reading stdin")? == 0 {
            if interactive {
                println!();
            }
            return Ok(());
        }
        pending.push_str(&line);
        if !balanced(&pending) {
            continue;
        }
        let form = std::mem::take(&mut pending);
        if form.trim().is_empty() {
            continue;
        }
        let res = client.call_form(form.trim())?;
        if let Err(err) = show(&res, json) {
            match err.downcast_ref::<Fail>() {
                Some(fail) => fail::print(fail, json),
                None => return Err(err),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn balance_tracks_strings_comments_and_chars() {
        assert!(balanced("(+ 1 2)"));
        assert!(!balanced("(define (f x)"));
        assert!(balanced("(display \"a ) b\")"));
        assert!(!balanced("(display \"a ) b"));
        assert!(balanced("(f #\\( 1)"));
        assert!(balanced("(f ; (\n 1)"));
        assert!(balanced(")"));
        assert!(balanced(""));
    }

    #[test]
    fn condition_maps_to_exit_codes() {
        let f =
            condition_fail(&json!({"condition": "error", "report": "x", "backtrace": ["a", "b"]}));
        assert_eq!(f.exit, 1);
        assert_eq!(f.code, "error");
        assert_eq!(f.message, "error: x");
        assert_eq!(f.detail, vec!["  a", "  b"]);
        let f = condition_fail(&json!({"condition": "timeout", "report": "deadline"}));
        assert_eq!(f.exit, 6);
        assert_eq!(f.extra["backtrace"], json!([]));
    }
}
