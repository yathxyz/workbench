//! The argv grammar of `wb` (spec §13.1). Usage errors exit 2.

use std::path::PathBuf;

/// The usage text printed on a grammar error.
pub const USAGE: &str = "usage: wb buf ls [--json]
       wb buf read NAME [--lines A:B] [--ver] [--json]
       wb buf write NAME --append|--replace [FILE|-] [--create] [--json]
       wb buf write NAME --patch FILE|- [--base VER] [--create] [--json]
       wb buf save NAME [--json]
       wb buf revert NAME [--json]
       wb eval FORM | -f FILE [--json]
       wb edit FILE [+LINE] [--wait] [--json]
       wb repl [--json]
";

/// A grammar error: the message, or empty when the usage text alone says enough.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Usage(pub String);

fn usage(msg: impl Into<String>) -> Usage {
    Usage(msg.into())
}

/// A parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    pub cmd: Command,
    /// `--json`: one JSON object per result on stdout.
    pub json: bool,
}

/// Where the text of a write or a patch comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    Stdin,
    File(PathBuf),
}

impl Input {
    fn parse(arg: &str) -> Input {
        if arg == "-" {
            Input::Stdin
        } else {
            Input::File(PathBuf::from(arg))
        }
    }
}

/// How `wb buf write` changes the buffer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteHow {
    Append(Input),
    Replace(Input),
    Patch { input: Input, base: Option<u64> },
}

/// `--lines A:B`, 1-based and inclusive; `to` absent means to the end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineRange {
    pub from: usize,
    pub to: Option<usize>,
}

impl LineRange {
    /// Parses `A:B`, `A:`, `:B` or `A`.
    fn parse(arg: &str) -> Result<LineRange, Usage> {
        let bad = || usage(format!("bad --lines {arg:?}: expected A:B (1-based)"));
        let (a, b) = match arg.split_once(':') {
            Some((a, b)) => (a, Some(b)),
            None => (arg, None),
        };
        let from = if a.is_empty() {
            1
        } else {
            a.parse::<usize>().map_err(|_| bad())?
        };
        let to = match b {
            None => Some(from),
            Some("") => None,
            Some(b) => Some(b.parse::<usize>().map_err(|_| bad())?),
        };
        if from == 0 || to == Some(0) || to.is_some_and(|to| to < from) {
            return Err(bad());
        }
        Ok(LineRange { from, to })
    }
}

/// The form `wb eval` sends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvalSource {
    Form(String),
    File(PathBuf),
}

/// One `wb` command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    BufLs,
    BufRead {
        name: String,
        lines: Option<LineRange>,
        ver: bool,
    },
    BufWrite {
        name: String,
        how: WriteHow,
        create: bool,
    },
    BufSave {
        name: String,
    },
    BufRevert {
        name: String,
    },
    Eval {
        source: EvalSource,
    },
    Edit {
        file: String,
        line: Option<u64>,
        wait: bool,
    },
    Repl,
}

/// Options that take a value (`--name VALUE` or `--name=VALUE`).
const VALUED: &[&str] = &["--lines", "--base", "--patch", "-f"];

/// Tokens split into positionals and options.
struct Split {
    pos: Vec<String>,
    opts: Vec<(String, Option<String>)>,
}

impl Split {
    fn new(tokens: &[String]) -> Result<Split, Usage> {
        let mut pos = Vec::new();
        let mut opts = Vec::new();
        let mut iter = tokens.iter();
        while let Some(tok) = iter.next() {
            if tok == "--" {
                pos.extend(iter.cloned());
                break;
            }
            let is_opt = (tok.starts_with("--") && tok.len() > 2) || tok == "-f";
            if !is_opt {
                pos.push(tok.clone());
                continue;
            }
            let (name, inline) = match tok.split_once('=') {
                Some((n, v)) => (n.to_owned(), Some(v.to_owned())),
                None => (tok.clone(), None),
            };
            let value = if VALUED.contains(&name.as_str()) {
                match inline {
                    Some(v) => Some(v),
                    None => Some(
                        iter.next()
                            .cloned()
                            .ok_or_else(|| usage(format!("{name} needs a value")))?,
                    ),
                }
            } else if inline.is_some() {
                return Err(usage(format!("{name} takes no value")));
            } else {
                None
            };
            opts.push((name, value));
        }
        Ok(Split { pos, opts })
    }

    /// Takes `--json` out and reports it.
    fn json(&mut self) -> bool {
        let before = self.opts.len();
        self.opts.retain(|(n, _)| n != "--json");
        self.opts.len() != before
    }

    /// Rejects options outside `allowed` and duplicates.
    fn check(&self, allowed: &[&str]) -> Result<(), Usage> {
        for (i, (name, _)) in self.opts.iter().enumerate() {
            if !allowed.contains(&name.as_str()) {
                return Err(usage(format!("unknown option {name}")));
            }
            if self.opts[..i].iter().any(|(n, _)| n == name) {
                return Err(usage(format!("{name} given twice")));
            }
        }
        Ok(())
    }

    fn has(&self, name: &str) -> bool {
        self.opts.iter().any(|(n, _)| n == name)
    }

