//! PTY screen state: a vt100 parser per live session, its `replay` snapshot and its
//! `.snap` persistence form.

use std::fmt;
use std::panic::{AssertUnwindSafe, catch_unwind};

use anyhow::{Context, Result, bail};
use tracing::warn;
use wb_proto::limits::{CAPTURE_MAX, SNAPSHOT_MAX, VT_SCROLLBACK};

/// The first line of a `.snap` file is `wb-snap 1 <cols> <rows>`; the replay follows.
const SNAP_MAGIC: &str = "wb-snap 1";

/// The terminal state of one live PTY.
pub struct Vt {
    parser: vt100::Parser<Modes>,
}

/// What vt100 does not track itself.
#[derive(Default)]
struct Modes {
    /// Focus reporting (`CSI ? 1004 h`).
    focus: bool,
    /// Makes the next unhandled CSI panic, to test containment.
    #[cfg(test)]
    trip: bool,
}

impl vt100::Callbacks for Modes {
    fn unhandled_csi(
        &mut self,
        _: &mut vt100::Screen,
        i1: Option<u8>,
        _: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        #[cfg(test)]
        assert!(!self.trip, "tripped");
        // vt100 calls this for each parameter it does not handle, with all of them.
        if i1 == Some(b'?') && params.iter().any(|p| *p == [1004]) {
            match c {
                'h' => self.focus = true,
                'l' => self.focus = false,
                _ => {}
            }
        }
    }
}

/// The PTY size range (as for the kernel's winsize); vt100 needs at least 2 columns.
fn clamp(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(2, 1000), rows.clamp(1, 500))
}

fn parser(cols: u16, rows: u16) -> vt100::Parser<Modes> {
    let (cols, rows) = clamp(cols, rows);
    vt100::Parser::new_with_callbacks(rows, cols, VT_SCROLLBACK, Modes::default())
}

