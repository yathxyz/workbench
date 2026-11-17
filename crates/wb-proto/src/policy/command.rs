//! A literal shell-word subset. Unsupported syntax is evidence to ask, not to ignore.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::limits::{
    POLICY_COMMAND_MAX, POLICY_COMMAND_WORDS_MAX, POLICY_CWDS_MAX, POLICY_FRAGMENT_BYTES_MAX,
    POLICY_FRAGMENTS_MAX, POLICY_PATH_BYTES_MAX, POLICY_PATHS_MAX,
};

use super::{nonempty_string, normalize_from};

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Program<'a> {
    Name(Cow<'a, str>),
    Path(PathBuf),
}

pub(super) struct Evidence<'a> {
    pub paths: BTreeSet<PathBuf>,
    pub programs: BTreeSet<Program<'a>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Separator {
    Always,
    And,
    Or,
    Pipe,
}

enum Token<'a> {
    Word(Cow<'a, str>),
    Redirect,
    Separator(Separator),
}

#[derive(Default)]
struct Simple<'a> {
    args: Vec<Cow<'a, str>>,
    redirects: Vec<Cow<'a, str>>,
}

struct Pipeline<'a> {
    commands: Vec<Simple<'a>>,
    next: Separator,
}

struct Paths {
    unique: BTreeSet<PathBuf>,
    candidates: usize,
    bytes: usize,
    fragments: usize,
    fragment_bytes: usize,
}

impl Paths {
    fn resolve(&mut self, text: &str, cwd: &Path) -> Option<PathBuf> {
        self.candidates = self.candidates.checked_add(1)?;
        self.bytes = self.bytes.checked_add(text.len())?;
        if !Path::new(text).is_absolute() {
            self.bytes = self.bytes.checked_add(cwd.as_os_str().len())?;
        }
        if self.candidates > POLICY_PATHS_MAX || self.bytes > POLICY_PATH_BYTES_MAX {
            return None;
        }
        Some(normalize_from(
            Path::new(text),
            if Path::new(text).is_absolute() {
                PathBuf::new()
            } else {
                cwd.to_owned()
            },
        ))
    }

    fn fragment<'a>(&mut self, fragments: &mut BTreeSet<&'a str>, text: &'a str) -> Option<()> {
        // Charge even duplicates before string ordering can compare overlapping slices.
        self.fragments = self.fragments.checked_add(1)?;
        self.fragment_bytes = self.fragment_bytes.checked_add(text.len())?;
        if self.fragments > POLICY_FRAGMENTS_MAX || self.fragment_bytes > POLICY_FRAGMENT_BYTES_MAX
        {
            return None;
        }
        fragments.insert(text);
        Some(())
    }

    fn word(
        &mut self,
        word: &str,
        dirs: &BTreeSet<PathBuf>,
        capture: bool,
    ) -> Option<BTreeSet<PathBuf>> {
        let mut fragments = BTreeSet::new();
        if word.contains(['=', ':', ',']) {
            for fragment in word.split(['=', ':', ',']) {
                self.fragment(&mut fragments, fragment)?;
            }
            for (index, ch) in word.char_indices() {
                if matches!(ch, '=' | ':' | ',') {
                    self.fragment(&mut fragments, &word[..index])?;
                    self.fragment(&mut fragments, &word[index + 1..])?;
                }
            }
            fragments.remove(word);
        }
        let mut changed = BTreeSet::new();
        for fragment in std::iter::once(word).chain(fragments) {
            if fragment.starts_with('~')
                || fragment.split('/').any(|component| {
                    component.contains(['*', '?', '[']) && component.starts_with(['.', '['])
                })
            {
                return None;
            }
            let whole = capture && fragment == word;
            if !whole && !fragment.contains('/') && !matches!(fragment, "." | "..") {
                continue;
            }
            for dir in dirs {
                let path = self.resolve(fragment, dir)?;
                if whole {
                    changed.insert(path.clone());
                }
                self.unique.insert(path);
            }
        }
        Some(changed)
    }
}

