#!/usr/bin/env bash
# Runs one command for the autoresearch mod the way pi-autoresearch's run_experiment ran
# it in-process: `bash -c <command>` in a process group of its own, stdin from /dev/null,
# stderr merged into stdout, with a timeout that kills the whole group. The mod reads this
# script's stdout as the command's output ($.process.spawn), which has no timeout and no
# process-group kill of its own; this script supplies both.
#
#   run-experiment.sh [--stderr-file FILE] TIMEOUT_S TIMEOUT_MARKER FULL_LOG -- COMMAND
#
# TIMEOUT_S       seconds before the group gets TERM (0: never); KILL follows 5 s later
# TIMEOUT_MARKER  created when the timeout fired, so a TERM the command sent itself
#                 is not taken for one
# FULL_LOG        every byte of output, as it came (tee)
# --stderr-file   keep stderr apart, in FILE, instead of merging it (checks.sh)
#
# Exits with the command's status. TERM, INT or HUP to this script, or this script dying
# any other way (the mod's stream ended: Esc), takes the command's group down with it.

set -u
set -o pipefail

stderr_file=""
if [ "${1:-}" = "--stderr-file" ]; then
  stderr_file=$2
  shift 2
fi

if [ "$#" -ne 5 ] || [ "$4" != "--" ]; then
  echo "usage: run-experiment.sh [--stderr-file FILE] TIMEOUT_S TIMEOUT_MARKER FULL_LOG -- COMMAND" >&2
  exit 2
fi

timeout_s=$1
marker=$2
full_log=$3
command=$5
self=$$
grace_s=5

# Job control gives each background job a process group of its own.
set -m

if [ -n "$stderr_file" ]; then
  bash -c "$command" </dev/null 2>"$stderr_file" | tee "$full_log" &
else
  bash -c "$command" </dev/null 2>&1 | tee "$full_log" &
fi
group=$(jobs -p %1)

kill_group() {
  kill -TERM -- "-$group" 2>/dev/null
  ( sleep "$grace_s"; kill -KILL -- "-$group" 2>/dev/null ) >/dev/null 2>&1 &
}

timer=""
case "$timeout_s" in
  0 | 0.0 | "" | -*) ;;
  *)
    (
      sleep "$timeout_s"
      : >"$marker"
      kill -TERM -- "-$group" 2>/dev/null
      sleep "$grace_s"
      kill -KILL -- "-$group" 2>/dev/null
    ) >/dev/null 2>&1 &
    timer=$!
    ;;
esac

# If this script is killed outright (SIGKILL from the host), nothing runs here: the
# guard sees it gone and takes the group down.
(
  while kill -0 "$self" 2>/dev/null; do sleep 0.5; done
  [ -n "$timer" ] && kill -- "-$timer" 2>/dev/null
  kill -TERM -- "-$group" 2>/dev/null
  sleep "$grace_s"
  kill -KILL -- "-$group" 2>/dev/null
) >/dev/null 2>&1 &
guard=$!

stop_helpers() {
  [ -n "$timer" ] && kill -- "-$timer" 2>/dev/null
  kill -- "-$guard" 2>/dev/null
}

on_signal() {
  kill_group
  stop_helpers
  exit 143
}
trap on_signal TERM INT HUP

wait %1
status=$?

stop_helpers
exit "$status"
