//! One worker per hub, independent of the runtime and its PTY actors.

use std::io;
use std::process::Child;
use std::sync::mpsc::{Sender, channel};
use std::thread;
use std::time::Duration;

pub(crate) fn start() -> io::Result<Sender<Child>> {
    let (tx, rx) = channel::<Child>();
    thread::Builder::new()
        .name("pty-reaper".into())
        .spawn(move || {
            let mut pending = Vec::new();
            while let Ok(child) = rx.recv() {
                pending.push(child);
                loop {
                    pending.retain_mut(|child| match child.try_wait() {
                        Ok(status) => status.is_none(),
                        Err(e) => !super::is_echild(&e),
                    });
                    if pending.is_empty() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(200));
                    pending.extend(rx.try_iter());
                }
            }
        })?;
    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustix::process::{Pid, PidfdFlags, WaitId, WaitIdOptions, pidfd_open, waitid};
    use std::os::fd::{AsFd, OwnedFd};
    use std::process::{Command, Stdio};
    use std::time::Instant;

    #[test]
    fn reaps_an_exited_child_while_another_stays_alive() {
        let reaper = start().unwrap();
        let handoff = || {
            let mut child = Command::new("sh")
                .args(["-c", "read line"])
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            let pid = Pid::from_raw(child.id() as i32).unwrap();
            let fd = pidfd_open(pid, PidfdFlags::empty()).unwrap();
            let gate = child.stdin.take().unwrap();
            reaper.send(child).unwrap();
            (fd, gate)
        };
        // WNOWAIT sees a zombie without reaping it. Only ECHILD proves the worker reaped it.
        let options = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
        let peek =
            |fd: &OwnedFd| rustix::io::retry_on_intr(|| waitid(WaitId::PidFd(fd.as_fd()), options));
        let await_reap = |fd: &OwnedFd| {
            let until = Instant::now() + Duration::from_secs(30);
            loop {
                match peek(fd) {
                    Err(rustix::io::Errno::CHILD) => return,
                    Err(e) => panic!("checking child status: {e}"),
                    Ok(_) => assert!(Instant::now() < until, "child was not reaped"),
                }
                thread::sleep(Duration::from_millis(20));
            }
        };
        let (first, first_gate) = handoff();
        let (second, second_gate) = handoff();
        drop(second_gate);
        await_reap(&second);
        assert!(peek(&first).unwrap().is_none());
        drop(first_gate);
        await_reap(&first);
    }
}