pub(super) fn evidence<'a>(
    command: Option<&'a str>,
    locations: &[Value],
    cwd: &Path,
) -> Option<Evidence<'a>> {
    if locations.is_empty() || locations.len() > POLICY_PATHS_MAX {
        return None;
    }
    let mut paths = Paths {
        unique: BTreeSet::new(),
        candidates: 0,
        bytes: 0,
        fragments: 0,
        fragment_bytes: 0,
    };
    for location in locations {
        let text = nonempty_string(location.get("path")?)?;
        let path = paths.resolve(text, cwd)?;
        paths.unique.insert(path);
    }
    let mut programs = BTreeSet::new();
    if let Some(command) = command {
        let pipelines = parse(command)?;
        // Bare operands are only safe to ignore while every possible cwd is inside.
        paths.unique.insert(cwd.to_owned());
        let mut yes = BTreeSet::from([cwd.to_owned()]);
        let mut no = BTreeSet::new();
        let mut previous = Separator::Always;
        for pipeline in pipelines {
            let dirs = match previous {
                Separator::Always => {
                    yes.append(&mut no);
                    std::mem::take(&mut yes)
                }
                Separator::And => std::mem::take(&mut yes),
                Separator::Or => std::mem::take(&mut no),
                Separator::Pipe => unreachable!(),
            };
            let mut changed = None;
            let count = pipeline.commands.len();
            for simple in pipeline.commands {
                let (index, cd) = classify(&simple)?;
                // A pipeline's builtins run in shell-dependent subshell contexts.
                if cd && count != 1 {
                    return None;
                }
                for (i, word) in simple.args.into_iter().enumerate() {
                    let executable = i == index && word.contains('/');
                    let next = paths.word(&word, &dirs, (cd && i == 1) || executable)?;
                    if cd && i == 1 {
                        changed = Some(next);
                    } else if executable {
                        programs.extend(next.into_iter().map(Program::Path));
                    } else if i == index {
                        programs.insert(Program::Name(word));
                    }
                }
                for word in &simple.redirects {
                    paths.word(word, &dirs, false)?;
                }
            }
            // A failed cd leaves cwd unchanged; &&/|| only run their eligible branch.
            // Keeping both outcomes also covers failed redirections and missing dirs.
            if let Some(mut changed) = changed {
                yes.append(&mut changed);
                no.extend(dirs);
            } else {
                yes.extend(dirs.iter().cloned());
                no.extend(dirs);
            }
            if yes.union(&no).count() > POLICY_CWDS_MAX {
                return None;
            }
            previous = pipeline.next;
        }
    }
    Some(Evidence {
        paths: paths.unique,
        programs,
    })
}

fn assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == b'_')
        && bytes.all(|ch| ch.is_ascii_alphanumeric() || ch == b'_')
}

fn classify(simple: &Simple<'_>) -> Option<(usize, bool)> {
    let mut index = 0;
    for word in &simple.args {
        if !word.contains('=') {
            break;
        }
        if !assignment(word) {
            return None;
        }
        let (name, _) = word.split_once('=')?;
        if matches!(
            name,
            "CDPATH"
                | "PATH"
                | "IFS"
                | "ENV"
                | "BASH_ENV"
                | "HOME"
                | "PWD"
                | "OLDPWD"
                | "SHELLOPTS"
                | "BASHOPTS"
                | "GLOBIGNORE"
                | "LD_PRELOAD"
                | "LD_LIBRARY_PATH"
                | "LD_AUDIT"
        ) {
            return None;
        }
        index += 1;
    }
    let name = simple.args.get(index)?.as_ref();
    if name.is_empty() || name.contains(['*', '?', '[']) {
        return None;
    }
    // Complete bash/POSIX builtin and keyword classification; cd is modeled below.
    match name {
        "echo" | "printf" | "true" | "false" | "test" | "[" | "pwd" | "cd" => {}
        "." | ":" | "alias" | "bg" | "bind" | "break" | "builtin" | "caller" | "command"
        | "compgen" | "complete" | "compopt" | "continue" | "declare" | "dirs" | "disown"
        | "enable" | "eval" | "exec" | "exit" | "export" | "fc" | "fg" | "getopts" | "hash"
        | "help" | "history" | "jobs" | "kill" | "let" | "local" | "logout" | "mapfile"
        | "popd" | "pushd" | "read" | "readarray" | "readonly" | "return" | "set" | "shift"
        | "shopt" | "source" | "suspend" | "times" | "trap" | "type" | "typeset" | "ulimit"
        | "umask" | "unalias" | "unset" | "wait" | "if" | "then" | "else" | "elif" | "fi"
        | "case" | "esac" | "for" | "select" | "while" | "until" | "do" | "done" | "in"
        | "function" | "time" | "{" | "}" | "!" | "[[" | "]]" | "coproc" => return None,
        _ => {}
    }
    // Convenience only: program dispatch and argument conventions need rule author trust.
    if matches!(
        Path::new(name).file_name()?.to_str()?,
        "sh" | "bash"
            | "dash"
            | "zsh"
            | "ksh"
            | "fish"
            | "env"
            | "nice"
            | "nohup"
            | "timeout"
            | "time"
            | "xargs"
            | "busybox"
            | "sudo"
            | "doas"
            | "su"
            | "watch"
            | "stdbuf"
            | "setsid"
            | "chroot"
            | "unshare"
            | "nsenter"
            | "flock"
            | "strace"
            | "ltrace"
            | "parallel"
            | "ssh"
            | "script"
    ) {
        return None;
    }
    // Bash's printing and variable-test extensions can mutate shell resolution state.
    if name == "printf" {
        printing_format(&simple.args[index + 1..])?;
    }
    if name == "test" && simple.args[index + 1..].iter().any(|arg| arg == "-v") {
        return None;
    }
    if name == "cd" {
        if index != 0
            || simple.args.len() != 2
            || simple.args[1].is_empty()
            || simple.args[1].starts_with('-')
            || simple.args[1].contains(['*', '?', '[', ']'])
        {
            return None;
        }
        return Some((index, true));
    }
    Some((index, false))
}

