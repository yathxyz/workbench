//! PTY output: the streaming decoder with its escape-tail holdback, and the byte ring.

use std::collections::VecDeque;

use wb_proto::limits::ESC_HOLDBACK_MAX;

/// Decodes PTY bytes into text across reads, holding back what the next read may still
/// change, so that the parser, the ring and the viewers all see the same chunks and a
/// snapshot taken between two reads never ends inside a sequence:
/// - an incomplete UTF-8 sequence at the end of a read (at most 3 bytes) is held for the
///   next one; an invalid sequence becomes U+FFFD;
/// - an unterminated ESC, CSI, OSC, DCS, SOS, PM or APC sequence at the end of a read is
///   held as well, up to `ESC_HOLDBACK_MAX` bytes. A longer one is released as is.
#[derive(Default)]
pub struct OutStream {
    /// Unreleased bytes in stream order: an escape tail (valid UTF-8), then an
    /// incomplete character.
    held: Vec<u8>,
}

impl OutStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// The text of `bytes`, after any held tail; `None` if nothing is ready.
    pub fn push(&mut self, bytes: &[u8]) -> Option<String> {
        let joined;
        let mut rest = if self.held.is_empty() {
            bytes
        } else {
            joined = [std::mem::take(&mut self.held).as_slice(), bytes].concat();
            &joined[..]
        };
        let mut text = String::with_capacity(rest.len());
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    text.push_str(valid);
                    break;
                }
                Err(e) => {
                    let (valid, after) = rest.split_at(e.valid_up_to());
                    text.push_str(&String::from_utf8_lossy(valid));
                    match e.error_len() {
                        Some(bad) => {
                            text.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[bad..];
                        }
                        None => {
                            self.held = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        if let Some(start) = unterminated_escape(&text)
            && text.len() - start <= ESC_HOLDBACK_MAX
        {
            let mut held = text.split_off(start).into_bytes();
            held.append(&mut self.held);
            self.held = held;
        }
        (!text.is_empty()).then_some(text)
    }

    /// Releases a held escape tail as is, for when no output followed it for a while or
    /// the output ended. An incomplete character stays held: it cannot be shown, and the
    /// next read either completes it or turns it into U+FFFD.
    pub fn flush(&mut self) -> Option<String> {
        let valid = match std::str::from_utf8(&self.held) {
            Ok(all) => all.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid == 0 {
            return None;
        }
        let partial = self.held.split_off(valid);
        String::from_utf8(std::mem::replace(&mut self.held, partial)).ok()
    }
}

/// Where the escape sequence that is still open at the end of `text` starts, if any.
///
/// As in vte, ESC starts a new sequence from any state and CAN or SUB ends any, so only
/// the bytes after the last ESC matter. Inside a sequence, other C0 controls are
/// executed without ending it.
fn unterminated_escape(text: &str) -> Option<usize> {
    #[derive(Clone, Copy)]
    enum Seq {
        Esc,
        Intermediate,
        Csi,
        Osc,
        /// DCS, SOS, PM and APC, which only ST (an ESC) ends.
        Str,
    }
    let start = text.rfind('\x1b')?;
    let mut seq = Seq::Esc;
    for &b in &text.as_bytes()[start + 1..] {
        seq = match (seq, b) {
            (_, 0x18 | 0x1a) => return None,
            (Seq::Esc, b'[') => Seq::Csi,
            (Seq::Esc, b']') => Seq::Osc,
            (Seq::Esc, b'P' | b'X' | b'^' | b'_') => Seq::Str,
            (Seq::Esc, 0x20..=0x2f) => Seq::Intermediate,
            (Seq::Esc | Seq::Intermediate, 0x30..=0x7e)
            | (Seq::Csi, 0x40..=0x7e)
            | (Seq::Osc, 0x07) => return None,
            (seq, _) => seq,
        };
    }
    Some(start)
}

/// The newest output of one PTY actor instance, at most `cap` bytes of UTF-8, with
/// offsets counted from the start of the stream. The oldest bytes fall out at a
/// character boundary.
pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    end: u64,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap),
            cap,
            end: 0,
        }
    }

    /// Appends `d` and returns the stream offset after it.
    pub fn push(&mut self, d: &str) -> u64 {
        self.buf.extend(d.as_bytes());
        self.end += d.len() as u64;
        if self.buf.len() > self.cap {
            let mut cut = self.buf.len() - self.cap;
            while self.buf.get(cut).is_some_and(|&b| b & 0xC0 == 0x80) {
                cut += 1;
            }
            self.buf.drain(..cut);
        }
        self.end
    }

    /// The stream offset after the newest byte.
    pub fn end(&self) -> u64 {
        self.end
    }

    /// The text after stream offset `from`, or `None` if the ring no longer holds it or
    /// `from` is not at a character boundary.
    pub fn since(&self, from: u64) -> Option<String> {
        let start = self.end - self.buf.len() as u64;
        if from < start || from > self.end {
            return None;
        }
        let skip = usize::try_from(from - start).ok()?;
        if self.buf.get(skip).is_some_and(|&b| b & 0xC0 == 0x80) {
            return None;
        }
        String::from_utf8(self.buf.range(skip..).copied().collect()).ok()
    }

    /// Everything the ring holds.
    #[cfg(test)]
    pub fn text(&self) -> String {
        let (a, b) = self.buf.as_slices();
        let bytes = [a, b].concat();
        String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pushes `input` split at `cut` and returns the released chunks, the flush last.
    fn chunks_split_at(input: &[u8], cut: usize) -> Vec<String> {
        let mut s = OutStream::default();
        let mut chunks: Vec<String> = [s.push(&input[..cut]), s.push(&input[cut..])]
            .into_iter()
            .flatten()
            .collect();
        chunks.extend(s.flush());
        chunks
    }

    #[test]
    fn a_split_character_is_held_at_every_offset() {
        let input = "a😀b€c".as_bytes();
        for cut in 0..=input.len() {
            let mut s = OutStream::default();
            let mut text = s.push(&input[..cut]).unwrap_or_default();
            text += &s.push(&input[cut..]).unwrap_or_default();
            assert_eq!(text, "a😀b€c", "cut at {cut}");
            assert_eq!(s.flush(), None);
        }
    }

    #[test]
    fn a_four_byte_character_split_into_single_bytes() {
        let mut s = OutStream::default();
        let bytes = "😀".as_bytes();
        assert_eq!(s.push(&bytes[..1]), None);
        assert_eq!(s.push(&bytes[1..2]), None);
        assert_eq!(s.push(&bytes[2..3]), None);
        assert_eq!(s.push(&bytes[3..]).as_deref(), Some("😀"));
    }

    #[test]
    fn invalid_bytes_become_replacement_characters() {
        let mut s = OutStream::default();
        assert_eq!(
            s.push(b"a\xffb\xc3(c").as_deref(),
            Some("a\u{fffd}b\u{fffd}(c")
        );
        assert_eq!(s.push(b"\xe2\x82").as_deref(), None);
        assert_eq!(s.push(b"x").as_deref(), Some("\u{fffd}x"));
    }

    #[test]
    fn flush_keeps_an_incomplete_character_for_the_next_read() {
        let mut s = OutStream::default();
        assert_eq!(s.push(b"ok\xe2\x82").as_deref(), Some("ok"));
        assert_eq!(s.flush(), None);
        assert_eq!(s.push(b"\xac!").as_deref(), Some("€!"));
        assert_eq!(s.push(b"\xe2\x82").as_deref(), None);
        assert_eq!(s.push(b"x").as_deref(), Some("\u{fffd}x"));
    }

    #[test]
    fn never_panics_on_arbitrary_bytes() {
        // Mostly ESC, sequence introducers and finals, so that the holdback runs too.
        let alphabet = b"\x1b[]P;0m\x07\x18\\\xe2\x82\xac\xffa";
        let mut x: u32 = 0x1234_5678;
        let mut s = OutStream::default();
        let mut released = 0;
        for _ in 0..2000 {
            let len = (x % 7) as usize;
            let chunk: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    alphabet[x as usize % alphabet.len()]
                })
                .collect();
            released += s.push(&chunk).map_or(0, |d| d.len());
            if x.is_multiple_of(4) {
                released += s.flush().map_or(0, |d| d.len());
            }
        }
        assert!(released > 0);
    }

    #[test]
    fn an_escape_sequence_is_never_split_at_any_offset() {
        let input = "a\x1b[38;2;10;20;30mb\x1b]0;tï\x07c\x1b]8;;x\x1b\\d\x1b(Be\x1bPq#0\x1b\\f\x1b7g\x1b[?2004h"
            .as_bytes();
        for cut in 0..=input.len() {
            let chunks = chunks_split_at(input, cut);
            assert_eq!(chunks.concat().as_bytes(), input, "cut at {cut}");
            let mut seen = 0;
            for (i, chunk) in chunks.iter().enumerate() {
                // Every chunk ends where the unsplit stream is outside any sequence, or
                // the next chunk starts with ESC, which starts over from any state: no
                // chunk starts inside a sequence.
                seen += chunk.len();
                let prefix = std::str::from_utf8(&input[..seen]).unwrap();
                let next_starts_over = chunks.get(i + 1).is_some_and(|c| c.starts_with('\x1b'));
                assert!(
                    unterminated_escape(prefix).is_none() || next_starts_over,
                    "cut at {cut}: {chunks:?}"
                );
            }
        }
    }

    #[test]
    fn a_held_escape_tail_is_released_with_its_end() {
        let mut s = OutStream::default();
        assert_eq!(s.push(b"red: \x1b[38;5;1").as_deref(), Some("red: "));
        assert_eq!(s.push(b"2mX").as_deref(), Some("\x1b[38;5;12mX"));
        assert_eq!(s.push(b"\x1b").as_deref(), None);
        assert_eq!(s.push(b"[").as_deref(), None);
        assert_eq!(s.push(b"K").as_deref(), Some("\x1b[K"));
    }

    #[test]
    fn strings_end_only_at_their_terminators() {
        let mut s = OutStream::default();
        // OSC ends at BEL or ST. An ESC ends it as well and starts a new sequence,
        // which is what is held then.
        assert_eq!(s.push(b"\x1b]0;title").as_deref(), None);
        assert_eq!(s.push(b" more\x1b").as_deref(), Some("\x1b]0;title more"));
        assert_eq!(s.push(b"\\after").as_deref(), Some("\x1b\\after"));
        assert_eq!(s.push(b"\x1b]2;t\x07").as_deref(), Some("\x1b]2;t\x07"));
        // BEL does not end a DCS, ST does.
        assert_eq!(s.push(b"\x1bPq#0;2\x07").as_deref(), None);
        assert_eq!(s.push(b"\x1b\\").as_deref(), Some("\x1bPq#0;2\x07\x1b\\"));
        // CAN and SUB abort any sequence.
        assert_eq!(s.push(b"\x1b[3\x18x").as_deref(), Some("\x1b[3\x18x"));
        assert_eq!(s.push(b"\x1b]0;t\x1a").as_deref(), Some("\x1b]0;t\x1a"));
        // A C0 control inside a CSI is executed without ending it.
        assert_eq!(s.push(b"\x1b[1\r").as_deref(), None);
        assert_eq!(s.push(b"m").as_deref(), Some("\x1b[1\rm"));
        // Two- and three-byte escapes.
        assert_eq!(s.push(b"\x1b7\x1b(").as_deref(), Some("\x1b7"));
        assert_eq!(s.push(b"B").as_deref(), Some("\x1b(B"));
    }

    #[test]
    fn a_held_tail_keeps_a_split_character_after_it() {
        let mut s = OutStream::default();
        let input = "\x1b]0;café\x07".as_bytes();
        let cut = input.len() - 2;
        assert_eq!(s.push(&input[..cut]), None);
        assert_eq!(s.push(&input[cut..]).as_deref(), Some("\x1b]0;café\x07"));
    }

    #[test]
    fn a_tail_over_the_holdback_limit_is_released_as_is() {
        let mut s = OutStream::default();
        let head = "\x1b]52;c;".to_owned() + &"A".repeat(ESC_HOLDBACK_MAX - 7);
        assert_eq!(head.len(), ESC_HOLDBACK_MAX);
        assert_eq!(s.push(head.as_bytes()), None);
        let more = s.push(b"B").unwrap();
        assert_eq!(more.len(), ESC_HOLDBACK_MAX + 1);
        // The rest of the oversized sequence no longer counts as a sequence start.
        assert_eq!(s.push(b"CC\x07z").as_deref(), Some("CC\x07z"));
    }

    #[test]
    fn flush_releases_a_held_escape_tail_as_is() {
        let mut s = OutStream::default();
        assert_eq!(s.push(b"x\x1b[2").as_deref(), Some("x"));
        assert_eq!(s.flush().as_deref(), Some("\x1b[2"));
        assert_eq!(s.flush(), None);
        assert_eq!(s.push(b"J").as_deref(), Some("J"));
        // An escape tail followed by an incomplete character: the tail goes, the
        // character stays for the next read.
        assert_eq!(s.push(b"\x1b]0;\xe2\x82").as_deref(), None);
        assert_eq!(s.flush().as_deref(), Some("\x1b]0;"));
        assert_eq!(s.push(b"\xac\x07").as_deref(), Some("€\x07"));
    }

    #[test]
    fn ring_offsets_count_utf8_bytes() {
        let mut r = Ring::new(64);
        assert_eq!(r.push("ab"), 2);
        assert_eq!(r.push("\u{fffd}"), 5);
        assert_eq!(r.end(), 5);
        assert_eq!(r.text(), "ab\u{fffd}");
        assert_eq!(r.since(0).as_deref(), Some("ab\u{fffd}"));
        assert_eq!(r.since(2).as_deref(), Some("\u{fffd}"));
        assert_eq!(r.since(5).as_deref(), Some(""));
        // Inside the replacement character, or past the end.
        assert_eq!(r.since(3), None);
        assert_eq!(r.since(4), None);
        assert_eq!(r.since(6), None);
    }

    #[test]
    fn ring_wraps_and_keeps_the_newest_bytes() {
        let mut r = Ring::new(8);
        r.push("0123456789");
        assert_eq!(r.text(), "23456789");
        assert_eq!(r.push("ab"), 12);
        assert_eq!(r.text(), "456789ab");
        assert_eq!(r.since(3), None);
        assert_eq!(r.since(4).as_deref(), Some("456789ab"));
        assert_eq!(r.since(10).as_deref(), Some("ab"));
        assert_eq!(r.since(12).as_deref(), Some(""));
        assert_eq!(r.since(13), None);
    }

    #[test]
    fn ring_cuts_at_a_character_boundary() {
        let mut r = Ring::new(5);
        // "a€€" is 7 bytes; keeping 5 would start inside the first euro sign.
        r.push("a€€");
        assert_eq!(r.text(), "€");
        assert_eq!(r.end(), 7);
        assert_eq!(r.since(3), None);
        assert_eq!(r.since(4).as_deref(), Some("€"));
        r.push("é");
        assert_eq!(r.text(), "€é");
        assert_eq!(r.since(7).as_deref(), Some("é"));
        assert_eq!(r.since(8), None);
    }
}
