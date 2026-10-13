//! Unified diffs: parsing, and applying hunks to a text with limited fuzz, all hunks
//! or none (§13.1 `--patch`).

use anyhow::{Result, bail};

/// The kind of one hunk line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Context,
    Del,
    Ins,
}

/// One hunk line: its text including the `\n`, absent only at the end of a file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Line {
    pub kind: Kind,
    pub text: String,
}

/// One `@@ -a,b +c,d @@` hunk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hunk {
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
    pub lines: Vec<Line>,
}

impl Hunk {
    /// The old-side lines (context and deletions) and the new-side lines (context and
    /// insertions) with up to `fuzz` context lines dropped at each end; also how many
    /// leading lines were dropped.
    fn sides(&self, fuzz: usize) -> (Vec<&str>, Vec<&str>, usize) {
        let lead = self
            .lines
            .iter()
            .take_while(|l| l.kind == Kind::Context)
            .count()
            .min(fuzz);
        let body = &self.lines[lead..];
        let trail = body
            .iter()
            .rev()
            .take_while(|l| l.kind == Kind::Context)
            .count()
            .min(fuzz)
            .min(body.len());
        let body = &body[..body.len() - trail];
        let old = body
            .iter()
            .filter(|l| l.kind != Kind::Ins)
            .map(|l| l.text.as_str())
            .collect();
        let new = body
            .iter()
            .filter(|l| l.kind != Kind::Del)
            .map(|l| l.text.as_str())
            .collect();
        (old, new, lead)
    }

    /// The hunk in unified-diff form.
    pub fn render(&self) -> String {
        let mut out = format!(
            "@@ -{},{} +{},{} @@\n",
            self.old_start, self.old_len, self.new_start, self.new_len
        );
        for line in &self.lines {
            out.push(match line.kind {
                Kind::Context => ' ',
                Kind::Del => '-',
                Kind::Ins => '+',
            });
            out.push_str(&line.text);
            if !line.text.ends_with('\n') {
                out.push_str("\n\\ No newline at end of file\n");
            }
        }
        out
    }
}

/// Parses `-a,b` or `+c,d` into (start, len); a missing len is 1.
fn parse_range(tok: &str, sign: char) -> Option<(usize, usize)> {
    let body = tok.strip_prefix(sign)?;
    match body.split_once(',') {
        Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
        None => Some((body.parse().ok()?, 1)),
    }
}

/// Strips one trailing `\n` or `\r\n`.
fn strip_eol(line: &str) -> &str {
    line.strip_suffix('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .unwrap_or(line)
}

/// Parses the hunks of a unified diff. File headers and anything between hunks are
/// skipped, so the output of `diff -u` and `git diff` for one file both work.
pub fn parse(src: &str) -> Result<Vec<Hunk>> {
    let raw: Vec<&str> = src.split_inclusive('\n').collect();
    let mut hunks = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let lineno = i + 1;
        let header = strip_eol(raw[i]);
        i += 1;
        let Some(rest) = header.strip_prefix("@@ ") else {
            continue;
        };
        let mut toks = rest.split_whitespace();
        let (Some(old), Some(new)) = (
            toks.next().and_then(|t| parse_range(t, '-')),
            toks.next().and_then(|t| parse_range(t, '+')),
        ) else {
            bail!("patch line {lineno}: bad hunk header {header:?}");
        };
        let mut hunk = Hunk {
            old_start: old.0,
            old_len: old.1,
            new_start: new.0,
            new_len: new.1,
            lines: Vec::new(),
        };
        let (mut seen_old, mut seen_new) = (0, 0);
        while i < raw.len() {
            let line = raw[i];
            if line.starts_with('\\') {
                if let Some(last) = hunk.lines.last_mut()
                    && last.text.ends_with('\n')
                {
                    last.text.pop();
                }
                i += 1;
                continue;
            }
            if seen_old >= hunk.old_len && seen_new >= hunk.new_len {
                break;
            }
            let body = strip_eol(line);
            let (kind, text) = match body.chars().next() {
                Some(' ') => (Kind::Context, &body[1..]),
                Some('-') => (Kind::Del, &body[1..]),
                Some('+') => (Kind::Ins, &body[1..]),
                None => (Kind::Context, ""),
                _ => bail!("patch line {}: unexpected inside a hunk: {body:?}", i + 1),
            };
            match kind {
                Kind::Context => {
                    seen_old += 1;
                    seen_new += 1;
                }
                Kind::Del => seen_old += 1,
                Kind::Ins => seen_new += 1,
            }
            hunk.lines.push(Line {
                kind,
                text: format!("{text}\n"),
            });
            i += 1;
        }
        if seen_old != hunk.old_len || seen_new != hunk.new_len {
            bail!(
                "patch line {lineno}: hunk {header:?} has {seen_old} old and {seen_new} new lines, header says {} and {}",
                hunk.old_len,
                hunk.new_len
            );
        }
        hunks.push(hunk);
    }
    if hunks.is_empty() {
        bail!("no hunks found in the patch");
    }
    Ok(hunks)
}

