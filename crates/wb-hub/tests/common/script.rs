use std::fs::{self, Permissions};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

/// Open the script for writing only in a child. Other tests fork concurrently;
/// inheriting a writable descriptor even briefly makes execve fail with ETXTBSY.
pub fn write(shell: &Path, path: &Path, body: &str) {
    let status = Command::new(shell)
        .args(["-c", "printf '#!%s\\n%s\\n' \"$0\" \"$2\" > \"$1\""])
        .arg(shell)
        .arg(path)
        .arg(body)
        .status()
        .unwrap();
    assert!(status.success(), "write executable fixture: {status}");
    fs::set_permissions(path, Permissions::from_mode(0o700)).unwrap();
}
