//! Session permission rules for cooperative ACP tool descriptions, not a sandbox.
//!
//! Paths are normalized lexically without consulting the filesystem. In particular,
//! a symlink beneath an allowed root is not resolved, and shell expansion is not
//! interpreted. Missing or malformed descriptions always leave the request to a user.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::limits::{
    POLICY_KIND_MAX, POLICY_PATTERN_MAX, POLICY_PATTERNS_MAX, POLICY_RULES_MAX,
    POLICY_SELECTORS_MAX,
};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub rules: Vec<Rule>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub action: Action,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub kinds: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub roots: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub command: Option<CommandPatterns>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandPatterns {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matches: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub not_matches: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Allow,
    Reject,
    Ask,
}

/// The zero-based rule index and action recorded alongside a policy decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyMatch {
    pub rule: usize,
    pub action: Action,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub rule: usize,
    pub action: Action,
    pub option_id: String,
}

#[derive(Debug)]
pub struct CompiledPolicy {
    rules: Vec<CompiledRule>,
    cwd: PathBuf,
}

#[derive(Debug)]
struct CompiledRule {
    action: Action,
    kinds: Option<Vec<String>>,
    roots: Option<Vec<PathBuf>>,
    matches: Vec<Regex>,
    not_matches: Vec<Regex>,
}

impl Policy {
    pub fn validate(&self) -> Result<(), String> {
        self.check_bounds()?;
        for rule in &self.rules {
            compile_patterns(rule.command.as_ref())?;
        }
        Ok(())
    }

    fn check_bounds(&self) -> Result<(), String> {
        if self.rules.len() > POLICY_RULES_MAX {
            return Err(format!("policy has more than {POLICY_RULES_MAX} rules"));
        }
        let mut patterns = 0;
        for (index, rule) in self.rules.iter().enumerate() {
            if let Some(kinds) = &rule.kinds
                && (kinds.len() > POLICY_SELECTORS_MAX
                    || kinds
                        .iter()
                        .any(|kind| !valid_text(kind) || kind.len() > POLICY_KIND_MAX))
            {
                return Err(format!("policy rule {index} has invalid kinds"));
            }
            if let Some(roots) = &rule.roots
                && (roots.len() > POLICY_SELECTORS_MAX
                    || roots.iter().any(|root| {
                        !valid_text(root) || (root != "$cwd" && !Path::new(root).is_absolute())
                    }))
            {
                return Err(format!("policy rule {index} has invalid roots"));
            }
            if let Some(command) = &rule.command {
                patterns += command.matches.len() + command.not_matches.len();
                if patterns > POLICY_PATTERNS_MAX {
                    return Err(format!(
                        "policy has more than {POLICY_PATTERNS_MAX} patterns"
                    ));
                }
                if command
                    .matches
                    .iter()
                    .chain(&command.not_matches)
                    .any(|pattern| pattern.len() > POLICY_PATTERN_MAX)
                {
                    return Err(format!("policy rule {index} has an oversized pattern"));
                }
            }
        }
        Ok(())
    }
}

impl CompiledPolicy {
    pub fn new(policy: &Policy, cwd: &str) -> Result<Self, String> {
        policy.check_bounds()?;
        if !valid_text(cwd) || !Path::new(cwd).is_absolute() {
            return Err("policy cwd must be an absolute path without NUL".into());
        }
        let cwd = normalize(Path::new(cwd));
        let mut rules = Vec::with_capacity(policy.rules.len());
        for rule in &policy.rules {
            let (matches, not_matches) = compile_patterns(rule.command.as_ref())?;
            rules.push(CompiledRule {
                action: rule.action,
                kinds: rule.kinds.clone(),
                roots: rule.roots.as_ref().map(|roots| {
                    roots
                        .iter()
                        .map(|root| {
                            if root == "$cwd" {
                                cwd.clone()
                            } else {
                                normalize(Path::new(root))
                            }
                        })
                        .collect()
                }),
                matches,
                not_matches,
            });
        }
        Ok(Self { rules, cwd })
    }

    /// First matching rule wins. `None` means ask, including a matching `ask` rule
    /// or an unavailable once-only option; neither falls through to later rules.
    pub fn decide(&self, tool_call: &Value, options: &[Value]) -> Option<Decision> {
        let call = tool_call.as_object()?;
        nonempty_string(call.get("toolCallId")?)?;
        nonempty_string(call.get("title")?)?;
        let kind = nonempty_string(call.get("kind")?)?;
        if kind.len() > POLICY_KIND_MAX {
            return None;
        }
        let command = if kind == "execute" {
            Some(nonempty_string(call.get("rawInput")?.get("command")?)?)
        } else {
            None
        };
        let command_paths = match command {
            Some(text) => literal_absolute_paths(text)?,
            None => Vec::new(),
        };
        let locations = call.get("locations")?.as_array()?;
        if locations.is_empty() {
            return None;
        }
        // Normalize once per location rather than once per candidate rule.
        let paths: Option<Vec<PathBuf>> = locations
            .iter()
            .map(|location| {
                let path = nonempty_string(location.get("path")?)?;
                let path = Path::new(path);
                Some(if path.is_absolute() {
                    normalize(path)
                } else {
                    normalize_from(path, self.cwd.clone())
                })
            })
            .collect();
        let paths = paths?;
        let (allow, reject) = once_options(options)?;
        for (index, rule) in self.rules.iter().enumerate() {
            if rule
                .kinds
                .as_ref()
                .is_some_and(|kinds| !kinds.iter().any(|k| k == kind))
            {
                continue;
            }
            if let Some(roots) = &rule.roots
                && (!paths.iter().all(|path| within_roots(path, roots))
                    || !command_paths.iter().all(|path| within_roots(path, roots)))
            {
                continue;
            }
            if let Some(command) = command
                && (!rule.matches.iter().all(|pattern| pattern.is_match(command))
                    || rule
                        .not_matches
                        .iter()
                        .any(|pattern| pattern.is_match(command)))
            {
                continue;
            }
            let option = match rule.action {
                Action::Allow => allow?,
                Action::Reject => reject?,
                Action::Ask => return None,
            };
            return Some(Decision {
                rule: index,
                action: rule.action,
                option_id: option.into(),
            });
        }
        None
    }
}

