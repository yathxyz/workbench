//! Small helpers shared by the handlers.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Longest sid, in bytes.
const SID_MAX: usize = 64;

/// Keeps only the `[A-Za-z0-9_-]` characters of `s`, cut to 64 bytes. An empty result
/// means the id is unusable.
pub fn sanitize_sid(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(SID_MAX)
        .collect()
}

/// Splits `s` into pieces of at most `max` bytes without cutting a character. `max`
/// must be at least 4, the longest UTF-8 character.
pub fn split_utf8(s: &str, max: usize) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut rest = s;
    while rest.len() > max {
        let mut cut = max;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        let (head, tail) = rest.split_at(cut);
        pieces.push(head);
        rest = tail;
    }
    if !rest.is_empty() {
        pieces.push(rest);
    }
    pieces
}

/// Replaces `path` with `data` atomically: a 0600 temp file next to it, fsync, rename,
/// then an fsync of the directory. Returns the metadata of the new file.
pub fn atomic_write(path: &Path, data: &[u8]) -> io::Result<Metadata> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::other("not a file path"));
    };
    let tmp = dir.join(format!(".{}.wbtmp", name.to_string_lossy()));
    let _ = fs::remove_file(&tmp);
    let written = (|| -> io::Result<Metadata> {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        let meta = f.metadata()?;
        fs::rename(&tmp, path)?;
        Ok(meta)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    let meta = written?;
    File::open(dir)?.sync_all()?;
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_the_sid_alphabet_and_cuts_at_64() {
        assert_eq!(sanitize_sid("n_k3m9x2"), "n_k3m9x2");
        assert_eq!(sanitize_sid("../a b/é-1"), "ab-1");
        assert_eq!(sanitize_sid(""), "");
        assert_eq!(sanitize_sid("/."), "");
        assert_eq!(sanitize_sid(&"x".repeat(100)).len(), 64);
    }

    #[test]
    fn split_never_cuts_a_char_and_respects_the_cap() {
        let s = "aé€😀".repeat(1000);
        for max in [4, 5, 6, 7, 1024] {
            let pieces = split_utf8(&s, max);
            assert!(pieces.iter().all(|p| !p.is_empty() && p.len() <= max));
            assert_eq!(pieces.concat(), s);
        }
        assert!(split_utf8("", 4).is_empty());
        assert_eq!(split_utf8("abc", 4), ["abc"]);
    }

    #[test]
    fn atomic_write_replaces_the_file_with_a_new_inode() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.json");
        let first = atomic_write(&path, b"1").unwrap();
        let second = atomic_write(&path, b"22").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"22");
        assert_ne!(first.ino(), second.ino());
        assert_eq!(second.mode() & 0o777, 0o600);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