    fn value(&self, name: &str) -> Option<&str> {
        self.opts
            .iter()
            .find(|(n, _)| n == name)
            .and_then(|(_, v)| v.as_deref())
    }

    /// Exactly `n` positionals, else a usage error.
    fn exactly(&self, n: usize, what: &str) -> Result<(), Usage> {
        if self.pos.len() == n {
            Ok(())
        } else {
            Err(usage(format!("expected {what}")))
        }
    }
}

fn parse_u64(name: &str, value: &str) -> Result<u64, Usage> {
    value.parse().map_err(|_| {
        usage(format!(
            "{name} needs a non-negative integer, got {value:?}"
        ))
    })
}

/// Parses the arguments after the program name.
pub fn parse(argv: &[String]) -> Result<Args, Usage> {
    let (head, rest) = argv.split_first().ok_or_else(|| usage(""))?;
    match head.as_str() {
        "buf" => parse_buf(rest),
        "eval" => {
            let mut s = Split::new(rest)?;
            let json = s.json();
            s.check(&["-f"])?;
            let source = match (s.value("-f"), s.pos.as_slice()) {
                (Some(file), []) => EvalSource::File(PathBuf::from(file)),
                (None, [form]) => EvalSource::Form(form.clone()),
                _ => return Err(usage("eval takes one FORM or -f FILE")),
            };
            Ok(Args {
                cmd: Command::Eval { source },
                json,
            })
        }
        "edit" => {
            let mut s = Split::new(rest)?;
            let json = s.json();
            s.check(&["--wait"])?;
            let mut file = None;
            let mut line = None;
            for p in &s.pos {
                if let Some(n) = p.strip_prefix('+')
                    && line.is_none()
                    && file.is_some()
                {
                    line = Some(parse_u64("+LINE", n)?);
                } else if file.is_none() {
                    file = Some(p.clone());
                } else {
                    return Err(usage("edit takes one FILE and an optional +LINE"));
                }
            }
            let file = file.ok_or_else(|| usage("edit needs a FILE"))?;
            Ok(Args {
                cmd: Command::Edit {
                    file,
                    line,
                    wait: s.has("--wait"),
                },
                json,
            })
        }
        "repl" => {
            let mut s = Split::new(rest)?;
            let json = s.json();
            s.check(&[])?;
            s.exactly(0, "no arguments after repl")?;
            Ok(Args {
                cmd: Command::Repl,
                json,
            })
        }
        "-h" | "--help" | "help" => Err(usage("")),
        other => Err(usage(format!("unknown command {other:?}"))),
    }
}

