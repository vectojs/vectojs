#!/usr/bin/env bash
# Run a benchmark page in real browsers and collect JSON results, unattended.
#
# Why not headless: a backgrounded or headless tab throttles rAF and often falls
# back to software rasterization, so its numbers are a same-environment
# regression signal at best. This drives the real browser on the real GPU.
#
# Three things make it reliable rather than fiddly:
#
#   * The browser is launched onto a DEDICATED Hyprland workspace via an exec
#     rule, so the window we then focus is provably the one we started — not
#     some pre-existing browser window that merely shares its class.
#   * Incognito / private mode, so extensions cannot perturb the measurement.
#   * The page POSTs its own results to the local server as JSON on completion,
#     so nothing has to be read off the screen and no screenshot is involved.
#
# Usage: ./run-browsers.sh <bench-dir> <port> [--workspace N] [chrome|firefox ...]
#   ./run-browsers.sh wasm-core 8178 chrome firefox
set -euo pipefail
cd "$(dirname "$0")"

BENCH="${1:?usage: run-browsers.sh <bench-dir> <port> [--workspace N] [browsers...]}"
PORT="${2:?missing port}"
shift 2

WORKSPACE=3
if [ "${1:-}" = "--workspace" ]; then
  WORKSPACE="$2"
  shift 2
fi
BROWSERS=("${@:-chrome}")

URL="http://127.0.0.1:${PORT}/"
RESULTS="${BENCH}/results"
# Remember where the caller was (their terminal) so every exit path lands back
# there instead of stranding them on the benchmark workspace.
HOME_WORKSPACE=$(hyprctl activeworkspace -j | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null || echo 2)
# Completion = any *.json the page POSTs into <bench>/results/ that is newer than
# this run's start stamp. Generic on purpose, so any benchmark page works.
# One minute is enough for a normal run; extend once if the page is still
# working. The deliverable is the JSON the page POSTs, not anything on screen.
RUN_TIMEOUT=${RUN_TIMEOUT:-60}   # per-browser budget before the one extension
RUN_EXTEND=${RUN_EXTEND:-180}    # one-shot extension if still working at the deadline
LOG="/tmp/${BENCH}-server.log"

