#!/usr/bin/env bash
# Run the browser check's pinned binaries in a disposable loopback-only namespace.
set -eu
cd "$(dirname "$0")/.."
if [[ $# == 0 ]]; then echo "usage: bash tests/run-front-bench.sh ENTRYPOINT [ARG ...]" >&2; exit 2; fi
if [[ ! ${WB_PLAYWRIGHT:-} || ! ${WB_WEB_ROOT:-} ]]; then
  exec nix develop .#checks.x86_64-linux.ui -c bash tests/run-front-bench.sh "$@"
fi
workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
mkdir "$workspace/tmp" "$workspace/home"
export TMPDIR="$workspace/tmp" HOME="$workspace/home" WB_HARNESS="$PWD/tests/harness.py" WB_HARNESS_TCP=1
export WB_WEB_ROOT="${WB_BENCH_ROOT:-$WB_WEB_ROOT}"
unshare -Urn bash -ec '
  ip link set lo up
  entry=tests/$1; shift
  case "$entry" in *.py) exec python3 -I "$entry" "$@";; *.mts) exec node "$entry" "$@";; *) exit 2;; esac
' -- "$@"
