//! Starting a PTY child or an ACP agent. This is the only module of the hub with `unsafe`
//! code: the `pre_exec` closures, which run between `fork` and `exec` and therefore make
//! only async-signal-safe raw syscalls (rustix's linux_raw backend: no allocation, no
//! locks).
#![allow(unsafe_code)]

use std::ffi::OsString;
use std::io;
use std::os::fd::{BorrowedFd, OwnedFd};
use std::path::Path;
use std::process::Stdio;

use rustix::fs::{Mode, OFlags};
use rustix::pty::{OpenptFlags, grantpt, ioctl_tiocgptpeer, openpt, unlockpt};
use rustix::termios::{Winsize, tcsetwinsize};
use tokio::process::{Child, Command};

pub struct Spawned {
    pub child: Child,
    /// Non-blocking and close-on-exec. The hub holds no slave fd, so reads return EOF
    /// once every process has closed the slave.
    pub master: OwnedFd,
}

/// Starts `program` with `argv` (`argv[0]` included, unchanged) on a new PTY of `size`,
/// with exactly `env`, in `cwd`, as the leader of a new session whose controlling
/// terminal is the PTY.
pub fn spawn(
    program: &Path,
    argv: &[String],
    env: &[(OsString, OsString)],
    cwd: &str,
    size: Winsize,
    child_umask: Mode,
) -> io::Result<Spawned> {
    let flags = OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC;
    let master = openpt(flags)?;
    grantpt(&master)?;
    unlockpt(&master)?;
    let slave = ioctl_tiocgptpeer(&master, flags)?;
    tcsetwinsize(&master, size)?;

    let (arg0, args) = argv
        .split_first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty argv"))?;
    let mut cmd = Command::new(program);
    cmd.arg0(arg0)
        .args(args)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(cwd)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave))
        .kill_on_drop(false);
    // SAFETY: the closure runs in the forked child before exec. It only calls rustix
    // syscall wrappers, which neither allocate nor take locks.
    unsafe {
        cmd.pre_exec(move || child_setup(child_umask));
    }
    let child = cmd.spawn()?;
    // The command still owns the three slave fds; close them in the hub.
    drop(cmd);
    rustix::io::ioctl_fionbio(&master, true)?;
    Ok(Spawned { child, master })
}

/// Starts the agent `program` with `args` (not including `argv[0]`), exactly `env`, in
/// `cwd`, with piped stdio, as the leader of a new process group in the hub's session
/// (DESIGN §3.4.5: `process_group(0)`, never `setsid`).
pub fn spawn_agent(
    program: &Path,
    args: &[String],
    env: &[(OsString, OsString)],
    cwd: &str,
    child_umask: Mode,
) -> io::Result<Child> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    // SAFETY: as in `spawn`; the closure only calls rustix syscall wrappers.
    unsafe {
        cmd.pre_exec(move || {
            lower(child_umask);
            Ok(())
        });
    }
    cmd.spawn()
}

/// In a child before exec: the user's umask, and an OOM score that makes the kernel
/// prefer the children over the hub (best effort).
fn lower(umask: Mode) {
    rustix::process::umask(umask);
    if let Ok(fd) = rustix::fs::open(
        c"/proc/self/oom_score_adj",
        OFlags::WRONLY | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        let _ = rustix::io::write(&fd, b"800");
    }
}

/// In the child, after std has made the slave fds 0-2 and changed directory.
fn child_setup(umask: Mode) -> io::Result<()> {
    lower(umask);
    rustix::process::setsid()?;
    // SAFETY: fd 0 is the PTY slave, which std placed there before running this closure.
    let stdin = unsafe { BorrowedFd::borrow_raw(0) };
    rustix::process::ioctl_tiocsctty(stdin)?;
    Ok(())
}
