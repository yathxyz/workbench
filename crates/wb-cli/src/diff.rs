//! A minimal diff between two texts as edit ops: Myers over lines, then each changed
//! span is shrunk by its common prefix and suffix at the character level, so one
//! changed word costs one small op and markers elsewhere survive (§13.1).

use crate::text::{Op, len16};

/// Edit steps beyond which the differing middle is replaced as one span, bounding the
/// trace memory of Myers at about `MAX_D²/2` words.
const MAX_D: usize = 2000;

/// A changed region: lines `old_lo..old_hi` of the old text become `new_lo..new_hi`.
type Hunk = (usize, usize, usize, usize);

/// The ops that turn `old` into `new`, in order, with UTF-16 positions.
pub fn diff_ops(old: &str, new: &str) -> Vec<Op> {
    if old == new {
        return Vec::new();
    }
    let a: Vec<&str> = old.split_inclusive('\n').collect();
    let b: Vec<&str> = new.split_inclusive('\n').collect();
    let mut p = 0;
    while p < a.len() && p < b.len() && a[p] == b[p] {
        p += 1;
    }
    let mut s = 0;
    while s < a.len() - p && s < b.len() - p && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
        s += 1;
    }
    let hunks = line_hunks(&a[p..a.len() - s], &b[p..b.len() - s]);

    let mut starts = Vec::with_capacity(a.len() + 1);
    let mut acc = 0;
    for line in &a {
        starts.push(acc);
        acc += len16(line);
    }
    starts.push(acc);

    let mut ops = Vec::new();
    let (mut inserted, mut removed) = (0usize, 0usize);
    for (ol, oh, nl, nh) in hunks {
        let (ol, oh, nl, nh) = (ol + p, oh + p, nl + p, nh + p);
        let old_text = a[ol..oh].concat();
        let new_text = b[nl..nh].concat();
        let (pre, suf) = common_affixes(&old_text, &new_text);
        let del = &old_text[pre..old_text.len() - suf];
        let ins = &new_text[pre..new_text.len() - suf];
        if del.is_empty() && ins.is_empty() {
            continue;
        }
        let pos = starts[ol] + len16(&old_text[..pre]) + inserted - removed;
        inserted += len16(ins);
        removed += len16(del);
        ops.push(Op::new(pos, del, ins));
    }
    ops
}

/// Byte lengths of the common prefix and of the common suffix of the remainders, both
/// on character boundaries.
fn common_affixes(a: &str, b: &str) -> (usize, usize) {
    let pre = a
        .char_indices()
        .zip(b.chars())
        .take_while(|((_, ca), cb)| ca == cb)
        .last()
        .map_or(0, |((i, c), _)| i + c.len_utf8());
    let (ra, rb) = (&a[pre..], &b[pre..]);
    let suf = ra
        .char_indices()
        .rev()
        .zip(rb.chars().rev())
        .take_while(|((_, ca), cb)| ca == cb)
        .last()
        .map_or(0, |((i, _), _)| ra.len() - i);
    (pre, suf)
}

/// The changed regions between two line sequences, in order.
fn line_hunks(a: &[&str], b: &[&str]) -> Vec<Hunk> {
    let (n, m) = (a.len(), b.len());
    if n == 0 && m == 0 {
        return Vec::new();
    }
    let Some(matches) = lcs_matches(a, b) else {
        return vec![(0, n, 0, m)];
    };
    let mut hunks = Vec::new();
    let (mut pi, mut pj) = (0, 0);
    for (i, j) in matches {
        if i > pi || j > pj {
            hunks.push((pi, i, pj, j));
        }
        pi = i + 1;
        pj = j + 1;
    }
    if n > pi || m > pj {
        hunks.push((pi, n, pj, m));
    }
    hunks
}