fn compile_patterns(command: Option<&CommandPatterns>) -> Result<(Vec<Regex>, Vec<Regex>), String> {
    let Some(command) = command else {
        return Ok((Vec::new(), Vec::new()));
    };
    let compile = |patterns: &[String]| {
        patterns
            .iter()
            .map(|pattern| {
                Regex::new(pattern)
                    .map_err(|error| format!("invalid policy command pattern: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()
    };
    Ok((compile(&command.matches)?, compile(&command.not_matches)?))
}

fn valid_text(text: &str) -> bool {
    !text.is_empty() && !text.contains('\0')
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| valid_text(text))
}

fn normalize(path: &Path) -> PathBuf {
    normalize_from(path, PathBuf::new())
}

fn normalize_from(path: &Path, mut normalized: PathBuf) -> PathBuf {
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// Inspect literal absolute paths at shell token/quote/operator boundaries. This
/// intentionally does not evaluate shell substitutions, expansions or symlinks.
fn literal_absolute_paths(command: &str) -> Option<Vec<PathBuf>> {
    let mut boundary = true;
    let mut quote = None;
    let mut quote_start = 0;
    let mut paths = Vec::new();
    for (start, character) in command.char_indices() {
        // Escaping and command substitution can obscure a literal path's extent.
        // This convenience matcher leaves ambiguous text to a human.
        if matches!(character, '\\' | '`') {
            return None;
        }
        if character == '/' && boundary {
            let rest = &command[start..];
            let end = if let Some(delimiter) = quote
                && quote_start + 1 == start
            {
                let end = rest.find(delimiter)?;
                // A quoted path concatenated with another token is ambiguous.
                if command[start + end + 1..]
                    .chars()
                    .next()
                    .is_some_and(|next| !token_boundary(next))
                {
                    return None;
                }
                end
            } else {
                let end = rest.find(token_boundary).unwrap_or(rest.len());
                if let Some(delimiter) = rest[end..]
                    .chars()
                    .next()
                    .filter(|ch| matches!(ch, '\'' | '"'))
                    && (quote != Some(delimiter)
                        || command[start + end + 1..]
                            .chars()
                            .next()
                            .is_some_and(|next| !token_boundary(next)))
                {
                    return None;
                }
                end
            };
            paths.push(normalize(Path::new(&rest[..end])));
            // Keep scanning even inside this path: punctuation-delimited paths
            // such as PATH=/tmp:/etc and quoted JSON must not hide a second one.
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
                quote_start = start;
            }
        }
        boundary = token_boundary(character);
    }
    quote.is_none().then_some(paths)
}

fn token_boundary(character: char) -> bool {
    character.is_whitespace()
        || matches!(
            character,
            ';' | '|'
                | '&'
                | '<'
                | '>'
                | '('
                | ')'
                | '='
                | ':'
                | ','
                | '['
                | ']'
                | '{'
                | '}'
                | '\''
                | '"'
                | '`'
        )
}

fn once_options(options: &[Value]) -> Option<(Option<&str>, Option<&str>)> {
    let mut allow = None;
    let mut reject = None;
    let mut ids = HashSet::with_capacity(options.len());
    for option in options {
        let id = nonempty_string(option.get("optionId")?)?;
        nonempty_string(option.get("name")?)?;
        if !ids.insert(id) {
            return None;
        }
        match option.get("kind")?.as_str()? {
            "allow_once" => {
                if allow.is_none() {
                    allow = Some(id);
                }
            }
            "reject_once" => {
                if reject.is_none() {
                    reject = Some(id);
                }
            }
            "allow_always" | "reject_always" => {}
            _ => return None,
        }
    }
    Some((allow, reject))
}

/// Decode a present optional field without accepting JSON null. Combine with
/// `#[serde(default)]` so omission alone means `None`.
pub fn deserialize_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub(crate) fn deserialize_optional_policy<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Policy>, D::Error> {
    Ok(Option::<Policy>::deserialize(deserializer)?.filter(|policy| !policy.rules.is_empty()))
}

pub(crate) fn optional_policy_is_empty(policy: &Option<Policy>) -> bool {
    policy.as_ref().is_none_or(|policy| policy.rules.is_empty())
}
