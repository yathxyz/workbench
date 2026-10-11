//! PTY output: the streaming UTF-8 decoder and the byte ring.

use std::collections::VecDeque;

/// Decodes PTY bytes into text across reads. An incomplete UTF-8 sequence at the end of
/// a read (at most 3 bytes) is held for the next one; an invalid sequence becomes
/// U+FFFD.
#[derive(Default)]
pub struct OutStream {
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
        (!text.is_empty()).then_some(text)
    }

    /// Releases the held tail, which can no longer be completed, as U+FFFD.
    pub fn flush(&mut self) -> Option<String> {
        if self.held.is_empty() {
            return None;
        }
        self.held.clear();
        Some(char::REPLACEMENT_CHARACTER.to_string())
    }
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

    /// The text after stream offset `from`, or `None` if the ring no longer holds it.
    pub fn since(&self, from: u64) -> Option<String> {
        todo!("M1-H1: ring text since {from} of {}", self.end)
    }

    /// Everything the ring holds.
    pub fn text(&self) -> String {
        let (a, b) = self.buf.as_slices();
        let bytes = [a, b].concat();
        String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn flush_releases_a_held_tail() {
        let mut s = OutStream::default();
        assert_eq!(s.push(b"ok\xe2\x82").as_deref(), Some("ok"));
        assert_eq!(s.flush().as_deref(), Some("\u{fffd}"));
        assert_eq!(s.flush(), None);
    }

    #[test]
    fn never_panics_on_arbitrary_bytes() {
        let mut x: u32 = 0x1234_5678;
        let mut s = OutStream::default();
        for _ in 0..2000 {
            let len = (x % 7) as usize;
            let chunk: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    x as u8
                })
                .collect();
            let _ = s.push(&chunk);
        }
        let _ = s.flush();
    }

    #[test]
    fn ring_offsets_count_utf8_bytes() {
        let mut r = Ring::new(64);
        assert_eq!(r.push("ab"), 2);
        assert_eq!(r.push("\u{fffd}"), 5);
        assert_eq!(r.end(), 5);
        assert_eq!(r.text(), "ab\u{fffd}");
    }

    #[test]
    fn ring_wraps_and_keeps_the_newest_bytes() {
        let mut r = Ring::new(8);
        r.push("0123456789");
        assert_eq!(r.text(), "23456789");
        assert_eq!(r.push("ab"), 12);
        assert_eq!(r.text(), "456789ab");
    }

    #[test]
    fn ring_cuts_at_a_character_boundary() {
        let mut r = Ring::new(5);
        // "a€€" is 7 bytes; keeping 5 would start inside the first euro sign.
        r.push("a€€");
        assert_eq!(r.text(), "€");
        assert_eq!(r.end(), 7);
        r.push("é");
        assert_eq!(r.text(), "€é");
    }
}