impl Vt {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            parser: parser(cols, rows),
        }
    }

    /// Whether a full-screen program has the alternate screen, so an attach should
    /// nudge it to repaint.
    pub fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    /// (cols, rows).
    fn size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols, rows)
    }

    /// Runs `f` on the parser. If vt100 panics, logs `what`, starts over with a blank
    /// parser of `size` and returns `None`: a parser bug must not end the session.
    fn guard<T>(
        &mut self,
        (cols, rows): (u16, u16),
        what: fmt::Arguments<'_>,
        f: impl FnOnce(&mut vt100::Parser<Modes>) -> T,
    ) -> Option<T> {
        match catch_unwind(AssertUnwindSafe(|| f(&mut self.parser))) {
            Ok(v) => Some(v),
            Err(_) => {
                warn!("vt100 panicked in {what}; the screen starts over blank");
                self.parser = parser(cols, rows);
                None
            }
        }
    }

    /// Feeds PTY output to the parser. A parser panic is contained here.
    pub fn feed(&mut self, text: &str) {
        let size = self.size();
        self.guard(size, format_args!("a feed of {} bytes", text.len()), |p| {
            p.process(text.as_bytes());
        });
    }

    /// Resizes the screen, applying the shrink rule first.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        let (cols, rows) = clamp(cols, rows);
        let (old_cols, old_rows) = self.size();
        if (old_cols, old_rows) == (cols, rows) {
            return;
        }
        self.guard(
            (cols, rows),
            format_args!("a resize to {cols}x{rows}"),
            |p| {
                if rows < old_rows {
                    // Feed the moves to a parser of its own, so that they cannot land
                    // inside a sequence the live parser is in the middle of.
                    let mut scratch = vt100::Parser::new(1, 1, 0);
                    std::mem::swap(scratch.screen_mut(), p.screen_mut());
                    if scratch.screen().alternate_screen() {
                        scratch.process(b"\x1b[?47l");
                        scroll_out(&mut scratch, rows);
                        scratch.process(b"\x1b[?47h");
                    }
                    scroll_out(&mut scratch, rows);
                    std::mem::swap(scratch.screen_mut(), p.screen_mut());
                }
                p.screen_mut().set_size(rows, cols);
            },
        );
    }

    /// The `replay` string: escape sequences that rebuild the screen, scrollback and
    /// modes in a fresh terminal of the same size. Over `SNAPSHOT_MAX` it carries fewer
    /// scrollback rows, halving them until it fits; the screen is never cut.
    pub fn snapshot(&mut self) -> String {
        let size = self.size();
        let out = self.guard(size, format_args!("a snapshot"), |p| {
            let mut budget = VT_SCROLLBACK;
            loop {
                let (out, n) = render(p, budget);
                if out.len() <= SNAPSHOT_MAX || n == 0 {
                    break out;
                }
                budget = n / 2;
            }
        });
        out.map(|out| {
            String::from_utf8(out)
                .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
        })
        .unwrap_or_default()
    }

    /// The plain text of the newest `lines` rows (at most `CAPTURE_MAX`), scrollback
    /// included, each right-trimmed. Blank rows below the last text are left out.
    pub fn capture(&mut self, lines: usize) -> String {
        let lines = lines.min(CAPTURE_MAX);
        let size = self.size();
        let text = self.guard(size, format_args!("a capture"), |p| {
            let s = p.screen_mut();
            let rows = usize::from(s.size().0);
            let mut text = Vec::new();
            s.set_scrollback(usize::MAX);
            let mut off = s.scrollback();
            while off > 0 {
                s.set_scrollback(off);
                let k = off.min(rows);
                text.extend(s.rows(0, u16::MAX).take(k));
                off -= k;
            }
            s.set_scrollback(0);
            text.extend(s.rows(0, u16::MAX));
            text
        });
        let mut text: Vec<String> = text
            .unwrap_or_default()
            .into_iter()
            .map(|row| row.trim_end().to_owned())
            .collect();
        while text.last().is_some_and(String::is_empty) {
            text.pop();
        }
        text[text.len().saturating_sub(lines)..].join("\n")
    }

    /// The `.snap` file contents: the header line `wb-snap 1 <cols> <rows>`, then the
    /// replay.
    #[expect(
        clippy::wrong_self_convention,
        reason = "rendering moves the scrollback view, so it needs `&mut self`"
    )]
    pub fn to_snap(&mut self) -> Vec<u8> {
        let (cols, rows) = self.size();
        let mut snap = format!("{SNAP_MAGIC} {cols} {rows}\n").into_bytes();
        snap.extend_from_slice(self.snapshot().as_bytes());
        snap
    }

    /// Restores a `Vt` from `.snap` file contents, at the size it was saved with.
    pub fn from_snap(snap: &[u8]) -> Result<Vt> {
        let snap = std::str::from_utf8(snap).context(".snap is not UTF-8")?;
        let (header, replay) = snap.split_once('\n').context(".snap has no header")?;
        let size = header
            .strip_prefix(SNAP_MAGIC)
            .and_then(|size| size.strip_prefix(' '))
            .and_then(|size| size.split_once(' '))
            .and_then(|(cols, rows)| Some((cols.parse().ok()?, rows.parse().ok()?)));
        let Some((cols, rows)) = size.filter(|&(cols, rows)| clamp(cols, rows) == (cols, rows))
        else {
            bail!(".snap header is not `{SNAP_MAGIC} <cols> <rows>` with a valid size");
        };
        let mut vt = Vt::new(cols, rows);
        vt.feed(replay);
        Ok(vt)
    }
}

/// The shrink rule: when the cursor would fall below the new last row, scroll the
/// screen up until the cursor's row is the last one, so the top rows go to the
/// scrollback (as xterm.js does) instead of vt100 cutting the bottom ones.
fn scroll_out(p: &mut vt100::Parser, rows: u16) {
    let (row, _) = p.screen().cursor_position();
    if row >= rows {
        let n = row - rows + 1;
        p.process(format!("\x1b[{n}S\x1b[{n}A").as_bytes());
    }
}

