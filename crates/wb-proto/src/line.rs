//! NDJSON framing: one compact UTF-8 JSON object per `\n`-terminated line.

use std::io::{self, BufRead, Read};

use serde::Serialize;

pub use crate::limits::MAX_LINE;

/// Encodes `msg` as compact JSON followed by `\n`.
///
/// # Panics
///
/// If `msg` fails to serialize. No type in this crate can: that takes a map with
/// non-string keys or a failing `Serialize` impl.
pub fn encode<T: Serialize>(msg: &T) -> Vec<u8> {
    let mut line = serde_json::to_vec(msg).expect("wire types serialize to JSON");
    line.push(b'\n');
    line
}

/// Reads one line of at most [`MAX_LINE`] bytes and returns it without its `\n`.
///
/// Blocking; meant for the CLI. Returns `Ok(None)` at end of input before the first
/// byte. A longer line is an `InvalidData` error, and end of input inside a line is
/// `UnexpectedEof`.
pub fn read_line_capped(r: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    r.take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line)?;
    match line.last() {
        None => Ok(None),
        Some(b'\n') => {
            line.pop();
            Ok(Some(line))
        }
        Some(_) if line.len() > MAX_LINE => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "line longer than MAX_LINE",
        )),
        Some(_) => Err(io::ErrorKind::UnexpectedEof.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_all(input: &[u8]) -> Vec<io::Result<Option<Vec<u8>>>> {
        let mut r = input;
        let mut out = Vec::new();
        loop {
            let res = read_line_capped(&mut r);
            let stop = !matches!(res, Ok(Some(_)));
            out.push(res);
            if stop {
                return out;
            }
        }
    }

    #[test]
    fn encode_is_compact_with_newline() {
        let msg = crate::hub::HubRequest::List { rid: 1 };
        assert_eq!(encode(&msg), b"{\"t\":\"list\",\"rid\":1}\n");
    }

    #[test]
    fn reads_lines_then_none() {
        let got = read_all(b"{\"a\":1}\n\n{}\n");
        let lines: Vec<_> = got.into_iter().map(|r| r.unwrap()).collect();
        assert_eq!(
            lines,
            [
                Some(b"{\"a\":1}".to_vec()),
                Some(Vec::new()),
                Some(b"{}".to_vec()),
                None
            ]
        );
    }

    #[test]
    fn eof_inside_a_line_is_an_error() {
        let mut r: &[u8] = b"{\"a\":1}";
        let err = read_line_capped(&mut r).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn a_line_of_exactly_max_line_is_accepted() {
        let mut input = vec![b'x'; MAX_LINE];
        input.push(b'\n');
        let mut r = input.as_slice();
        assert_eq!(read_line_capped(&mut r).unwrap().unwrap().len(), MAX_LINE);
        assert!(read_line_capped(&mut r).unwrap().is_none());
    }

    #[test]
    fn a_longer_line_is_invalid_data() {
        let mut input = vec![b'x'; MAX_LINE + 1];
        input.push(b'\n');
        let mut r = input.as_slice();
        let err = read_line_capped(&mut r).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn eof_after_max_line_bytes_is_unexpected_eof() {
        let input = vec![b'x'; MAX_LINE];
        let mut r = input.as_slice();
        let err = read_line_capped(&mut r).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }
}