start_server() {
  local pid
  pid=$(ss -ltnp 2>/dev/null | grep -oP "${PORT}.*pid=\K[0-9]+" | head -1 || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && sleep 1
  # `serve.ts` never exits on its own (it's a long-running HTTP server, by
  # design — left running so a later invocation can reuse it). `setsid --fork`
  # (not bare `setsid`, and `disown` alone does NOT substitute for this) is
  # required here: bash waits for the async children of a subshell/pipeline
  # component before it will actually exit, REGARDLESS of `disown` — this is
  # unconditional bash behavior (confirmed by removing every `set -e/-u/-m
  # /pipefail` option and reproducing it anyway), not a job-control tracking
  # bug, so it bites this script whenever its own output is piped (e.g. `|
  # tee`, common when a caller wants a saved log). `--fork` forces a real
  # double-fork: the immediate child exits right away and `bun` gets
  # reparented to the nearest subreaper (verified: PPID becomes `systemd
  # --user`'s PID, not this script's), so this script has no async child left
  # to wait for at all. Found via `cat /proc/<pid>/wchan` showing `do_wait` on
  # the driver script itself (not a stray child) over an hour after a run had
  # visibly completed, then confirmed with a minimal standalone repro outside
  # any of this script's other logic.
  (cd "$BENCH" && PORT="$PORT" setsid --fork bun run serve.ts >"/tmp/${BENCH}-server.log" 2>&1 </dev/null) &
  disown
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null "$URL" && return 0
    sleep 0.3
  done
  echo "server failed to start; see /tmp/${BENCH}-server.log" >&2
  return 1
}

# Address of a window of $1 on the dedicated workspace. Scoping the lookup to
# the workspace is what disambiguates our window from the user's own browser.
window_on_workspace() {
  hyprctl clients -j | python3 -c "
import json,sys
cls, ws = '$1', $WORKSPACE
for c in json.load(sys.stdin):
    if cls in c.get('class','').lower() and c['workspace']['id'] == ws:
        print(c['address']); break
" 2>/dev/null || true
}

# Close the benchmark window and hop back to the caller's workspace, so the
# terminal is foreground again the moment a run ends.
close_and_return() {
  hyprctl dispatch closewindow "address:$1" >/dev/null 2>&1 || true
  sleep 0.5
  hyprctl dispatch workspace "$HOME_WORKSPACE" >/dev/null 2>&1 || true
}

run_one() {
  local browser="$1" bin class cmd addr waited out before profile_dir
  local timeout=$RUN_TIMEOUT extend=$RUN_EXTEND
  # A fresh, disposable profile/user-data dir per run — not just for a clean
  # slate, but for correctness: both browsers default to a SINGLE-INSTANCE
  # lock tied to their default profile, so without this, `--incognito`/
  # `--private-window` against an already-running instance (e.g. the user's
  # own daily-driver browser) silently hands the request to that instance
  # instead of spawning a new one. That new window then opens wherever the
  # EXISTING instance's session already lives — not on `$WORKSPACE` — so
  # `window_on_workspace` never finds it (looks like "didn't launch"), and if
  # it's ever found by luck, the run's timing shares that instance's other
  # tabs/CPU/memory, contaminating whatever the benchmark measures. This
  # showed up as "Firefox takes a long time to start, sometimes doesn't start
  # at all" — confirmed via `hyprctl clients` showing the user's real Firefox
  # (a single window, workspace 1, running since before any benchmark) while
  # `ps` showed a dozen+ freshly-spawned Firefox content processes under that
  # SAME long-lived parent PID, timed to match the benchmark runs.
  profile_dir=$(mktemp -d)
  trap 'rm -rf "$profile_dir"' RETURN
  case "$browser" in
    chrome)
      bin=$(command -v google-chrome-stable || command -v chromium || true)
      class="chrome"
      cmd="$bin --incognito --new-window --user-data-dir=$profile_dir --no-first-run --no-default-browser-check $URL"
      ;;
    firefox)
      bin=$(command -v firefox || true)
      class="firefox"
      # --new-instance is the documented fix ("Open new instance, not a new
      # window in running instance" — `firefox --help`); --profile with a
      # fresh directory additionally avoids any profile-lock contention with
      # a concurrently running default-profile Firefox.
      cmd="$bin --private-window --new-instance --profile $profile_dir $URL"
      ;;
    *) echo "unknown browser: $browser" >&2; return 1 ;;
  esac
  [ -z "$bin" ] && { echo "  $browser: not installed, skipping"; return 0; }

  mkdir -p "$RESULTS"
  before=$(find "$RESULTS" -name "*.json" | wc -l)
  STAMP="$RESULTS/.stamp-$browser"; : >"$STAMP"; sleep 0.05

  echo "  launching $browser on workspace $WORKSPACE (incognito)…"
  # The exec rule places the window before it maps, so it never flashes onto
  # whatever workspace happens to be active.
  hyprctl dispatch exec "[workspace $WORKSPACE] $cmd" >/dev/null
  hyprctl dispatch workspace "$WORKSPACE" >/dev/null
  sleep 3

  for _ in $(seq 1 60); do
    addr=$(window_on_workspace "$class")
    [ -n "$addr" ] && break
    sleep 0.5
  done
  if [ -z "$addr" ]; then
    echo "  $browser: no window appeared on workspace $WORKSPACE" >&2
    return 1
  fi
  # Focus still matters even though nothing is captured: an unfocused window
  # throttles rAF and can be descheduled mid-measurement.
  hyprctl dispatch focuswindow "address:$addr" >/dev/null
  echo "  focused $addr"

  waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if [ "$(find "$RESULTS" -name "*.json" | wc -l)" -gt "$before" ]; then
      out=$(find "$RESULTS" -name "*.json" -newer "$STAMP" | head -1)
      echo "  $browser -> $out"
      close_and_return "$addr"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
    # Re-focus periodically: a window that loses focus mid-run throttles rAF.
    if [ $((waited % 20)) -eq 0 ]; then
      hyprctl dispatch workspace "$WORKSPACE" >/dev/null 2>&1 || true
      hyprctl dispatch focuswindow "address:$addr" >/dev/null 2>&1 || true
    fi
    # Still running at the deadline? Give it one extension rather than failing.
    if [ "$waited" -eq "$timeout" ] && [ "$extend" -gt 0 ]; then
      echo "  not finished at ${timeout}s — extending by ${extend}s"
      timeout=$((timeout + extend))
      extend=0
    fi
  done
  echo "  $browser timed out after ${timeout}s" >&2
  close_and_return "$addr"
  return 1
}

: >"$LOG" 2>/dev/null || true
start_server
echo "serving $BENCH on $URL"
# Return to the caller's workspace even if a run dies unexpectedly.
trap 'hyprctl dispatch workspace "$HOME_WORKSPACE" >/dev/null 2>&1 || true' EXIT

for b in "${BROWSERS[@]}"; do run_one "$b" || true; done
echo "results in $RESULTS/"