fn printing_format(args: &[Cow<'_, str>]) -> Option<()> {
    let first = args.first()?;
    if first.starts_with("-v") {
        return None;
    }
    let format = if first == "--" { args.get(1)? } else { first };
    let mut bytes = format.bytes();
    while let Some(ch) = bytes.next() {
        if ch == b'%' {
            let conversion = bytes
                .find(|ch| !matches!(ch, b'#' | b'-' | b'+' | b' ' | b'0'..=b'9' | b'.' | b'*'))?;
            if conversion == b'n' {
                return None;
            }
        }
    }
    Some(())
}

fn parse(command: &str) -> Option<Vec<Pipeline<'_>>> {
    let tokens = tokenize(command)?;
    let mut tokens = tokens.into_iter();
    let mut pipelines = Vec::new();
    let mut commands = Vec::new();
    let mut simple = Simple::default();
    let mut required = false;
    while let Some(token) = tokens.next() {
        match token {
            Token::Word(word) => simple.args.push(word),
            Token::Redirect => match tokens.next()? {
                Token::Word(word) => simple.redirects.push(word),
                _ => return None,
            },
            Token::Separator(separator) => {
                if simple.args.is_empty() {
                    if !simple.redirects.is_empty() {
                        return None;
                    }
                    // Blank lines and newlines after &&/||/| are shell continuations.
                    if separator == Separator::Always {
                        continue;
                    }
                    return None;
                }
                commands.push(std::mem::take(&mut simple));
                required = separator != Separator::Always;
                if separator != Separator::Pipe {
                    pipelines.push(Pipeline {
                        commands: std::mem::take(&mut commands),
                        next: separator,
                    });
                }
            }
        }
    }
    if !simple.args.is_empty() {
        commands.push(simple);
    } else if required || !simple.redirects.is_empty() {
        return None;
    }
    if !commands.is_empty() {
        pipelines.push(Pipeline {
            commands,
            next: Separator::Always,
        });
    }
    (!pipelines.is_empty()).then_some(pipelines)
}

fn tokenize(command: &str) -> Option<Vec<Token<'_>>> {
    if command.len() > POLICY_COMMAND_MAX
        || command.bytes().any(|ch| {
            !(ch == b'\n' || (b' '..=b'~').contains(&ch))
                || matches!(ch, b'$' | b'`' | b'{' | b'}' | b'(' | b')')
        })
    {
        return None;
    }
    let bytes = command.as_bytes();
    let mut tokens = Vec::new();
    let mut words = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b' ' => {
                i += 1;
                continue;
            }
            b'\n' | b';' => {
                // Empty semicolon commands are not modeled; blank lines are.
                if bytes[i] == b';'
                    && (tokens.is_empty() || matches!(tokens.last(), Some(Token::Separator(_))))
                {
                    return None;
                }
                tokens.push(Token::Separator(Separator::Always));
                i += 1;
            }
            b'&' | b'|' => {
                let ch = bytes[i];
                i += 1;
                let separator = if bytes.get(i) == Some(&ch) {
                    i += 1;
                    if ch == b'&' {
                        Separator::And
                    } else {
                        Separator::Or
                    }
                } else if ch == b'|' {
                    Separator::Pipe
                } else {
                    return None;
                };
                tokens.push(Token::Separator(separator));
            }
            b'<' | b'>' => {
                let ch = bytes[i];
                i += 1;
                if bytes.get(i) == Some(&ch) {
                    if ch == b'<' {
                        return None;
                    }
                    i += 1;
                }
                if bytes
                    .get(i)
                    .is_some_and(|ch| matches!(ch, b'<' | b'>' | b'&' | b'|'))
                {
                    return None;
                }
                tokens.push(Token::Redirect);
            }
            b'#' => return None,
            _ => {
                words += 1;
                if words > POLICY_COMMAND_WORDS_MAX {
                    return None;
                }
                let start = i;
                let mut fragment = i;
                let mut joined: Option<String> = None;
                let mut quote = None;
                while i < bytes.len() {
                    let ch = bytes[i];
                    if ch == b'\\' && quote != Some(b'\'') {
                        return None;
                    }
                    if ch == b'\n' && quote.is_some() {
                        return None;
                    }
                    if quote.is_none()
                        && matches!(ch, b' ' | b'\n' | b';' | b'&' | b'|' | b'<' | b'>')
                    {
                        break;
                    }
                    if matches!(ch, b'\'' | b'"') && (quote.is_none() || quote == Some(ch)) {
                        joined
                            .get_or_insert_with(String::new)
                            .push_str(&command[fragment..i]);
                        quote = if quote.is_none() { Some(ch) } else { None };
                        i += 1;
                        fragment = i;
                    } else {
                        i += 1;
                    }
                }
                if quote.is_some() {
                    return None;
                }
                let word = if let Some(mut joined) = joined {
                    joined.push_str(&command[fragment..i]);
                    Cow::Owned(joined)
                } else {
                    Cow::Borrowed(&command[start..i])
                };
                if bytes.get(i).is_some_and(|ch| matches!(ch, b'<' | b'>'))
                    && !word.is_empty()
                    && word.bytes().all(|ch| ch.is_ascii_digit())
                {
                    return None;
                }
                tokens.push(Token::Word(word));
            }
        }
    }
    Some(tokens)
}
