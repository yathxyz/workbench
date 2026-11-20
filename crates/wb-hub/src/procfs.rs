//! What the hub reads from `/proc`.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use rustix::fs::{Mode, OFlags, openat};
use rustix::io::Errno;
use rustix::process::{Signal, pidfd_send_signal};
use tracing::warn;

struct Member {
    /// For diagnostics only. Signals always go through the captured directory.
    pid: u32,
    dir: File,
}

impl Member {
    fn signal(&self, sid: &str, signal: Signal) -> io::Result<()> {
        match pidfd_send_signal(&self.dir, signal) {
            Ok(()) | Err(Errno::SRCH) => Ok(()),
            Err(e) => {
                warn!(%sid, pid = self.pid, ?signal, "signalling captured session member: {e}");
                Err(e.into())
            }
        }
    }
}

pub struct SessionMembers {
    sid: String,
    leader: Option<Member>,
    others: Vec<Member>,
}

impl SessionMembers {
    /// Attempt every member. If the leader wasn't captured or its HUP failed,
    /// only the owner of the Child can distinguish a live leader from a dead one.
    pub fn hangup(&self) -> io::Result<()> {
        for member in &self.others {
            let _ = member.signal(&self.sid, Signal::HUP);
        }
        self.leader
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "session leader not captured"))?
            .signal(&self.sid, Signal::HUP)
    }

    pub fn kill(&self) {
        for member in self.leader.iter().chain(&self.others) {
            let _ = member.signal(&self.sid, Signal::KILL);
        }
    }
}

/// Open each member while the caller still owns the unreaped session leader.
/// Linux accepts a `/proc/<pid>` directory fd as a pidfd for pidfd_send_signal.
/// Read `stat` relative to that same fd: neither lookup can follow a recycled pid.
pub fn session_members(proc: &Path, leader: u32, sid: &str) -> SessionMembers {
    let mut members = SessionMembers {
        sid: sid.to_owned(),
        leader: None,
        others: Vec::new(),
    };
    let entries = match std::fs::read_dir(proc) {
        Ok(entries) => entries,
        Err(e) => {
            warn!(%sid, path = %proc.display(), "enumerating processes: {e}");
            return members;
        }
    };
    let mut stat = Vec::new();
    for entry in entries {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(e) => {
                warn!(%sid, path = %proc.display(), "enumerating processes: {e}");
                continue;
            }
        };
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let pid = match name.parse::<u32>() {
            Ok(pid) => pid,
            Err(e) => {
                warn!(%sid, %name, "parsing process directory name: {e}");
                continue;
            }
        };
        match process_dir_and_session(&path, &mut stat) {
            Ok((dir, session)) if session == leader => {
                let member = Member { pid, dir };
                if pid == leader {
                    members.leader = Some(member);
                } else {
                    members.others.push(member);
                }
            }
            Ok(_) => {}
            Err(e)
                if e.kind() == io::ErrorKind::NotFound
                    || e.raw_os_error() == Some(Errno::SRCH.raw_os_error()) => {}
            Err(e) => warn!(%sid, pid, "capturing process directory and stat: {e}"),
        }
    }
    members
}

fn process_dir_and_session(path: &Path, stat: &mut Vec<u8>) -> io::Result<(File, u32)> {
    let dir = rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let fd = openat(
        &dir,
        c"stat",
        OFlags::RDONLY | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    stat.clear();
    File::from(fd).read_to_end(stat)?;
    let session = session_of(stat)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed process stat"))?;
    Ok((File::from(dir), session))
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

    fn warnings(f: impl FnOnce()) -> String {
        let log = tempfile::NamedTempFile::new().unwrap();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_max_level(tracing::Level::WARN)
            .with_writer(std::sync::Mutex::new(log.reopen().unwrap()))
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        std::fs::read_to_string(log.path()).unwrap()
    }

    #[test]
    fn incomplete_capture_warns_with_the_workbench_sid() {
        let proc = tempfile::tempdir().unwrap();
        let root = proc.path();
        std::fs::write(root.join("11"), b"not a process directory").unwrap();
        std::fs::create_dir_all(root.join("12/stat")).unwrap(); // read fails
        std::fs::create_dir(root.join("13")).unwrap();
        std::fs::write(root.join("13/stat"), b"malformed stat").unwrap();
        std::os::unix::fs::symlink(root.join("gone"), root.join("14")).unwrap();

        let log = warnings(|| {
            session_members(&root.join("no-proc"), 11, "wb-test");
            session_members(root, 11, "wb-test");
        });
        for context in ["no-proc", "pid=11", "pid=12", "pid=13"] {
            assert!(
                log.lines().any(|line| line.contains("WARN")
                    && line.contains("sid=wb-test")
                    && line.contains(context)),
                "no capture warning for {context}: {log}"
            );
        }
        assert!(!log.contains("pid=14"), "{log}"); // ENOENT is normal here
    }

    #[test]
    fn undeliverable_signals_warn_and_a_missing_or_unsignalled_leader_fails() {
        // Ordinary directories cannot receive pidfd signals. The stat PID is
        // deliberately unrelated: the numeric entry names identify the handles.
        let proc = tempfile::tempdir().unwrap();
        let root = proc.path();
        let leader = 1_000_000_000;
        let expose = |pid: u32| {
            let dir = root.join(pid.to_string());
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("stat"), format!("7 (sh) S 1 7 {leader} 0")).unwrap();
        };
        expose(leader + 1);
        let log = warnings(|| {
            let members = session_members(root, leader, "wb-test");
            assert_eq!(
                members.hangup().unwrap_err().kind(),
                io::ErrorKind::NotFound
            );
            expose(leader);
            let members = session_members(root, leader, "wb-test");
            assert!(members.hangup().unwrap_err().raw_os_error().is_some());
            members.kill();
        });
        for (pid, count) in [(leader, 2), (leader + 1, 3)] {
            let field = format!("pid={pid}");
            assert_eq!(
                log.lines()
                    .filter(|line| line.contains("WARN")
                        && line.contains("sid=wb-test")
                        && line.contains(&field))
                    .count(),
                count,
                "{log}"
            );
        }
    }

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