/// The replay with at most `budget` scrollback rows (10-hub §6.5), and how many it
/// holds.
fn render(p: &mut vt100::Parser<Modes>, budget: usize) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(64 << 10);
    let n = if p.screen().alternate_screen() {
        let mut primary = vt100::Parser::new(1, 1, 0);
        *primary.screen_mut() = p.screen().clone();
        primary.process(b"\x1b[?47l");
        let n = write_primary(primary.screen_mut(), budget, &mut out);
        // `?1049h` saves the pen with the cursor, and leaving restores both: give it
        // the pen vt100 saved on entering, which it restores on `?1049l`.
        primary.process(b"\x1b8");
        out.extend(primary.screen().attributes_formatted());
        out.extend_from_slice(b"\x1b[?1049h");
        out.extend(p.screen().contents_formatted());
        n
    } else {
        write_primary(p.screen_mut(), budget, &mut out)
    };
    out.extend(p.screen().input_mode_formatted());
    if p.callbacks().focus {
        out.extend_from_slice(b"\x1b[?1004h");
    }
    (out, n)
}

/// Writes up to `budget` scrollback rows of the primary screen, oldest first and one
/// screenful per scrollback window, pushes them into the terminal's scrollback, then
/// draws the screen with its cursor and pen. Returns how many scrollback rows it wrote.
fn write_primary(s: &mut vt100::Screen, budget: usize, out: &mut Vec<u8>) -> usize {
    let (rows, cols) = s.size();
    s.set_scrollback(usize::MAX);
    let n = s.scrollback().min(budget);
    let mut off = n;
    while off > 0 {
        s.set_scrollback(off);
        let k = off.min(usize::from(rows));
        for (i, row) in (0u16..).zip(s.rows_formatted(0, cols)).take(k) {
            out.extend(row);
            // No background colour erase bleeding onto the next row.
            out.extend_from_slice(b"\x1b[m");
            // `rows_formatted` starts each window as if at column 0 of a fresh row, so
            // a window's last row always ends with a line break; the terminal wraps
            // the other soft-wrapped rows itself.
            if usize::from(i) + 1 == k || !s.row_wrapped(i) {
                out.extend_from_slice(b"\r\n");
            }
        }
        off -= k;
    }
    s.set_scrollback(0);
    if n > 0 {
        // Scroll the last rows written off the screen.
        for _ in 1..rows {
            out.extend_from_slice(b"\r\n");
        }
    }
    out.extend(s.contents_formatted());
    n
}

#[cfg(test)]
mod tests {
    use vt100::{MouseProtocolEncoding, MouseProtocolMode};

    use super::*;
    use crate::pty::out::OutStream;

