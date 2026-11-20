//! What the hub reads from `/proc`.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use rustix::fs::{Mode, OFlags, openat};

/// Open each member while the caller still owns the unreaped session leader.
/// Linux accepts a `/proc/<pid>` directory fd as a pidfd for pidfd_send_signal.
/// Read `stat` relative to that same fd: neither lookup can follow a recycled pid.
pub fn session_members(proc: &Path, leader: u32) -> Vec<File> {
    let mut members = Vec::new();
    let Ok(dir) = std::fs::read_dir(proc) else {
        return members;
    };
    let mut stat = Vec::new();
    for entry in dir.flatten() {
        if !entry
            .file_name()
            .as_encoded_bytes()
            .iter()
            .all(u8::is_ascii_digit)
        {
            continue;
        }
        let Ok(member) = File::open(entry.path()) else {
            continue;
        };
        let Ok(fd) = openat(
            &member,
            c"stat",
            OFlags::RDONLY | OFlags::CLOEXEC,
            Mode::empty(),
        ) else {
            continue;
        };
        stat.clear();
        if File::from(fd).read_to_end(&mut stat).is_ok() && session_of(&stat) == Some(leader) {
            members.push(member);
        }
    }
    members
}

/// The session id in a `/proc/<pid>/stat` line. The fields are counted after the last
/// `)`, because `comm` may contain spaces and parentheses.
fn session_of(stat: &[u8]) -> Option<u32> {
    let end = stat.iter().rposition(|b| *b == b')')?;
    // state, ppid, pgrp, session
    let rest = std::str::from_utf8(&stat[end + 1..]).ok()?;
    rest.split_ascii_whitespace().nth(3)?.parse().ok()
}

/// The current directory of `pid`, if it is readable and valid UTF-8.
pub fn cwd(pid: u32) -> Option<String> {
    std::fs::read_link(Path::new("/proc").join(pid.to_string()).join("cwd"))
        .ok()?
        .into_os_string()
        .into_string()
        .ok()
}

/// The name of `pid`'s program (`/proc/<pid>/comm`), if it still exists.
pub fn comm(pid: u32) -> Option<String> {
    let comm = std::fs::read_to_string(Path::new("/proc").join(pid.to_string()).join("comm"));
    Some(comm.ok()?.trim_end_matches('\n').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_is_counted_after_the_last_paren() {
        let stat = b"4242 (a) b (\xff) S 4200 4242 4242 34817 4242 4194304 0 0";
        assert_eq!(session_of(stat), Some(4242));
        let stat = b"17 (bash) S 1 17 9 0 -1 4194560";
        assert_eq!(session_of(stat), Some(9));
        assert_eq!(session_of(b"17 (bash"), None);
        assert_eq!(session_of(b"17 (bash) S 1"), None);
    }

    #[test]
    fn reads_its_own_cwd_and_comm() {
        let me = std::process::id();
        let expect = std::env::current_dir().unwrap();
        assert_eq!(cwd(me).as_deref(), expect.to_str());
        let exe = std::env::current_exe().unwrap();
        let name = exe.file_name().unwrap().to_str().unwrap();
        // comm is the program name cut to 15 bytes.
        assert_eq!(comm(me).as_deref(), name.get(..15).or(Some(name)));
        assert_eq!(comm(u32::MAX), None);
    }
}