/// Myers' O(ND) shortest edit script: the matched line pairs `(i, j)` of a longest
/// common subsequence, or `None` past [`MAX_D`] edit steps.
fn lcs_matches(a: &[&str], b: &[&str]) -> Option<Vec<(usize, usize)>> {
    let (n, m) = (a.len(), b.len());
    // rounds[d][(k + d) / 2] is the furthest x reached on diagonal k after d steps.
    let mut rounds: Vec<Vec<usize>> = Vec::new();
    let slot = |d: usize, k: isize| -> usize {
        usize::try_from(k + isize::try_from(d).unwrap_or(isize::MAX))
            .map(|i| i / 2)
            .unwrap_or(0)
    };
    // Whether the step into (d, k) comes from the diagonal above (an insertion).
    let from_above = |rounds: &[Vec<usize>], d: usize, k: isize| -> bool {
        let di = isize::try_from(d).unwrap_or(isize::MAX);
        let prev = &rounds[d - 1];
        k != di && (k == -di || prev[slot(d - 1, k - 1)] < prev[slot(d - 1, k + 1)])
    };
    let mut found = false;
    for d in 0..=(n + m).min(MAX_D) {
        let di = isize::try_from(d).unwrap_or(isize::MAX);
        let mut cur = vec![0usize; d + 1];
        let mut k = -di;
        while k <= di {
            let mut x = if d == 0 {
                0
            } else if from_above(&rounds, d, k) {
                rounds[d - 1][slot(d - 1, k + 1)]
            } else {
                rounds[d - 1][slot(d - 1, k - 1)] + 1
            };
            let mut y = x.checked_add_signed(-k).unwrap_or(0);
            while x < n && y < m && a[x] == b[y] {
                x += 1;
                y += 1;
            }
            cur[slot(d, k)] = x;
            if x >= n && y >= m {
                found = true;
                break;
            }
            k += 2;
        }
        rounds.push(cur);
        if found {
            break;
        }
    }
    if !found {
        return None;
    }
    let mut matches = Vec::new();
    let (mut x, mut y) = (n, m);
    for d in (0..rounds.len()).rev() {
        let (px, py) = if d == 0 {
            (0, 0)
        } else {
            let k = isize::try_from(x).unwrap_or(0) - isize::try_from(y).unwrap_or(0);
            let pk = if from_above(&rounds, d, k) {
                k + 1
            } else {
                k - 1
            };
            let px = rounds[d - 1][slot(d - 1, pk)];
            (px, px.checked_add_signed(-pk).unwrap_or(0))
        };
        while x > px && y > py {
            x -= 1;
            y -= 1;
            matches.push((x, y));
        }
        x = px;
        y = py;
    }
    matches.reverse();
    Some(matches)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::apply_to_str;

    fn check(old: &str, new: &str) -> Vec<Op> {
        let ops = diff_ops(old, new);
        assert_eq!(
            apply_to_str(old, &ops).unwrap_or_else(|e| panic!("{old:?} -> {new:?}: {e}")),
            new,
            "ops {ops:?} do not turn {old:?} into {new:?}"
        );
        ops
    }

    #[test]
    fn identical_is_empty() {
        assert!(check("a\nb\n", "a\nb\n").is_empty());
        assert!(check("", "").is_empty());
    }

    #[test]
    fn one_word_is_one_small_op() {
        let ops = check("hello\nworld\nbye\n", "hello\nthere\nbye\n");
        assert_eq!(ops, vec![Op::new(6, "world", "there")]);
    }

    #[test]
    fn append_and_prepend() {
        assert_eq!(check("a\n", "a\nb\n"), vec![Op::new(2, "", "b\n")]);
        assert_eq!(check("a\n", "z\na\n"), vec![Op::new(0, "", "z\n")]);
        assert_eq!(check("", "x\n"), vec![Op::new(0, "", "x\n")]);
        assert_eq!(check("x\n", ""), vec![Op::new(0, "x\n", "")]);
    }

    #[test]
    fn several_hunks_keep_positions_in_sequence() {
        let ops = check("a\nb\nc\nd\ne\n", "a\nB\nc\nd\nE\nf\n");
        // The shared trailing newline of the last hunk is kept.
        assert_eq!(ops, vec![Op::new(2, "b", "B"), Op::new(8, "e", "E\nf")]);
    }

    #[test]
    fn deletion_in_the_middle() {
        let ops = check("one\ntwo\nthree\n", "one\nthree\n");
        assert_eq!(ops, vec![Op::new(4, "two\n", "")]);
    }

    #[test]
    fn surrogate_pairs_count_two_units_and_never_split() {
        // "😀" is one char, two UTF-16 units.
        let ops = check("a😀b\n", "a😀c\n");
        assert_eq!(ops, vec![Op::new(3, "b", "c")]);
        let ops = check("😀😀\n", "😀😁\n");
        assert_eq!(ops, vec![Op::new(2, "😀", "😁")]);
        let ops = check("x\n😀\n", "x\n\n");
        assert_eq!(ops, vec![Op::new(2, "😀", "")]);
    }

    #[test]
    fn last_line_without_newline() {
        assert_eq!(check("a\nb", "a\nb\n"), vec![Op::new(3, "", "\n")]);
        assert_eq!(check("a\nb\n", "a\nb"), vec![Op::new(3, "\n", "")]);
        assert_eq!(check("ab", "ac"), vec![Op::new(1, "b", "c")]);
    }

    #[test]
    fn crlf_free_text_with_bare_cr_is_handled_as_characters() {
        // A bare "\r" is just a character inside a line.
        let ops = check("a\rb\n", "a\rc\n");
        assert_eq!(ops, vec![Op::new(2, "b", "c")]);
    }

    #[test]
    fn common_affixes_stay_on_char_boundaries() {
        assert_eq!(common_affixes("héllo", "héllo"), (6, 0));
        assert_eq!(common_affixes("héllo", "hállo"), (1, 3));
        assert_eq!(common_affixes("aé", "bé"), (0, 2));
        assert_eq!(common_affixes("", "x"), (0, 0));
    }

    /// A small deterministic generator for random line sequences.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn text(&mut self) -> String {
            let n = self.next() % 12;
            (0..n)
                .map(|_| match self.next() % 5 {
                    0 => "alpha\n",
                    1 => "beta\n",
                    2 => "γάμμα\n",
                    3 => "😀\n",
                    _ => "",
                })
                .collect()
        }
    }

    #[test]
    fn random_texts_round_trip() {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        for _ in 0..500 {
            let old = rng.text();
            let new = rng.text();
            check(&old, &new);
        }
    }

    #[test]
    fn ops_are_minimal_in_line_count() {
        // Myers finds the LCS, so unchanged lines are never touched.
        let old: String = (0..200).map(|i| format!("line {i}\n")).collect();
        let new = old
            .replace("line 50\n", "LINE 50\n")
            .replace("line 150\n", "");
        let ops = check(&old, &new);
        assert_eq!(ops.len(), 2);
        // Ten 7-unit lines then forty 8-unit lines precede "line 50".
        assert_eq!(ops[0], Op::new(70 + 320, "line", "LINE"));
    }
}