    /// A fixture under `tests/fixtures/vt/`: escaped text with `\e`, `\a`, `\r`, `\n`,
    /// `\t` and `\\`, whose real line breaks only split it for reading.
    macro_rules! fixture {
        ($name:literal) => {
            unescape(include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/vt/",
                $name
            )))
        };
    }

    fn unescape(text: &str) -> String {
        let mut out = String::new();
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            match c {
                '\n' => {}
                '\\' => out.push(match chars.next() {
                    Some('e') => '\x1b',
                    Some('a') => '\x07',
                    Some('r') => '\r',
                    Some('n') => '\n',
                    Some('t') => '\t',
                    Some('\\') => '\\',
                    other => panic!("unknown fixture escape {other:?}"),
                }),
                c => out.push(c),
            }
        }
        out
    }

    fn screen(vt: &Vt) -> &vt100::Screen {
        vt.parser.screen()
    }

    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8(bytes).unwrap()
    }

    fn numbered(lines: usize) -> String {
        (0..lines).map(|i| format!("line {i}\r\n")).collect()
    }

    fn visible(vt: &Vt) -> Vec<String> {
        screen(vt).rows(0, u16::MAX).collect()
    }

    /// Every scrollback row of the active screen, oldest first: its cells and whether
    /// it wraps.
    fn scrollback(vt: &mut Vt) -> Vec<(Vec<Option<vt100::Cell>>, bool)> {
        let s = vt.parser.screen_mut();
        let cols = s.size().1;
        s.set_scrollback(usize::MAX);
        let rows = (1..=s.scrollback())
            .rev()
            .map(|off| {
                s.set_scrollback(off);
                let cells = (0..cols).map(|col| s.cell(0, col).cloned()).collect();
                (cells, s.row_wrapped(0))
            })
            .collect();
        s.set_scrollback(0);
        rows
    }

    fn scrollback_text(vt: &mut Vt) -> Vec<String> {
        let rows = scrollback(vt);
        rows.iter()
            .map(|(cells, _)| {
                cells
                    .iter()
                    .map(|cell| cell.as_ref().map_or("", |cell| cell.contents()))
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    /// Checks that `back`, restored from `vt`'s snapshot, holds the same state. A soft
    /// wrap may turn into a line break only at the end of a snapshot window.
    fn assert_same(vt: &mut Vt, back: &mut Vt) {
        let (a, b) = (screen(vt), screen(back));
        assert_eq!(a.size(), b.size());
        assert_eq!(text(a.contents_formatted()), text(b.contents_formatted()));
        assert_eq!(
            text(a.input_mode_formatted()),
            text(b.input_mode_formatted())
        );
        assert_eq!(
            text(a.attributes_formatted()),
            text(b.attributes_formatted())
        );
        assert_eq!(a.cursor_position(), b.cursor_position());
        assert_eq!(a.hide_cursor(), b.hide_cursor());
        assert_eq!(a.alternate_screen(), b.alternate_screen());
        assert_eq!(vt.parser.callbacks().focus, back.parser.callbacks().focus);
        let rows = a.size().0;
        for row in 0..rows {
            assert_eq!(a.row_wrapped(row), b.row_wrapped(row), "wrap of row {row}");
        }
        let (ours, theirs) = (scrollback(vt), scrollback(back));
        assert_eq!(ours.len(), theirs.len());
        let mut lost = 0;
        for (i, (ours, theirs)) in ours.iter().zip(&theirs).enumerate() {
            assert_eq!(ours.0, theirs.0, "scrollback row {i}");
            if ours.1 != theirs.1 {
                assert!(ours.1, "scrollback row {i} gained a wrap");
                lost += 1;
            }
        }
        assert!(
            lost <= theirs.len().div_ceil(usize::from(rows)),
            "{lost} wraps lost"
        );
    }

    /// The scrollback rows, before the snapshot's first screen clear, move the cursor
    /// only relative to where it is: no CUP.
    fn assert_no_cup_in_scrollback(snap: &str) {
        let head = &snap[..snap.find("\x1b[H\x1b[J").expect("a screen clear")];
        for (i, _) in head.match_indices("\x1b[") {
            let rest = head[i + 2..].trim_start_matches(|c: char| c.is_ascii_digit() || c == ';');
            assert!(
                !rest.starts_with('H'),
                "CUP at byte {i} of the scrollback rows"
            );
        }
    }

    /// Feeds `input` to a Vt, restores another from its snapshot and checks that both
    /// match, then again after both leave the alternate screen if it was on.
    fn round_trip(cols: u16, rows: u16, input: &str) -> (Vt, Vt) {
        let mut vt = Vt::new(cols, rows);
        vt.feed(input);
        let snap = vt.snapshot();
        assert_no_cup_in_scrollback(&snap);
        let mut back = Vt::new(cols, rows);
        back.feed(&snap);
        assert_same(&mut vt, &mut back);
        if vt.alternate_screen() {
            vt.feed("\x1b[?1049l");
            back.feed("\x1b[?1049l");
            assert_same(&mut vt, &mut back);
        }
        (vt, back)
    }

    #[test]
    fn sgr_colours_and_wide_characters_round_trip() {
        let (mut vt, _) = round_trip(80, 24, &fixture!("sgr.txt"));
        assert!(
            scrollback_text(&mut vt)
                .iter()
                .any(|row| row.contains("truecolor"))
        );
        assert!(screen(&vt).bold());
    }

    #[test]
    fn soft_wraps_round_trip_except_at_the_end_of_a_window() {
        let (mut vt, mut back) = round_trip(20, 6, &fixture!("wrap.txt"));
        let wraps = |vt: &mut Vt| {
            let rows = scrollback(vt);
            (0..rows.len()).filter(|&i| rows[i].1).collect::<Vec<_>>()
        };
        // 15 scrollback rows go out in windows of 6, 6 and 3 rows. Rows 5 and 14 end
        // a window, row 8 is inside one.
        assert_eq!(wraps(&mut vt), [5, 8, 14]);
        assert_eq!(wraps(&mut back), [8]);
        assert!(screen(&back).row_wrapped(1));
        assert_eq!(
            scrollback_text(&mut back)[5..=10],
            [
                "BBBBBBBBBBBBBBBBBBB5",
                "bbbbbbbbb6",
                "c7",
                "CCCCCCCCCCCCCCCCCCC8",
                "   x9",
                "DDDDDDDDDDDDDDDDDD10"
            ]
        );
    }

    #[test]
    fn the_alternate_screen_round_trips_with_the_primary_kept() {
        let input = fixture!("alt.txt");
        let mut vt = Vt::new(80, 24);
        vt.feed(&input);
        assert!(vt.alternate_screen());
        assert!(vt.snapshot().contains("\x1b[?1049h"));
        let (_, mut back) = round_trip(80, 24, &input);
        assert!(!back.alternate_screen());
        assert_eq!(visible(&back)[22], "$ edit notes.txt");
        assert_eq!(scrollback_text(&mut back).len(), 8);
    }

    #[test]
    fn input_modes_and_focus_reporting_round_trip() {
        let (_, back) = round_trip(80, 24, &fixture!("modes.txt"));
        let s = screen(&back);
        assert!(s.bracketed_paste() && s.application_cursor() && s.application_keypad());
        assert!(s.hide_cursor());
        assert_eq!(s.mouse_protocol_mode(), MouseProtocolMode::AnyMotion);
        assert_eq!(s.mouse_protocol_encoding(), MouseProtocolEncoding::Utf8);
        assert_eq!(s.cursor_position(), (9, 25));
        assert!(back.parser.callbacks().focus);
    }

    #[test]
    fn every_mouse_mode_and_encoding_round_trips() {
        let modes = [
            (9, MouseProtocolMode::Press),
            (1000, MouseProtocolMode::PressRelease),
            (1002, MouseProtocolMode::ButtonMotion),
            (1003, MouseProtocolMode::AnyMotion),
        ];
        let encodings = [
            ("", MouseProtocolEncoding::Default),
            ("\x1b[?1005h", MouseProtocolEncoding::Utf8),
            ("\x1b[?1006h", MouseProtocolEncoding::Sgr),
        ];
        for (mode, want_mode) in modes {
            for (encoding, want_encoding) in encodings {
                let (_, back) = round_trip(20, 5, &format!("\x1b[?{mode}h{encoding}"));
                assert_eq!(screen(&back).mouse_protocol_mode(), want_mode);
                assert_eq!(screen(&back).mouse_protocol_encoding(), want_encoding);
            }
        }
    }

    #[test]
    fn focus_reporting_follows_the_last_change() {
        let mut vt = Vt::new(20, 5);
        vt.feed("\x1b[?25;1004h");
        assert!(vt.snapshot().ends_with("\x1b[?1004h"));
        vt.feed("\x1b[?1004l");
        assert!(!vt.snapshot().contains("1004"));
    }

    #[test]
    fn a_3000_line_scrollback_round_trips_its_newest_rows() {
        let (mut vt, _) = round_trip(80, 24, &numbered(3000));
        let rows = scrollback_text(&mut vt);
        assert_eq!(rows.len(), VT_SCROLLBACK);
        assert_eq!(rows[0], "line 1977");
        assert_eq!(rows[VT_SCROLLBACK - 1], "line 2976");
    }

    #[test]
    fn an_oversized_snapshot_halves_its_scrollback() {
        let (cols, rows) = (160u16, 24u16);
        let mut input = String::new();
        for r in 0..VT_SCROLLBACK + usize::from(rows) {
            for c in 0..usize::from(cols) {
                input += &format!(
                    "\x1b[38;2;{};{};200;48;2;{};{};100m{}",
                    100 + c % 100,
                    100 + r % 100,
                    200 + c % 50,
                    100 + (c + r) % 100,
                    char::from(b'a' + (c % 26) as u8),
                );
            }
            input += "\r\n";
        }
        let mut vt = Vt::new(cols, rows);
        vt.feed(&input);
        assert!(render(&mut vt.parser, VT_SCROLLBACK).0.len() > SNAPSHOT_MAX);
        let snap = vt.snapshot();
        assert!(snap.len() <= SNAPSHOT_MAX);
        let mut back = Vt::new(cols, rows);
        back.feed(&snap);
        let (ours, theirs) = (scrollback(&mut vt), scrollback(&mut back));
        assert_eq!(theirs.len(), VT_SCROLLBACK / 2);
        assert!(ours[ours.len() - theirs.len()..] == theirs[..]);
        assert_eq!(
            text(screen(&vt).contents_formatted()),
            text(screen(&back).contents_formatted())
        );
    }

    #[test]
    fn shrinking_keeps_the_newest_rows() {
        let mut vt = Vt::new(20, 10);
        vt.feed("L0\r\nL1\r\nL2\r\nL3\r\nL4\r\nL5\r\nL6\r\nL7\r\nL8\r\nL9");
        vt.resize(20, 4);
        assert_eq!(visible(&vt), ["L6", "L7", "L8", "L9"]);
        assert_eq!(
            scrollback_text(&mut vt),
            ["L0", "L1", "L2", "L3", "L4", "L5"]
        );
        assert_eq!(screen(&vt).cursor_position(), (3, 2));
    }

    #[test]
    fn shrinking_with_the_cursor_above_the_cut_drops_blank_rows() {
        let mut vt = Vt::new(20, 10);
        vt.feed("L0\r\nL1\r\nL2");
        vt.resize(20, 4);
        assert_eq!(visible(&vt), ["L0", "L1", "L2", ""]);
        assert!(scrollback(&mut vt).is_empty());
        assert_eq!(screen(&vt).cursor_position(), (2, 2));
    }

    #[test]
    fn shrinking_on_the_alternate_screen_keeps_the_newest_rows_of_both() {
        let mut vt = Vt::new(20, 10);
        vt.feed("L0\r\nL1\r\nL2\r\nL3\r\nL4\r\nL5\r\nL6\r\nL7\r\nL8\r\nL9");
        vt.feed("\x1b[?1049hA0\r\nA1\r\nA2\r\nA3\r\nA4\r\nA5\r\nA6\r\nA7\r\nA8\r\nA9");
        vt.resize(20, 4);
        assert_eq!(visible(&vt), ["A6", "A7", "A8", "A9"]);
        vt.feed("\x1b[?1049l");
        assert_eq!(visible(&vt), ["L6", "L7", "L8", "L9"]);
        assert_eq!(
            scrollback_text(&mut vt),
            ["L0", "L1", "L2", "L3", "L4", "L5"]
        );
        assert_eq!(screen(&vt).cursor_position(), (3, 2));
    }

    #[test]
    fn resizing_to_the_same_size_keeps_soft_wraps() {
        let mut vt = Vt::new(10, 3);
        vt.feed("0123456789ab");
        vt.resize(10, 3);
        assert!(screen(&vt).row_wrapped(0));
    }

    #[test]
    fn sizes_are_clamped_to_the_pty_range() {
        let mut vt = Vt::new(0, 0);
        assert_eq!(screen(&vt).size(), (1, 2));
        vt.resize(5000, 5000);
        assert_eq!(screen(&vt).size(), (500, 1000));
    }

    #[test]
    fn a_snapshot_between_reads_never_splits_an_escape_sequence() {
        let stream =
            "\x1b[1;31mred\x1b]0;title\x07\x1b[38;2;1;2;3m漢\x1bP1$r\x1b\\x\x1b[?2004hy\x1b[m";
        let mut whole = Vt::new(20, 5);
        whole.feed(stream);
        let stream = stream.as_bytes();
        for split in 0..=stream.len() {
            let mut out = OutStream::new();
            let mut vt = Vt::new(20, 5);
            if let Some(d) = out.push(&stream[..split]) {
                vt.feed(&d);
            }
            let snap = vt.snapshot();
            let rest: String = out
                .push(&stream[split..])
                .into_iter()
                .chain(out.flush())
                .collect();
            vt.feed(&rest);
            let mut back = Vt::new(20, 5);
            back.feed(&snap);
            back.feed(&rest);
            assert_same(&mut vt, &mut back);
            assert_same(&mut whole, &mut back);
        }
    }

    #[test]
    fn capture_is_right_trimmed_without_trailing_blank_rows() {
        let mut vt = Vt::new(20, 5);
        vt.feed("a  \r\n\r\n  b \x1b[44m\x1b[K\x1b[m\r\n");
        assert_eq!(vt.capture(10), "a\n\n  b");
        assert_eq!(vt.capture(2), "\n  b");
        assert_eq!(vt.capture(0), "");
    }

    #[test]
    fn capture_reaches_into_the_scrollback_up_to_capture_max() {
        let mut vt = Vt::new(80, 24);
        vt.feed(&numbered(3000));
        let all = vt.capture(usize::MAX);
        assert_eq!(all.lines().count(), CAPTURE_MAX);
        assert_eq!(all.lines().next(), Some("line 2000"));
        assert_eq!(vt.capture(3), "line 2997\nline 2998\nline 2999");
        assert_eq!(screen(&vt).scrollback(), 0);
    }

    #[test]
    fn capture_on_the_alternate_screen_is_what_is_visible() {
        let mut vt = Vt::new(20, 3);
        vt.feed("shell\r\n\r\n\r\nmore\x1b[?1049hfull screen");
        assert_eq!(vt.capture(10), "full screen");
    }

    #[test]
    fn a_snap_restores_the_same_state() {
        for (input, cols, rows) in [
            (fixture!("alt.txt"), 80, 24),
            (fixture!("modes.txt"), 80, 24),
            (fixture!("wrap.txt"), 20, 6),
        ] {
            let mut vt = Vt::new(cols, rows);
            vt.feed(&input);
            let snap = vt.to_snap();
            assert!(snap.starts_with(format!("wb-snap 1 {cols} {rows}\n").as_bytes()));
            let mut back = Vt::from_snap(&snap).unwrap();
            assert_eq!(back.snapshot(), vt.snapshot());
        }
    }

    #[test]
    fn a_bad_snap_is_an_error() {
        for snap in [
            &b""[..],
            b"wb-snap 1 80 24",
            b"wb-snap 2 80 24\n",
            b"wb-snap 1 80\n",
            b"wb-snap 1 x 24\n",
            b"wb-snap 1 80 24 1\n",
            b"wb-snap 1 0 0\n",
            b"wb-snap 1 1001 24\n",
            b"wb-snap 1 80 501\n",
            b"wb-snap 1 80 24\n\xff",
        ] {
            assert!(Vt::from_snap(snap).is_err(), "{}", snap.escape_ascii());
        }
        let mut vt = Vt::from_snap(b"wb-snap 1 30 7\n").unwrap();
        assert_eq!(screen(&vt).size(), (7, 30));
        assert_eq!(vt.capture(10), "");
    }

    #[test]
    fn a_parser_panic_leaves_a_blank_screen_of_the_same_size() {
        let mut vt = Vt::new(30, 7);
        vt.feed("before\x1b[?1004h");
        vt.parser.callbacks_mut().trip = true;
        vt.feed("\x1b[5y");
        assert_eq!(screen(&vt).size(), (7, 30));
        assert_eq!(vt.capture(10), "");
        assert!(!vt.parser.callbacks().focus);
        vt.feed("after");
        assert_eq!(vt.capture(10), "after");
        assert!(vt.snapshot().contains("after"));
    }
}
