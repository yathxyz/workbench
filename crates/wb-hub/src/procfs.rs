//! What the hub reads from `/proc`, and where a child's program is.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use rustix::fs::{Access, access};
use rustix::process::{Pid, Signal, kill_process};

/// Sends `sig` to every process whose session id is `leader` (field 6 of
/// `/proc/<pid>/stat`). Errors, such as a process that exited meanwhile, are ignored.
pub fn signal_session(leader: u32, sig: Signal) {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in dir.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if session_of(&stat) == Some(leader)
            && let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw)
        {
            let _ = kill_process(pid, sig);
        }
    }
}

/// The session id in a `/proc/<pid>/stat` line. The fields are counted after the last
/// `)`, because `comm` may contain spaces and parentheses.
fn session_of(stat: &str) -> Option<u32> {
    let (_, rest) = stat.rsplit_once(')')?;
    // state, ppid, pgrp, session
    rest.split_whitespace().nth(3)?.parse().ok()
}

/// The current directory of `pid`, if it is readable and valid UTF-8.
pub fn cwd(pid: u32) -> Option<String> {
    std::fs::read_link(Path::new("/proc").join(pid.to_string()).join("cwd"))
        .ok()?
        .into_os_string()
        .into_string()
        .ok()
}

/// The program to run for `argv0`: an absolute path as is, a relative one searched in
/// `path`, the child's `PATH` (never the hub's). The first executable regular file wins.
/// Relative `PATH` entries are skipped: they would resolve against the hub's directory.
pub fn resolve_argv0(argv0: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let name = Path::new(argv0);
    if name.is_absolute() {
        return Some(name.to_owned());
    }
    std::env::split_paths(path?)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|p| p.is_file() && access(p, Access::EXEC_OK).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv0_is_resolved_in_the_given_path_only() {
        let exe = std::env::current_exe().unwrap();
        let dir = exe.parent().unwrap();
        let name = exe.file_name().unwrap().to_str().unwrap();
        // A non-executable file earlier in PATH is skipped.
        let plain = fresh_dir();
        std::fs::write(plain.join(name), "not a program").unwrap();
        let path = std::env::join_paths([Path::new("relative"), &plain, dir]).unwrap();
        assert_eq!(resolve_argv0(name, Some(&path)), Some(exe.clone()));
        assert_eq!(resolve_argv0(name, Some(plain.as_os_str())), None);
        assert_eq!(resolve_argv0(name, None), None);
        assert_eq!(
            resolve_argv0("/bin/anything", None),
            Some(PathBuf::from("/bin/anything"))
        );
        std::fs::remove_dir_all(plain).unwrap();
    }

    /// A fresh directory under `$TMPDIR`.
    fn fresh_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wb-procfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn session_is_counted_after_the_last_paren() {
        let stat = "4242 (a) b (c) S 4200 4242 4242 34817 4242 4194304 0 0";
        assert_eq!(session_of(stat), Some(4242));
        let stat = "17 (bash) S 1 17 9 0 -1 4194560";
        assert_eq!(session_of(stat), Some(9));
        assert_eq!(session_of("17 (bash"), None);
        assert_eq!(session_of("17 (bash) S 1"), None);
    }

    #[test]
    fn reads_its_own_cwd() {
        let me = std::process::id();
        let expect = std::env::current_dir().unwrap();
        assert_eq!(cwd(me).as_deref(), expect.to_str());
    }
}