/// Where `old` matches in `lines`, searching outward from `target`.
fn find(lines: &[String], old: &[&str], target: usize) -> Option<usize> {
    let max_pos = lines.len().checked_sub(old.len())?;
    let target = target.min(max_pos);
    let matches = |pos: usize| {
        lines[pos..pos + old.len()]
            .iter()
            .zip(old)
            .all(|(a, b)| a == b)
    };
    for delta in 0..=max_pos.max(target) {
        if target + delta <= max_pos && matches(target + delta) {
            return Some(target + delta);
        }
        if delta <= target && delta > 0 && matches(target - delta) {
            return Some(target - delta);
        }
    }
    None
}

/// Applies every hunk to `text` with up to `max_fuzz` lines of fuzz, or returns the
/// hunks that did not apply (then nothing is applied).
pub fn apply(text: &str, hunks: &[Hunk], max_fuzz: usize) -> Result<String, Vec<Hunk>> {
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_owned).collect();
    let mut offset: isize = 0;
    let mut rejected = Vec::new();
    for hunk in hunks {
        // A hunk with no old lines names the line it follows; others their first line.
        let anchor = if hunk.old_len == 0 {
            hunk.old_start
        } else {
            hunk.old_start.saturating_sub(1)
        };
        let anchor = anchor.saturating_add_signed(offset);
        let placed = (0..=max_fuzz).find_map(|fuzz| {
            let (old, new, lead) = hunk.sides(fuzz);
            let pos = find(&lines, &old, anchor + lead)?;
            Some((pos, old.len(), new))
        });
        match placed {
            Some((pos, old_len, new)) => {
                let new_len = new.len();
                lines.splice(pos..pos + old_len, new.into_iter().map(str::to_owned));
                offset +=
                    isize::try_from(new_len).unwrap_or(0) - isize::try_from(old_len).unwrap_or(0);
            }
            None => rejected.push(hunk.clone()),
        }
    }
    if rejected.is_empty() {
        Ok(lines.concat())
    } else {
        Err(rejected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

    fn hunk(src: &str) -> Vec<Hunk> {
        parse(src).unwrap()
    }

    #[test]
    fn parses_headers_and_counts() {
        let p = "--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@ fn x()\n two\n-three\n+THREE\n four\n";
        let h = hunk(p);
        assert_eq!(h.len(), 1);
        assert_eq!(
            (h[0].old_start, h[0].old_len, h[0].new_start, h[0].new_len),
            (2, 3, 2, 3)
        );
        assert_eq!(
            h[0].lines[1],
            Line {
                kind: Kind::Del,
                text: "three\n".into()
            }
        );
        assert!(parse("no hunks here\n").is_err());
        assert!(parse("@@ -1,2 +1,2 @@\n a\n").is_err());
        assert!(parse("@@ -1 +1 @@\n-a\n+b\n").is_ok());
        assert!(
            parse("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -5,1 +5,1 @@\n-x\n+y\n").is_ok_and(|h| h.len() == 2)
        );
    }

    #[test]
    fn no_newline_marker_strips_terminator() {
        let p = "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n";
        let h = hunk(p);
        assert_eq!(h[0].lines[1].text, "b");
        assert_eq!(h[0].lines[2].text, "c\n");
        assert_eq!(apply("a\nb", &h, 0).unwrap(), "a\nc\n");
        let back = hunk("@@ -1,2 +1,2 @@\n a\n-c\n+b\n\\ No newline at end of file\n");
        assert_eq!(apply("a\nc\n", &back, 0).unwrap(), "a\nb");
        assert!(back[0].render().contains("\\ No newline"));
    }

    #[test]
    fn applies_in_place_and_tracks_offsets() {
        let p = "@@ -1,2 +1,3 @@\n one\n+one and a half\n two\n@@ -6,2 +7,1 @@\n six\n-seven\n";
        assert_eq!(
            apply(TEXT, &hunk(p), 0).unwrap(),
            "one\none and a half\ntwo\nthree\nfour\nfive\nsix\n"
        );
    }

    #[test]
    fn applies_with_offset_search() {
        // The hunk says line 2 but the text has two extra lines in front.
        let p = "@@ -2,3 +2,3 @@\n two\n-three\n+3\n four\n";
        let text = format!("zero\nminus\n{TEXT}");
        assert_eq!(
            apply(&text, &hunk(p), 0).unwrap(),
            "zero\nminus\none\ntwo\n3\nfour\nfive\nsix\nseven\n"
        );
    }

    #[test]
    fn fuzz_drops_context_up_to_the_limit() {
        // Both context lines are wrong; fuzz 1 drops them.
        let p = "@@ -2,3 +2,3 @@\n TWO\n-three\n+3\n FOUR\n";
        assert!(apply(TEXT, &hunk(p), 0).is_err());
        assert_eq!(
            apply(TEXT, &hunk(p), 1).unwrap(),
            "one\ntwo\n3\nfour\nfive\nsix\nseven\n"
        );
        // Three context lines each side, all wrong: fuzz 3 is needed, 2 is not enough.
        let p = "@@ -1,7 +1,7 @@\n A\n B\n C\n-four\n+4\n E\n F\n G\n";
        assert!(apply(TEXT, &hunk(p), 2).is_err());
        assert_eq!(
            apply(TEXT, &hunk(p), 3).unwrap(),
            "one\ntwo\nthree\n4\nfive\nsix\nseven\n"
        );
    }

    #[test]
    fn all_or_nothing_reports_rejects() {
        let p = "@@ -1,1 +1,1 @@\n-one\n+ONE\n@@ -4,1 +4,1 @@\n-nope\n+NOPE\n";
        let rej = apply(TEXT, &hunk(p), 3).unwrap_err();
        assert_eq!(rej.len(), 1);
        assert_eq!(rej[0].old_start, 4);
        assert_eq!(rej[0].render(), "@@ -4,1 +4,1 @@\n-nope\n+NOPE\n");
    }

    #[test]
    fn insertion_into_empty_and_at_end() {
        let p = "@@ -0,0 +1,2 @@\n+a\n+b\n";
        assert_eq!(apply("", &hunk(p), 0).unwrap(), "a\nb\n");
        let p = "@@ -7,0 +8,1 @@\n+eight\n";
        assert_eq!(apply(TEXT, &hunk(p), 0).unwrap(), format!("{TEXT}eight\n"));
    }

    #[test]
    fn crlf_patches_are_read_as_lf() {
        let p = "@@ -1,1 +1,1 @@\r\n-one\r\n+uno\r\n";
        assert_eq!(apply("one\n", &hunk(p), 0).unwrap(), "uno\n");
    }
}