fn parse_buf(argv: &[String]) -> Result<Args, Usage> {
    let (sub, rest) = argv
        .split_first()
        .ok_or_else(|| usage("buf needs a subcommand"))?;
    let mut s = Split::new(rest)?;
    let json = s.json();
    let cmd = match sub.as_str() {
        "ls" => {
            s.check(&[])?;
            s.exactly(0, "no arguments after ls")?;
            Command::BufLs
        }
        "read" => {
            s.check(&["--lines", "--ver"])?;
            s.exactly(1, "NAME")?;
            let lines = s.value("--lines").map(LineRange::parse).transpose()?;
            Command::BufRead {
                name: s.pos[0].clone(),
                lines,
                ver: s.has("--ver"),
            }
        }
        "write" => {
            s.check(&["--append", "--replace", "--patch", "--base", "--create"])?;
            let modes = ["--append", "--replace", "--patch"]
                .iter()
                .filter(|m| s.has(m))
                .count();
            if modes != 1 {
                return Err(usage(
                    "write needs exactly one of --append, --replace, --patch",
                ));
            }
            let base = s
                .value("--base")
                .map(|v| parse_u64("--base", v))
                .transpose()?;
            if base.is_some() && !s.has("--patch") {
                return Err(usage("--base only goes with --patch"));
            }
            let how = if let Some(file) = s.value("--patch") {
                s.exactly(1, "NAME")?;
                WriteHow::Patch {
                    input: Input::parse(file),
                    base,
                }
            } else {
                let input = match s.pos.as_slice() {
                    [_] => Input::Stdin,
                    [_, file] => Input::parse(file),
                    _ => return Err(usage("expected NAME [FILE|-]")),
                };
                if s.has("--append") {
                    WriteHow::Append(input)
                } else {
                    WriteHow::Replace(input)
                }
            };
            Command::BufWrite {
                name: s.pos[0].clone(),
                how,
                create: s.has("--create"),
            }
        }
        "save" | "revert" => {
            s.check(&[])?;
            s.exactly(1, "NAME")?;
            let name = s.pos[0].clone();
            if sub == "save" {
                Command::BufSave { name }
            } else {
                Command::BufRevert { name }
            }
        }
        other => return Err(usage(format!("unknown buf subcommand {other:?}"))),
    };
    Ok(Args { cmd, json })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(line: &str) -> Result<Args, Usage> {
        let argv: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
        parse(&argv)
    }

    fn ok(line: &str) -> Args {
        p(line).unwrap_or_else(|e| panic!("{line}: {e:?}"))
    }

    #[test]
    fn buf_ls() {
        assert_eq!(
            ok("buf ls"),
            Args {
                cmd: Command::BufLs,
                json: false
            }
        );
        assert!(ok("buf ls --json").json);
        assert!(p("buf ls extra").is_err());
        assert!(p("buf ls --ver").is_err());
    }

    #[test]
    fn buf_read() {
        let a = ok("buf read notes/x.md --lines 3:5 --ver --json");
        assert!(a.json);
        assert_eq!(
            a.cmd,
            Command::BufRead {
                name: "notes/x.md".into(),
                lines: Some(LineRange {
                    from: 3,
                    to: Some(5)
                }),
                ver: true,
            }
        );
        let a = ok("buf read x --lines=7:");
        assert!(matches!(
            a.cmd,
            Command::BufRead {
                lines: Some(LineRange { from: 7, to: None }),
                ver: false,
                ..
            }
        ));
        assert!(matches!(
            ok("buf read x --lines :2").cmd,
            Command::BufRead {
                lines: Some(LineRange {
                    from: 1,
                    to: Some(2)
                }),
                ..
            }
        ));
        assert!(matches!(
            ok("buf read x --lines 4").cmd,
            Command::BufRead {
                lines: Some(LineRange {
                    from: 4,
                    to: Some(4)
                }),
                ..
            }
        ));
        assert!(p("buf read").is_err());
        assert!(p("buf read a b").is_err());
        assert!(p("buf read x --lines 0:3").is_err());
        assert!(p("buf read x --lines 5:3").is_err());
        assert!(p("buf read x --lines").is_err());
        assert!(p("buf read x --ver --ver").is_err());
    }

    #[test]
    fn buf_write() {
        assert_eq!(
            ok("buf write x --append").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Append(Input::Stdin),
                create: false
            }
        );
        assert_eq!(
            ok("buf write x --replace f.txt --create").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Replace(Input::File("f.txt".into())),
                create: true
            }
        );
        assert_eq!(
            ok("buf write x --append -").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Append(Input::Stdin),
                create: false
            }
        );
        assert_eq!(
            ok("buf write x --patch - --base 12").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Patch {
                    input: Input::Stdin,
                    base: Some(12)
                },
                create: false
            }
        );
        assert_eq!(
            ok("buf write x --patch=p.diff").cmd,
            Command::BufWrite {
                name: "x".into(),
                how: WriteHow::Patch {
                    input: Input::File("p.diff".into()),
                    base: None
                },
                create: false
            }
        );
        assert!(p("buf write x").is_err());
        assert!(p("buf write x --append --replace").is_err());
        assert!(p("buf write x --append --base 3").is_err());
        assert!(p("buf write x --patch").is_err());
        assert!(p("buf write x --patch p f").is_err());
        assert!(p("buf write x --append a b").is_err());
        assert!(p("buf write x --patch p --base x").is_err());
    }

    #[test]
    fn buf_save_revert() {
        assert_eq!(
            ok("buf save ~/a.md").cmd,
            Command::BufSave {
                name: "~/a.md".into()
            }
        );
        assert_eq!(
            ok("buf revert /etc/hosts --json").cmd,
            Command::BufRevert {
                name: "/etc/hosts".into()
            }
        );
        assert!(p("buf save").is_err());
        assert!(p("buf nope x").is_err());
        assert!(p("buf").is_err());
    }

    #[test]
    fn eval() {
        let argv = vec!["eval".to_owned(), "(+ 1 2)".to_owned()];
        assert_eq!(
            parse(&argv).unwrap().cmd,
            Command::Eval {
                source: EvalSource::Form("(+ 1 2)".into())
            }
        );
        assert_eq!(
            ok("eval -f x.scm --json").cmd,
            Command::Eval {
                source: EvalSource::File("x.scm".into())
            }
        );
        assert!(p("eval").is_err());
        assert!(p("eval -f").is_err());
        assert!(p("eval -f a (b)").is_err());
    }

    #[test]
    fn edit() {
        assert_eq!(
            ok("edit src/main.rs +12 --wait").cmd,
            Command::Edit {
                file: "src/main.rs".into(),
                line: Some(12),
                wait: true
            }
        );
        assert_eq!(
            ok("edit f").cmd,
            Command::Edit {
                file: "f".into(),
                line: None,
                wait: false
            }
        );
        assert!(p("edit").is_err());
        assert!(p("edit a b").is_err());
        assert!(p("edit a +x").is_err());
        assert!(p("edit a --lines 1:2").is_err());
    }

    #[test]
    fn repl_and_misc() {
        assert_eq!(ok("repl").cmd, Command::Repl);
        assert!(ok("repl --json").json);
        assert!(p("repl x").is_err());
        assert!(p("").is_err());
        assert!(p("frobnicate").is_err());
        assert!(p("--help").is_err());
    }

    #[test]
    fn double_dash_ends_options() {
        assert_eq!(
            ok("buf read -- --weird").cmd,
            Command::BufRead {
                name: "--weird".into(),
                lines: None,
                ver: false
            }
        );
    }
}
