//! The tolerant line reader for agent stdout (10-hub deviation 1). One bad line, an
//! invalid byte or an over-long line, must not look like the agent closing stdout, so
//! this reads bytes rather than UTF-8 and skips what it cannot keep.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    /// One line without its `\n` and without one trailing `\r`.
    Line(Vec<u8>),
    /// A line longer than the cap was discarded up to its `\n`; its length in bytes.
    Oversize(usize),
    Eof,
}

/// Reads the next line of at most `max` bytes. A longer line is discarded up to the
/// next `\n` and reported as [`Read::Oversize`], so memory stays bounded by `max`. A
/// last line without a `\n` before end of input is still returned.
pub async fn read_line_capped<R: AsyncBufRead + Unpin>(r: &mut R, max: usize) -> io::Result<Read> {
    let mut line = Vec::new();
    // Bytes discarded so far; nonzero once the line went over `max`.
    let mut over = 0;
    loop {
        let buf = r.fill_buf().await?;
        if buf.is_empty() {
            return Ok(match (over, line.is_empty()) {
                (0, true) => Read::Eof,
                (0, false) => Read::Line(strip_cr(line)),
                (n, _) => Read::Oversize(n),
            });
        }
        let newline = buf.iter().position(|&b| b == b'\n');
        let chunk = &buf[..newline.unwrap_or(buf.len())];
        if over == 0 && line.len() + chunk.len() <= max {
            line.extend_from_slice(chunk);
        } else {
            over += line.len() + chunk.len();
            line = Vec::new();
        }
        let used = chunk.len() + usize::from(newline.is_some());
        r.consume(used);
        if newline.is_some() {
            return Ok(match over {
                0 => Read::Line(strip_cr(line)),
                n => Read::Oversize(n),
            });
        }
    }
}

fn strip_cr(mut line: Vec<u8>) -> Vec<u8> {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    line
}

#[cfg(test)]
mod tests {
    use tokio::io::BufReader;

    use super::*;

    /// Every read of `input` through a buffer of `cap` bytes, up to and including `Eof`.
    async fn all(input: &[u8], cap: usize, max: usize) -> Vec<Read> {
        let mut r = BufReader::with_capacity(cap, input);
        let mut out = Vec::new();
        loop {
            let read = read_line_capped(&mut r, max).await.unwrap();
            let end = read == Read::Eof;
            out.push(read);
            if end {
                return out;
            }
        }
    }

    fn line(s: &str) -> Read {
        Read::Line(s.as_bytes().to_vec())
    }

    #[tokio::test]
    async fn lines_and_crlf() {
        for cap in [1, 2, 3, 64] {
            let got = all(b"{\"a\":1}\r\nplain\n\n\r\r\nlast", cap, 16).await;
            let want = vec![
                line("{\"a\":1}"),
                line("plain"),
                line(""),
                line("\r"),
                line("last"),
                Read::Eof,
            ];
            assert_eq!(got, want, "buffer of {cap}");
        }
    }

    #[tokio::test]
    async fn oversize_is_skipped_to_the_newline() {
        for cap in [1, 4, 64] {
            let got = all(b"12345\n123456\nok\n1234567", cap, 5).await;
            let want = vec![
                line("12345"),
                Read::Oversize(6),
                line("ok"),
                Read::Oversize(7),
                Read::Eof,
            ];
            assert_eq!(got, want, "buffer of {cap}");
        }
    }

    #[tokio::test]
    async fn cr_counts_against_the_cap() {
        assert_eq!(
            all(b"12345\r\n", 64, 5).await,
            vec![Read::Oversize(6), Read::Eof]
        );
        assert_eq!(all(b"1234\r\n", 64, 5).await, vec![line("1234"), Read::Eof]);
    }

    #[tokio::test]
    async fn invalid_utf8_is_kept_as_bytes() {
        let got = all(b"\xff\xfe\n{}\n", 2, 16).await;
        assert_eq!(
            got,
            vec![Read::Line(vec![0xff, 0xfe]), line("{}"), Read::Eof]
        );
    }

    #[tokio::test]
    async fn empty_input() {
        assert_eq!(all(b"", 8, 8).await, vec![Read::Eof]);
    }
}
