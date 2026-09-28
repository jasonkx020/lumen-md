#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
run() {
  name=$1
  shift
  printf '%s\n' "$@" > /tmp/cmsg-test
  if .githooks/commit-msg /tmp/cmsg-test; then
    echo "$name -> PASS (exit 0)"
  else
    echo "$name -> FAIL (exit $?)"
  fi
}

run bad "bad message"
run good "feat(live): add export progress overlay"
run period "fix: oops."
run noblank "feat(live): subject" "body"
run withbody "feat(live): subject" "" "body"
run merge "Merge branch 'main' into feature"
