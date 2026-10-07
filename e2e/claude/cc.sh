#!/usr/bin/env bash
# Drives a nested Claude Code in tmux session `ar-e2e` (never the user's sessions):
#   cc.sh start DIR [claude args...]   start it in DIR with the mod loaded, trust the folder
#                                      (--model claude-opus-5-5 and --effort low unless the
#                                      args give their own)
#   cc.sh type TEXT                    type TEXT (literal), then Enter
#   cc.sh keys KEY...                  send tmux keys (Escape, Down, Enter, C-c, ...)
#   cc.sh screen                       print the screen
#   cc.sh wait REGEX [SECONDS]         wait until the screen matches REGEX (default 120 s)
#   cc.sh stop                         kill the session
# AR_E2E_SESSION names another tmux session; AR_E2E_PLUGIN_DIR loads the mod from another folder
# (a snapshot, so that saving the repo's files doesn't hot-reload a long run).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
name=${AR_E2E_SESSION:-ar-e2e}
# Exact names only: tmux falls back to a prefix match, so `-t ar-e2e` would reach
# `ar-e2e-long` while `ar-e2e` doesn't exist.
session="=$name"
pane="=$name:"

screen() { tmux capture-pane -t "$pane" -p; }

wait_for() {
  local pattern=$1 limit=${2:-120} waited=0
  until screen | grep -Eq -- "$pattern"; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$limit" ]; then
      echo "cc.sh: timed out after ${limit}s waiting for /$pattern/; screen:" >&2
      screen >&2
      return 1
    fi
  done
}

case "${1:-}" in
  start)
    dir=$2
    shift 2
    tmux kill-session -t "$session" 2>/dev/null || true
    args=""
    case " $* " in *" --effort "*) ;; *) args+=" --effort low" ;; esac
    case " $* " in *" --model "*) ;; *) args+=" --model claude-opus-5-5" ;; esac
    for arg in "$@"; do args+=" $(printf '%q' "$arg")"; done
    tmux new-session -d -s "$name" -x 180 -y 45 "cd $(printf '%q' "$dir") && \
      env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
          -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID -u CLAUDE_CODE_MESSAGING_SOCKET \
          -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT \
          -u CLAUDE_CODE_AUTO_COMPACT_WINDOW \
          claude --plugin-dir $(printf '%q' "${AR_E2E_PLUGIN_DIR:-$root/plugin}")$args; sleep 600"
    # A folder Claude Code has not seen opens on the trust prompt, "No, exit" preselected.
    for _ in $(seq 1 30); do
      sleep 1
      if screen | grep -q "trust"; then tmux send-keys -t "$pane" Down; sleep 0.3; tmux send-keys -t "$pane" Enter; break; fi
      if screen | grep -Eq "^\s*>|❯"; then break; fi
    done
    ;;
  type)
    tmux send-keys -t "$pane" -l "$2"
    sleep 0.3
    tmux send-keys -t "$pane" Enter
    ;;
  keys) shift; tmux send-keys -t "$pane" "$@" ;;
  screen) screen ;;
  wait) wait_for "$2" "${3:-120}" ;;
  stop) tmux kill-session -t "$session" 2>/dev/null || true ;;
  *) sed -n '2,11p' "$0" >&2; exit 2 ;;
esac
