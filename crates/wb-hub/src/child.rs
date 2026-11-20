//! Observe child exits without reaping, then reap after the last use of the child's
//! numeric identity. One reaper per hub handles children handed off by actors.

use std::io;
use std::os::fd::OwnedFd;
use std::process::Child;
use std::sync::mpsc::{Sender, channel};
use std::thread;
use std::time::Duration;

use rustix::process::{Pid, PidfdFlags, WaitId, WaitIdOptions, WaitIdStatus, pidfd_open, waitid};
use tokio::io::unix::AsyncFd;
use tokio::time::Instant;
use tracing::warn;

pub(crate) fn exit_fd(pid: u32) -> io::Result<AsyncFd<OwnedFd>> {
    let pid = Pid::from_raw(pid as i32).expect("positive child pid");
    AsyncFd::new(pidfd_open(pid, PidfdFlags::empty())?)
}

/// Peek, never reap: the actor may still need the leader's numeric identity to
/// signal its process group or clean up its session.
pub(crate) fn peek_exit(pid: u32) -> io::Result<Option<WaitIdStatus>> {
    let pid = Pid::from_raw(pid as i32).expect("positive child pid");
    let opts = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
    Ok(rustix::io::retry_on_intr(|| {
        waitid(WaitId::Pid(pid), opts)
    })?)
}

pub(crate) fn is_echild(e: &io::Error) -> bool {
    e.raw_os_error() == Some(rustix::io::Errno::CHILD.raw_os_error())
}

pub(crate) enum WaitNotice {
    Exited(Option<i32>, Option<i32>),
    ProbeChild,
}

enum ExitWake {
    Fd(AsyncFd<OwnedFd>),
    Sigchld(tokio::signal::unix::Signal, bool),
    Child {
        sigchld: Option<tokio::signal::unix::Signal>,
        probe_at: Option<Instant>,
    },
}

pub(crate) struct ExitWatch {
    pid: u32,
    wake: ExitWake,
}

impl ExitWatch {
    pub(crate) fn new(pid: u32) -> io::Result<Self> {
        let wake = match exit_fd(pid) {
            Ok(fd) => ExitWake::Fd(fd),
            // As with Tokio's Child, pidfd_open is not required for an ordinary
            // spawn. Check once *after* subscribing so an early exit isn't lost.
            Err(_) => ExitWake::Sigchld(
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?,
                true,
            ),
        };
        Ok(Self { pid, wake })
    }

    pub(crate) fn use_child_wait(&mut self) {
        self.wake = ExitWake::Child {
            sigchld: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).ok(),
            probe_at: Some(Instant::now()),
        };
    }

    pub(crate) fn retry_child(&mut self) {
        if let ExitWake::Child { probe_at, .. } = &mut self.wake {
            *probe_at = Some(Instant::now() + Duration::from_secs(1));
        }
    }
}

async fn wait_pidfd(
    fd: &AsyncFd<OwnedFd>,
    mut peek: impl FnMut() -> io::Result<Option<WaitIdStatus>>,
) -> io::Result<WaitIdStatus> {
    loop {
        let mut ready = fd.readable().await?;
        if let Some(status) = peek()? {
            return Ok(status);
        }
        ready.clear_ready();
    }
}

pub(crate) async fn wait(watch: Option<&mut ExitWatch>) -> io::Result<WaitNotice> {
    let Some(ExitWatch { pid, wake }) = watch else {
        return std::future::pending().await;
    };
    let status = match wake {
        ExitWake::Fd(fd) => wait_pidfd(fd, || peek_exit(*pid)).await?,
        ExitWake::Sigchld(signal, check) => loop {
            if std::mem::take(check)
                && let Some(status) = peek_exit(*pid)?
            {
                break status;
            }
            signal
                .recv()
                .await
                .ok_or_else(|| io::Error::other("SIGCHLD stream closed"))?;
            *check = true;
        },
        ExitWake::Child { sigchld, probe_at } => {
            if let Some(at) = *probe_at {
                tokio::time::sleep_until(at).await;
            } else if let Some(signal) = sigchld
                && signal.recv().await.is_none()
            {
                *sigchld = None;
            }
            *probe_at = sigchld
                .is_none()
                .then(|| Instant::now() + Duration::from_secs(1));
            return Ok(WaitNotice::ProbeChild);
        }
    };
    Ok(WaitNotice::Exited(
        status.exit_status(),
        status.terminating_signal(),
    ))
}

/// Reap without blocking the caller. Neither it nor any pending signal may use
/// the child's numeric identity after this call.
pub(crate) fn reap(mut child: Child, reaper: &Sender<Child>) {
    match child.try_wait() {
        Ok(Some(_)) => return,
        Err(e) if is_echild(&e) => return,
        Err(e) => warn!(pid = child.id(), "reaping child: {e}"),
        Ok(None) => {}
    }
    reaper
        .send(child)
        .expect("reaper runs until all senders are dropped");
}

pub(crate) fn start_reaper() -> io::Result<Sender<Child>> {
    let (tx, rx) = channel::<Child>();
    thread::Builder::new()
        .name("child-reaper".into())
        .spawn(move || {
            let mut pending = Vec::new();
            while let Ok(child) = rx.recv() {
                pending.push(child);
                loop {
                    pending.retain_mut(|child| match child.try_wait() {
                        Ok(status) => status.is_none(),
                        Err(e) => !is_echild(&e),
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
    use std::os::fd::AsFd;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    #[tokio::test]
    async fn pidfd_returns_waitid_eagain() {
        let mut child = Command::new("true").spawn().unwrap();
        let fd = exit_fd(child.id()).unwrap();
        let error = tokio::time::timeout(
            Duration::from_secs(30),
            wait_pidfd(&fd, || Err(rustix::io::Errno::AGAIN.into())),
        )
        .await;
        assert!(child.wait().unwrap().success());
        let error = error.expect("waitid error swallowed").unwrap_err();
        assert_eq!(
            error.raw_os_error(),
            Some(rustix::io::Errno::AGAIN.raw_os_error())
        );
    }

    #[test]
    fn reaps_an_exited_child_while_another_stays_alive() {
        let reaper = start_reaper().unwrap();
        let handoff = || {
            let mut child = Command::new("sh")
                .args(["-c", "read line"])
                .stdin(Stdio::piped())
                .spawn()
                .unwrap();
            let pid = Pid::from_raw(child.id() as i32).unwrap();
            let fd = pidfd_open(pid, PidfdFlags::empty()).unwrap();
            let gate = child.stdin.take().unwrap();
            reap(child, &reaper);
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
