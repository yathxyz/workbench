//! `wb buf …`: list, read, write (append, replace, patch), save and revert (§13.1).

use std::io::{Read, Write};

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::args::{Input, LineRange, WriteHow};
use crate::client::Client;
use crate::fail::Fail;
use crate::text::{Op, len16};
use crate::{diff, id, patch, text};

/// Lines of fuzz allowed when a patch is applied without `--base`.
const FUZZ: usize = 3;

fn print_json(v: &Value) {
    println!("{v}");
}

/// Reads the text of a write: a file, or stdin for `-`. `\r\n` becomes `\n` (R7.8).
fn read_input(input: &Input) -> Result<String> {
    let raw = match input {
        Input::Stdin => {
            let mut s = String::new();
            std::io::stdin()
                .read_to_string(&mut s)
                .context("reading stdin")?;
            s
        }
        Input::File(path) => {
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?
        }
    };
    Ok(if raw.contains("\r\n") {
        raw.replace("\r\n", "\n")
    } else {
        raw
    })
}

/// `wb buf ls`.
pub fn ls(client: &mut Client, json: bool) -> Result<()> {
    let res = client.call_cmd("buffer-list", json!([]), json!({}))?;
    if let Some(err) = res.get("error") {
        return Err(crate::eval::condition_fail(err).into());
    }
    let list = res["value"].as_array().cloned().unwrap_or_default();
    if json {
        print_json(&json!({ "buffers": list }));
        return Ok(());
    }
    let mut out = std::io::stdout().lock();
    for b in &list {
        let modified = if b["modified"].as_bool().unwrap_or(false) {
            "modified"
        } else {
            "saved"
        };
        let writers = b["writers"].as_array().map_or(0, Vec::len);
        writeln!(
            out,
            "{}\t{}\t{}\t{}\t{}",
            b["id"].as_str().unwrap_or("?"),
            b["name"].as_str().unwrap_or(""),
            b["mode"].as_str().unwrap_or(""),
            modified,
            writers
        )?;
    }
    Ok(())
}

/// Lines `range` of `text`, 1-based and inclusive, with their terminators.
fn select_lines(text: &str, range: &LineRange) -> String {
    text.split_inclusive('\n')
        .skip(range.from - 1)
        .take(range.to.map_or(usize::MAX, |to| to + 1 - range.from))
        .collect()
}

/// `wb buf read NAME`.
pub fn read(
    client: &mut Client,
    name: &str,
    lines: Option<&LineRange>,
    ver: bool,
    json: bool,
) -> Result<()> {
    let buf = id::normalize(name);
    let opened = client.open(&buf, None, false)?;
    client.close(&buf)?;
    let text = opened.text.unwrap_or_default();
    let shown = match lines {
        Some(range) => select_lines(&text, range),
        None => text,
    };
    if ver {
        eprintln!("{}", opened.ver);
    }
    if json {
        let mut obj = json!({"buf": buf, "ver": opened.ver, "text": shown, "meta": opened.meta});
        if let Some(range) = lines {
            obj["lines"] = json!([range.from, range.to]);
        }
        print_json(&obj);
    } else {
        let mut out = std::io::stdout().lock();
        out.write_all(shown.as_bytes())?;
        out.flush()?;
    }
    Ok(())
}

/// `wb buf write NAME …`.
pub fn write(
    client: &mut Client,
    name: &str,
    how: &WriteHow,
    create: bool,
    json: bool,
) -> Result<()> {
    let buf = id::normalize(name);
    let (base, ops, canon) = match how {
        WriteHow::Append(input) => {
            let new = read_input(input)?;
            let opened = client.open(&buf, None, create)?;
            let live = opened.text.unwrap_or_default();
            let ops = if new.is_empty() {
                Vec::new()
            } else {
                vec![Op::new(len16(&live), "", new)]
            };
            (opened.ver, ops, opened.id)
        }
        WriteHow::Replace(input) => {
            let new = read_input(input)?;
            let opened = client.open(&buf, None, create)?;
            let live = opened.text.unwrap_or_default();
            (opened.ver, diff::diff_ops(&live, &new), opened.id)
        }
        WriteHow::Patch { input, base } => {
            let hunks = patch::parse(&read_input(input)?)?;
            let opened = client.open(&buf, None, create)?;
            let live = opened.text.unwrap_or_default();
            let (base_text, base_ver) = match *base {
                None => (live, opened.ver),
                Some(ver) if ver == opened.ver => (live, ver),
                Some(ver) if ver > opened.ver => {
                    return Err(Fail::new(
                        1,
                        "bad_base",
                        format!(
                            "--base {ver} is newer than the buffer (version {})",
                            opened.ver
                        ),
                    )
                    .into());
                }
                Some(ver) => (text_at(client, &buf, &live, opened.ver, ver)?, ver),
            };
            let new = patch::apply(&base_text, &hunks, FUZZ).map_err(|rejected| {
                let rendered: Vec<String> = rejected.iter().map(patch::Hunk::render).collect();
                Fail::new(
                    5,
                    "patch_rejected",
                    format!(
                        "{} of {} hunk(s) did not apply; nothing was changed",
                        rejected.len(),
                        hunks.len()
                    ),
                )
                .detail(rendered.iter().map(|h| h.trim_end().to_owned()).collect())
                .extra("rejects", json!(rendered))
            })?;
            (base_ver, diff::diff_ops(&base_text, &new), opened.id)
        }
    };
    let ver = client.edit(&canon, base, &ops)?;
    client.close(&canon)?;
    if json {
        print_json(&json!({"buf": canon, "ver": ver, "ops": ops.len()}));
    }
    Ok(())
}

/// The buffer's text at `want`, rebuilt from the text at `have` and the history
/// `open{since: want}` replays; `stale_base` (exit 5) when the history is gone.
fn text_at(client: &mut Client, buf: &str, live: &str, have: u64, want: u64) -> Result<String> {
    let hist = client.open(buf, Some(want), false)?;
    if hist.text.is_some() {
        return Err(Fail::new(
            5,
            "stale_base",
            format!("version {want} is older than the history edwind retains (stale_base)"),
        )
        .into());
    }
    let batches: Vec<text::Batch> = hist
        .edits
        .into_iter()
        .filter(|b| b.ver > want && b.ver <= have)
        .collect();
    let expected = usize::try_from(have - want).unwrap_or(usize::MAX);
    if batches.len() != expected {
        return Err(Fail::new(
            5,
            "stale_base",
            format!(
                "history from version {want} to {have} is incomplete ({} of {expected} batches)",
                batches.len()
            ),
        )
        .into());
    }
    text::rewind(live, &batches).with_context(|| format!("rebuilding the text at version {want}"))
}

/// `wb buf save NAME` and `wb buf revert NAME` (`what` is the message `t`).
pub fn save(client: &mut Client, name: &str, what: &str, json: bool) -> Result<()> {
    let buf = id::normalize(name);
    let res = client.request(json!({"t": what, "buf": buf}))?;
    if let Some(err) = res.get("error") {
        return Err(crate::eval::condition_fail(err).into());
    }
    if json {
        print_json(&res["value"]);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_lines_is_one_based_inclusive() {
        let t = "a\nb\nc\nd";
        let r = |from, to| select_lines(t, &LineRange { from, to });
        assert_eq!(r(2, Some(3)), "b\nc\n");
        assert_eq!(r(1, Some(1)), "a\n");
        assert_eq!(r(3, None), "c\nd");
        assert_eq!(r(4, Some(9)), "d");
        assert_eq!(r(5, None), "");
    }
}
