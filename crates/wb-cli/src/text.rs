//! Edit ops (R7.5) over UTF-16 code units: encoding, application and inversion.

use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};

/// One op `[pos, del, ins]`: at UTF-16 offset `pos`, remove `del` and insert `ins`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Op {
    pub pos: usize,
    pub del: String,
    pub ins: String,
}

impl Op {
    pub fn new(pos: usize, del: impl Into<String>, ins: impl Into<String>) -> Op {
        Op {
            pos,
            del: del.into(),
            ins: ins.into(),
        }
    }

    pub fn to_value(&self) -> Value {
        json!([self.pos, self.del, self.ins])
    }

    pub fn from_value(v: &Value) -> Result<Op> {
        let arr = v
            .as_array()
            .ok_or_else(|| anyhow!("op is not an array: {v}"))?;
        let (Some(pos), Some(del), Some(ins)) = (
            arr.first().and_then(Value::as_u64),
            arr.get(1).and_then(Value::as_str),
            arr.get(2).and_then(Value::as_str),
        ) else {
            bail!("malformed op {v}");
        };
        Ok(Op::new(
            usize::try_from(pos).map_err(|_| anyhow!("op position {pos} too large"))?,
            del,
            ins,
        ))
    }

    /// The op that undoes this one on the text it produced.
    pub fn inverse(&self) -> Op {
        Op::new(self.pos, self.ins.clone(), self.del.clone())
    }
}

/// One sequenced batch from an `edits` message: the ops that produced version `ver`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Batch {
    pub ver: u64,
    pub ops: Vec<Op>,
}

/// The length of `s` in UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Applies `op` to a UTF-16 text, checking `del` against what is there (R7.7).
pub fn apply_op(text: &mut Vec<u16>, op: &Op) -> Result<()> {
    let del: Vec<u16> = op.del.encode_utf16().collect();
    let end = op.pos + del.len();
    if end > text.len() {
        bail!(
            "op at {} removing {} units runs past the end ({} units)",
            op.pos,
            del.len(),
            text.len()
        );
    }
    if text[op.pos..end] != del[..] {
        bail!("op at {} does not match the text it removes", op.pos);
    }
    text.splice(op.pos..end, op.ins.encode_utf16());
    Ok(())
}

/// Applies `ops` in order (R7.6).
#[cfg(test)]
pub fn apply_ops(text: &mut Vec<u16>, ops: &[Op]) -> Result<()> {
    ops.iter().try_for_each(|op| apply_op(text, op))
}

/// Applies `ops` to a string and returns the result.
#[cfg(test)]
pub fn apply_to_str(text: &str, ops: &[Op]) -> Result<String> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    apply_ops(&mut units, ops)?;
    String::from_utf16(&units).map_err(|_| anyhow!("ops split a surrogate pair"))
}

/// Reconstructs the text before `batches` were applied: the inverse of each batch is
/// applied from the newest batch to the oldest, inverting the ops of a batch in
/// reverse order.
pub fn rewind(text: &str, batches: &[Batch]) -> Result<String> {
    let mut units: Vec<u16> = text.encode_utf16().collect();
    let mut ordered: Vec<&Batch> = batches.iter().collect();
    ordered.sort_by_key(|b| std::cmp::Reverse(b.ver));
    for batch in ordered {
        for op in batch.ops.iter().rev() {
            apply_op(&mut units, &op.inverse())
                .map_err(|e| anyhow!("inverting version {}: {e}", batch.ver))?;
        }
    }
    String::from_utf16(&units).map_err(|_| anyhow!("history splits a surrogate pair"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_json_round_trip() {
        let op = Op::new(3, "a", "bc");
        assert_eq!(op.to_value(), json!([3, "a", "bc"]));
        assert_eq!(Op::from_value(&op.to_value()).unwrap(), op);
        assert!(Op::from_value(&json!([1, 2, 3])).is_err());
        assert!(Op::from_value(&json!("x")).is_err());
    }

    #[test]
    fn apply_checks_del() {
        assert_eq!(
            apply_to_str("hello", &[Op::new(1, "ell", "ipp")]).unwrap(),
            "hippo"
        );
        assert!(apply_to_str("hello", &[Op::new(1, "xll", "")]).is_err());
        assert!(apply_to_str("hello", &[Op::new(4, "lo", "")]).is_err());
    }

    #[test]
    fn positions_are_utf16_units() {
        // "😀" is two code units, so "b" sits at 3.
        assert_eq!(
            apply_to_str("a😀b", &[Op::new(3, "b", "c")]).unwrap(),
            "a😀c"
        );
        assert_eq!(len16("a😀b"), 4);
    }

    #[test]
    fn rewind_inverts_batches_newest_first() {
        // v1: "abc" -> v2: insert "X" at 1 -> "aXbc" -> v3: delete "bc", insert "Y" -> "aXY"
        let b2 = Batch {
            ver: 2,
            ops: vec![Op::new(1, "", "X")],
        };
        let b3 = Batch {
            ver: 3,
            ops: vec![Op::new(2, "bc", "Y"), Op::new(0, "a", "")],
        };
        // v3 text: "XY"
        let v3 = apply_to_str(&apply_to_str("abc", &b2.ops).unwrap(), &b3.ops).unwrap();
        assert_eq!(v3, "XY");
        // Given out of order on purpose.
        assert_eq!(rewind(&v3, &[b3.clone(), b2.clone()]).unwrap(), "abc");
        assert_eq!(rewind(&v3, &[b3]).unwrap(), "aXbc");
        // A batch that does not fit the text is an error, not a guess.
        assert!(rewind("zzz", &[b2]).is_err());
    }
}
