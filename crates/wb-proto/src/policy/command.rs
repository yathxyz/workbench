//! A literal shell-word subset. Unsupported syntax is evidence to ask, not to ignore.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::limits::{
    POLICY_COMMAND_MAX, POLICY_COMMAND_WORDS_MAX, POLICY_CWDS_MAX, POLICY_PATH_BYTES_MAX,
    POLICY_PATHS_MAX,
};

use super::{nonempty_string, normalize_from};

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

    fn word(
        &mut self,
        word: &str,
        dirs: &BTreeSet<PathBuf>,
        cd: bool,
    ) -> Option<BTreeSet<PathBuf>> {
        let mut fragments = BTreeSet::new();
        if word.contains(['=', ':', ',']) {
            for fragment in word.split(['=', ':', ',']) {
                fragments.insert(fragment);
                if fragments.len() > POLICY_PATHS_MAX {
                    return None;
                }
            }
            for (index, ch) in word.char_indices() {
                if matches!(ch, '=' | ':' | ',') {
                    fragments.insert(&word[..index]);
                    fragments.insert(&word[index + 1..]);
                    if fragments.len() > POLICY_PATHS_MAX {
                        return None;
                    }
                }
            }
            fragments.remove(word);
        }
        let mut changed = BTreeSet::new();
        for fragment in std::iter::once(word).chain(fragments) {
            if fragment.starts_with('~') {
                return None;
            }
            let is_cd = cd && fragment == word;
            if !is_cd && !fragment.contains('/') && !matches!(fragment, "." | "..") {
                continue;
            }
            for dir in dirs {
                let path = self.resolve(fragment, dir)?;
                if is_cd {
                    changed.insert(path.clone());
                }
                self.unique.insert(path);
            }
        }
        Some(changed)
    }
}

pub(super) fn paths(
    command: Option<&str>,
    locations: &[Value],
    cwd: &Path,
) -> Option<BTreeSet<PathBuf>> {
    if locations.is_empty() || locations.len() > POLICY_PATHS_MAX {
        return None;
    }
    let mut paths = Paths {
        unique: BTreeSet::new(),
        candidates: 0,
        bytes: 0,
    };
    for location in locations {
        let text = nonempty_string(location.get("path")?)?;
        let path = paths.resolve(text, cwd)?;
        paths.unique.insert(path);
    }
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
            for simple in &pipeline.commands {
                let cd = command_cd(simple)?;
                // A pipeline's builtins run in shell-dependent subshell contexts.
                if cd && pipeline.commands.len() != 1 {
                    return None;
                }
                for (index, word) in simple.args.iter().enumerate() {
                    let next = paths.word(word, &dirs, cd && index == 1)?;
                    if cd && index == 1 {
                        changed = Some(next);
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
    Some(paths.unique)
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

fn command_cd(simple: &Simple<'_>) -> Option<bool> {
    let index = simple.args.iter().position(|word| !assignment(word))?;
    let name = simple.args[index].as_ref();
    if matches!(
        name,
        "eval"
            | "exec"
            | "source"
            | "."
            | "pushd"
            | "popd"
            | "command"
            | "builtin"
            | "if"
            | "then"
            | "else"
            | "elif"
            | "fi"
            | "while"
            | "until"
            | "do"
            | "done"
            | "for"
            | "in"
            | "case"
            | "esac"
            | "function"
            | "select"
            | "time"
            | "coproc"
            | "!"
    ) {
        return None;
    }
    // Nested shell programs are not part of the modeled command grammar.
    if matches!(
        Path::new(name).file_name()?.to_str()?,
        "sh" | "bash" | "dash" | "zsh" | "ksh" | "fish"
    ) {
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
        return Some(true);
    }
    (!name.is_empty()).then_some(false)
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
