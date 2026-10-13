//! Buffer ids from user-given names (R6.1, R13.1 and the `server-edit` argument rule).

use std::path::Path;

/// Normalises NAME: an absolute path, `~/x` and `name:<x>` pass through; a relative
/// path that exists on disk relative to the cwd becomes its real absolute path; anything
/// else is passed as given (a notesDir-relative id).
pub fn normalize(name: &str) -> String {
    if name.starts_with('/') || name == "~" || name.starts_with("~/") || name.starts_with("name:") {
        return name.to_owned();
    }
    let path = Path::new(name);
    if path.exists()
        && let Ok(real) = std::fs::canonicalize(path)
    {
        return real.to_string_lossy().into_owned();
    }
    name.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_tilde_and_named_pass_through() {
        assert_eq!(normalize("/etc/hosts"), "/etc/hosts");
        assert_eq!(normalize("~/x.md"), "~/x.md");
        assert_eq!(normalize("name:*scratch*"), "name:*scratch*");
    }

    #[test]
    fn missing_relative_is_passed_as_given() {
        assert_eq!(
            normalize("surely/not/here/inbox.md"),
            "surely/not/here/inbox.md"
        );
    }

    #[test]
    fn existing_relative_becomes_absolute() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let cwd = std::env::current_dir().unwrap();
        let rel = pathdiff(&cwd, &file);
        let got = normalize(&rel);
        assert_eq!(got, std::fs::canonicalize(&file).unwrap().to_string_lossy());
    }

    /// `to` relative to `from`, through `..` segments.
    fn pathdiff(from: &Path, to: &Path) -> String {
        let from: Vec<_> = from.components().collect();
        let to: Vec<_> = to.components().collect();
        let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
        let mut rel = std::path::PathBuf::new();
        for _ in common..from.len() {
            rel.push("..");
        }
        for c in &to[common..] {
            rel.push(c);
        }
        rel.to_string_lossy().into_owned()
    }
}
