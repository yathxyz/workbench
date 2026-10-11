//! What the hub reads from `/proc`.

use std::path::Path;

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
        let stat = "4242 (a) b (c) S 4200 4242 4242 34817 4242 4194304 0 0";
        assert_eq!(session_of(stat), Some(4242));
        let stat = "17 (bash) S 1 17 9 0 -1 4194560";
        assert_eq!(session_of(stat), Some(9));
        assert_eq!(session_of("17 (bash"), None);
        assert_eq!(session_of("17 (bash) S 1"), None);
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
