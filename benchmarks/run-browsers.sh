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
# Usage: ./run-browsers.sh <bench-dir> <port> [options] [chrome|firefox ...]
#   ./run-browsers.sh wasm-core 8178 chrome firefox
#   ./run-browsers.sh ondemand-raf 8178 --iterations 5 chrome firefox
#   ./run-browsers.sh ondemand-raf 8178 --mode profile chrome
#
# Options:
#   --workspace N   dedicated Hyprland workspace (default 3)
#   --keep-going    try every browser even after one fails
#   --viewport WxH  fix the window size so raster pixel count is comparable
#   --iterations N  launch the browser N times and aggregate across processes
#   --warm          reuse one profile across iterations instead of a fresh one
#   --mode M        measure (default) or profile
set -euo pipefail
cd "$(dirname "$0")"

BENCH="${1:?usage: run-browsers.sh <bench-dir> <port> [options] [browsers...]}"
PORT="${2:?missing port}"
shift 2

WORKSPACE=3
KEEP_GOING=0
VIEWPORT=""
# One browser process per iteration. Page-internal trials cover algorithm jitter;
# only relaunching the process covers JIT tiering, GC, GPU cache and kernel
# scheduling, which is what a 652/945/954 ms spread across three invocations of the
# same benchmark actually was.
ITERATIONS=1
# Cold by default, which is what this runner has always done: a fresh profile per
# process isolates well, at the cost of re-creating cache and font state every run.
# --warm keeps one profile across a browser's iterations so steady-state numbers
# can be compared against the cold ones.
PROFILE_STATE=cold
# measure: the page starts on load, as before. profile: the page waits for
# window.__VECTO_BENCH__.start() so a tracer can attach first, and the bundle is
# built with --external so a flame chart maps back to Scene.ts.
MODE=measure
while true; do
  case "${1:-}" in
  --workspace)
    WORKSPACE="$2"
    shift 2
    ;;
  # Try every browser even after one fails, but still exit non-zero at the end.
  --keep-going)
    KEEP_GOING=1
    shift
    ;;
  --iterations)
    ITERATIONS="$2"
    shift 2
    ;;
  --warm)
    PROFILE_STATE=warm
    shift
    ;;
  --mode)
    MODE="$2"
    shift 2
    ;;
  # Fix the window size so raster pixel count is comparable between runs: a
  # default-sized window varies with monitor, DPR and browser chrome height, and
  # 900x700 at DPR 2 is four times the pixels of DPR 1.
  --viewport)
    VIEWPORT="$2"
    shift 2
    ;;
  *) break ;;
  esac
done
BROWSERS=("${@:-chrome}")

# Validate before launching anything: a typo'd mode must not silently produce
# measure-mode numbers under a profile label, or vice versa.
case "$MODE" in
measure | profile) ;;
*)
  echo "unknown --mode '$MODE' (expected measure or profile)" >&2
  exit 1
  ;;
esac
if ! [[ $ITERATIONS =~ ^[0-9]+$ ]] || [ "$ITERATIONS" -lt 1 ]; then
  echo "--iterations must be a positive integer, got '$ITERATIONS'" >&2
  exit 1
fi
# Profiler overhead makes these timings incomparable to measure-mode ones, so
# aggregating several of them into a median invites quoting the result as a
# measurement. One process per profile run.
if [ "$MODE" = profile ] && [ "$ITERATIONS" -gt 1 ]; then
  echo "--mode profile does not support --iterations > 1: profiler overhead makes" >&2
  echo "  these runs unquotable as measurements, so aggregating them is misleading" >&2
  exit 1
fi

BASE_URL="http://127.0.0.1:${PORT}/"
RESULTS="${BENCH}/results"
# Remember where the caller was (their terminal) so every exit path lands back
# there instead of stranding them on the benchmark workspace.
HOME_WORKSPACE=$(hyprctl activeworkspace -j | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null || echo 2)
# Completion = any *.json the page POSTs into <bench>/results/ that is newer than
# this run's start stamp. Generic on purpose, so any benchmark page works.
# One minute is enough for a normal run; extend once if the page is still
# working. The deliverable is the JSON the page POSTs, not anything on screen.
RUN_TIMEOUT=${RUN_TIMEOUT:-60} # per-browser budget before the one extension
RUN_EXTEND=${RUN_EXTEND:-180}  # one-shot extension if still working at the deadline
LOG="/tmp/vecto-bench-${BENCH//\//-}-server.log"
PIDFILE="/tmp/vecto-bench-${BENCH//\//-}-server.pid"
# Correlates the browser, the page, and the result file for THIS invocation.
# Without it, completion was "any *.json newer than a stamp", which could pick up
# an unrelated write, and the starvation check scanned every historical result so a
# days-old starved run kept re-warning on every future invocation.
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
COMMIT="$(git -C "$(dirname "$0")" rev-parse --short HEAD 2>/dev/null || echo unknown)"
# Warm profile directories, keyed by browser, when --warm is in effect. Reused
# across a browser's iterations and removed once its last one finishes.
declare -A WARM_PROFILES=()
# The profile dir of the run currently in flight, read by the EXIT trap.
CURRENT_PROFILE_DIR=""

start_server() {
  local pid
  # Only ever kill a server THIS SCRIPT started, recorded in a pidfile beside the
  # log. The previous lookup was `ss -ltnp | grep -oP "${PORT}.*pid=\K[0-9]+"`,
  # which matched the port number anywhere on the line — including inside another
  # socket's `pid=` field — and then killed it. That could terminate an unrelated
  # dev server, and the comment claiming the server was left running for reuse
  # contradicted the code, which killed and restarted it every invocation.
  if [ -f "$PIDFILE" ]; then
    pid=$(cat "$PIDFILE" 2>/dev/null || true)
    # Confirm identity before signalling: a recycled PID could be anything.
    if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] &&
      tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'serve\|server.ts'; then
      kill "$pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$PIDFILE"
  fi
  # Anything else already holding the port is left alone and reported, rather
  # than killed on this script's assumption that it must be stale.
  if ss -ltnH "sport = :${PORT}" 2>/dev/null | grep -q .; then
    echo "port ${PORT} is already in use by a process this script did not start;" >&2
    echo "  stop it yourself or pass a different port" >&2
    return 1
  fi
  # `_shared/server.ts` never exits on its own (it's a long-running HTTP server,
  # by design). `setsid --fork`
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
  (cd "$BENCH" && PORT="$PORT" setsid --fork bun run ../_shared/server.ts . >"$LOG" 2>&1 </dev/null) &
  disown
  # Record the server's PID so the next invocation can stop exactly this process
  # instead of guessing from the port.
  for _ in $(seq 1 20); do
    pid=$(ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    [ -n "$pid" ] && echo "$pid" >"$PIDFILE" && break
    sleep 0.2
  done
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null "$BASE_URL" && return 0
    sleep 0.3
  done
  echo "server failed to start; see $LOG" >&2
  return 1
}

# Address of a window of $1 on the dedicated workspace. Scoping the lookup to
# the workspace is what disambiguates our window from the user's own browser.
# Address of the benchmark window on the dedicated workspace.
#
# Class alone is not enough to identify it. A fresh Firefox profile can map a
# first-run/privacy-notice window alongside the benchmark, and this function used
# to `break` on the first class match — so focus could land on the wrong window
# while the benchmark ran unfocused, which throttles rAF and quietly collapses the
# frame count every per-frame figure divides by. Prefer a window whose title
# contains the benchmark's page title; fall back to class only when no titled
# match exists, so a page that has not set its title yet still resolves.
window_on_workspace() {
  hyprctl clients -j | python3 -c "
import json,sys
cls, ws, want = '$1', $WORKSPACE, '$2'.lower()
titled, any_match = None, None
for c in json.load(sys.stdin):
    if cls not in c.get('class','').lower() or c['workspace']['id'] != ws:
        continue
    if any_match is None:
        any_match = c['address']
    if want and want in c.get('title','').lower():
        titled = c['address']; break
print(titled or any_match or '')
" 2>/dev/null || true
}

# Close the benchmark window, confirm the browser process is really gone, and hop
# back to the caller's workspace so the terminal is foreground again.
#
# Closing the window is not the same as ending the process, and asking the page to
# close itself is not either. Firefox ignores `window.close()` for a window the
# page did not open (`dom.allow_scripts_to_close_windows` defaults to false), and
# closing its last window does not necessarily end the process. So a *successful*
# run left a whole Firefox behind holding its private-profile temp dir, and each
# further iteration added another — an 8-iteration two-engine suite ends with 8
# stray Firefoxes competing for CPU with the very runs being measured, which
# corrupts later iterations rather than merely wasting memory. Chrome happens to
# exit on its own, which is why this went unnoticed.
#
# The process is identified by its per-run profile directory: unique (`mktemp -d`)
# and present verbatim in the browser's argv. That is what makes this safe next to
# the user's own browser — no pattern like "firefox" is ever matched, only this
# run's private profile path.
terminate_browser() {
  local addr="$1" profile_dir="$2" waited=0

  if [ -n "$addr" ]; then
    hyprctl dispatch closewindow "address:$addr" >/dev/null 2>&1 || true
    sleep 0.5
  fi

  if [ -n "$profile_dir" ] && pgrep -f -- "$profile_dir" >/dev/null 2>&1; then
    # SIGTERM first: a clean exit lets the browser release its profile lock,
    # which is what allows the profile dir to be removed on RETURN.
    pkill -TERM -f -- "$profile_dir" 2>/dev/null || true
    # Up to 10s in half-second steps.
    while [ "$waited" -lt 20 ]; do
      pgrep -f -- "$profile_dir" >/dev/null 2>&1 || break
      sleep 0.5
      waited=$((waited + 1))
    done
    if pgrep -f -- "$profile_dir" >/dev/null 2>&1; then
      pkill -KILL -f -- "$profile_dir" 2>/dev/null || true
      sleep 0.5
    fi
    # Report rather than fail: the results are already collected by this point,
    # and a surviving process is a cleanup problem, not a bad measurement.
    if pgrep -f -- "$profile_dir" >/dev/null 2>&1; then
      echo "  warning: browser processes for $profile_dir survived SIGKILL" >&2
    fi
  fi

  hyprctl dispatch workspace "$HOME_WORKSPACE" >/dev/null 2>&1 || true
}

run_one() {
  local browser="$1" iteration="${2:-1}" bin class cmd addr waited out profile_dir
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
  if [ "$PROFILE_STATE" = warm ]; then
    # One profile reused across this browser's iterations, created on the first.
    # Deliberately NOT removed on RETURN — that is the entire difference from cold:
    # iteration 2 onward starts with the HTTP cache, the shader cache and the font
    # cache that iteration 1 populated. Cleaned up by the caller after the last
    # iteration.
    profile_dir="${WARM_PROFILES[$browser]:-}"
    if [ -z "$profile_dir" ]; then
      profile_dir=$(mktemp -d)
      WARM_PROFILES[$browser]="$profile_dir"
    fi
  else
    profile_dir=$(mktemp -d)
    trap 'rm -rf "$profile_dir"' RETURN
  fi
  # Published for the EXIT trap: an interrupt (Ctrl-C) or an unexpected death
  # skips every path in this function, so without this the in-flight browser
  # outlives the runner.
  CURRENT_PROFILE_DIR="$profile_dir"
  # One runId per (suite run, browser, iteration): the page echoes it back in its
  # POST, so completion is "the result for THIS run landed", not "some json got
  # newer". The iteration suffix is what keeps N processes from overwriting each
  # other in history/.
  #
  # The URL is single-quoted where it is interpolated into $cmd below, and must
  # stay that way. `hyprctl dispatch exec` hands the string to a shell, so an
  # unquoted `&` between query parameters is a background-job separator: the
  # browser received only `?runId=…`, everything after the first `&` was silently
  # dropped, and the page then fell back to its defaults — suiteRunId defaulted to
  # runId, and mode/gate/iteration never arrived at all. It looked like a working
  # run and produced a valid-looking result file.
  local run_id="${RUN_ID}-${browser}-i${iteration}"
  local URL="${BASE_URL}?runId=${run_id}&suiteRunId=${RUN_ID}&iteration=${iteration}&mode=${MODE}&profileState=${PROFILE_STATE}"
  local expected="$RESULTS/history"
  case "$browser" in
  chrome)
    # The window class must be derived from the binary that was actually found.
    # `class="chrome"` was wrong for Chromium: Hyprland reports its class as
    # `chromium`, and the lookup below tests `"chrome" in class.lower()`, which is
    # FALSE for "chromium" (verified in python3, not assumed). On a machine with
    # only Chromium installed the browser launched normally and the runner then
    # reported "no window appeared" until the timeout.
    if bin=$(command -v google-chrome-stable 2>/dev/null); then
      class="google-chrome"
    elif bin=$(command -v chromium 2>/dev/null); then
      class="chromium"
    elif bin=$(command -v google-chrome 2>/dev/null); then
      class="google-chrome"
    else
      bin=""
      class="chrome"
    fi
    local size=""
    [ -n "$VIEWPORT" ] && size="--window-size=${VIEWPORT/x/,}"
    cmd="$bin --incognito --new-window --user-data-dir=$profile_dir --no-first-run --no-default-browser-check $size '$URL'"
    ;;
  firefox)
    bin=$(command -v firefox || true)
    class="firefox"
    # --new-instance is the documented fix ("Open new instance, not a new
    # window in running instance" — `firefox --help`); --profile with a
    # fresh directory additionally avoids any profile-lock contention with
    # a concurrently running default-profile Firefox.
    #
    # A brand-new profile also opens Firefox's first-run pages, so a run mapped
    # TWO windows: the benchmark and a private-browsing/privacy-notice window.
    # That is not merely cosmetic. The second window competes for the compositor
    # and, worse, `window_on_workspace` matches on window class and takes the
    # first hit — so focus could land on the first-run window while the benchmark
    # ran unfocused, which throttles rAF. Seeding prefs into the throwaway
    # profile suppresses it. Every pref here only affects this temp profile.
    cat >"$profile_dir/user.js" <<'PREFS'
// Suppress the first-run/what's-new/privacy-notice windows and tabs.
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("startup.homepage_override_url", "");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.messaging-system.whatsNewPanel.enabled", false);
user_pref("browser.privatebrowsing.vpnpromourl", "");
user_pref("privacy.trackingprotection.introURL", "");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
// No session restore prompt, no crash-report nag, no default-browser check —
// each can map a window or a dialog that steals focus mid-run.
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
PREFS
    local size=""
    if [ -n "$VIEWPORT" ]; then
      size="--width=${VIEWPORT%x*} --height=${VIEWPORT#*x}"
    fi
    # The URL must be the ARGUMENT of --private-window, not a trailing positional.
    # `firefox --help` documents `--private-window [<url>]`, so the detached form
    #     --private-window … 'URL'
    # asked for an empty private window AND opened the URL separately: two mapped
    # windows, and the benchmark ran in the NON-private one (visible in a
    # screenshot — the benchmark had a normal toolbar while a second window sat on
    # "New Private Tab"). So the private-browsing isolation the flag was there for
    # was not applied to the measured page at all, and the extra window competed
    # for the compositor. Attaching the URL yields exactly one window, and it is
    # the private one — verified with hyprctl + grim.
    cmd="$bin --new-instance --profile $profile_dir $size --private-window '$URL'"
    ;;
  *)
    echo "unknown browser: $browser" >&2
    return 1
    ;;
  esac
  [ -z "$bin" ] && {
    echo "  $browser: not installed, skipping"
    return 0
  }

  mkdir -p "$RESULTS"
  # Detect completion by FRESHNESS, not by file count. Counting broke whenever a
  # result from an earlier (or aborted) run already existed: the count never
  # increased, so a finished run spun until the timeout and reported failure even
  # though its JSON had just been rewritten.
  # No stamp needed any more: the result filename contains this run's id, so
  # completion is an exact match rather than a freshness heuristic. The old
  # freshness test could be satisfied by any concurrent write into results/.
  find_result() {
    find "$expected" -name "*-${run_id}.json" 2>/dev/null | head -1
  }

  echo "  launching $browser on workspace $WORKSPACE (incognito)…"
  # The exec rule places the window before it maps, so it never flashes onto
  # whatever workspace happens to be active.
  hyprctl dispatch exec "[workspace $WORKSPACE] $cmd" >/dev/null
  hyprctl dispatch workspace "$WORKSPACE" >/dev/null
  sleep 3

  # A fast benchmark can POST its results and self-close before this loop ever
  # observes the window, so treat "results already landed" as success rather than
  # as a missing window.
  for _ in $(seq 1 60); do
    # Every benchmark page title starts with "vectojs" (see _shared/build.ts), which
    # no Firefox first-run window does — enough to tell them apart without the
    # runner needing to know each benchmark's exact title.
    addr=$(window_on_workspace "$class" vectojs)
    [ -n "$addr" ] && break
    out=$(find_result)
    if [ -n "$out" ]; then
      echo "  $browser -> $out (finished before its window was seen)"
      # No window address to close, but the process is still running and must
      # still be reaped — this early return used to leak it unconditionally.
      terminate_browser "" "$profile_dir"
      return 0
    fi
    sleep 0.5
  done
  if [ -z "$addr" ]; then
    out=$(find_result)
    if [ -n "$out" ]; then
      echo "  $browser -> $out"
      terminate_browser "" "$profile_dir"
      return 0
    fi
    echo "  $browser: no window appeared on workspace $WORKSPACE" >&2
    # It may have launched without ever mapping a window on this workspace; a
    # failed run must not leak a process either.
    terminate_browser "" "$profile_dir"
    return 1
  fi
  # Focus still matters even though nothing is captured: an unfocused window
  # throttles rAF and can be descheduled mid-measurement.
  hyprctl dispatch focuswindow "address:$addr" >/dev/null
  echo "  focused $addr"

  waited=0
  while [ "$waited" -lt "$timeout" ]; do
    out=$(find_result)
    if [ -n "$out" ]; then
      echo "  $browser -> $out"
      terminate_browser "$addr" "$profile_dir"
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
  terminate_browser "$addr" "$profile_dir"
  return 1
}

: >"$LOG" 2>/dev/null || true
# A server that fails to start must fail the script, not fall through to launching
# browsers against nothing and then reporting each as "no window appeared".
if ! start_server; then
  echo "server failed to start; see $LOG" >&2
  exit 1
fi
echo "serving $BENCH on $BASE_URL (runId $RUN_ID)"
# Return to the caller's workspace even if a run dies unexpectedly, and reap an
# in-flight browser: Ctrl-C during a run skips every cleanup path inside run_one.
trap 'terminate_browser "" "${CURRENT_PROFILE_DIR:-}"; hyprctl dispatch workspace "$HOME_WORKSPACE" >/dev/null 2>&1 || true' EXIT

# A failed browser must fail the script. `|| true` here meant a timeout or a
# browser that never launched still exited 0, so CI recorded a pass and any
# wrapper went on to read incomplete results, with the failure visible only in the
# terminal log.
status=0
for b in "${BROWSERS[@]}"; do
  for i in $(seq 1 "$ITERATIONS"); do
    [ "$ITERATIONS" -gt 1 ] && echo "  iteration $i/$ITERATIONS ($PROFILE_STATE)"
    if ! run_one "$b" "$i"; then
      status=1
      # A single failed iteration does not condemn the rest: the aggregate counts
      # invalid iterations separately, so 4 of 5 is still a usable median with an
      # explicit exclusion. Without --keep-going, though, a failure still stops the
      # suite as it always has.
      if [ "$KEEP_GOING" != 1 ]; then
        echo "  aborting after $b iteration $i failed (pass --keep-going to try the rest)" >&2
        break 2
      fi
    fi
  done
  # Drop the warm profile once this browser's iterations are done, so the next
  # browser starts from the same state this one did.
  if [ -n "${WARM_PROFILES[$b]:-}" ]; then
    rm -rf "${WARM_PROFILES[$b]}"
    unset "WARM_PROFILES[$b]"
  fi
done
# Warn loudly when a run was starved of animation frames.
#
# A benchmark driving requestAnimationFrame only gets frames while its window is
# visible. Switching workspace or letting another window raise itself mid-run
# leaves an arm with almost no frames, and per-frame figures computed from that
# denominator look like a large win. Rows carry a `starved` flag; surface it here
# so a bad run is obvious at the point of collection rather than after someone
# has quoted it.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$RESULTS/history" "$RUN_ID" <<'PY'
import glob, json, sys, os

# Scoped to THIS suite run. Globbing every result meant a starved run from days
# ago kept printing its warning on every future invocation, which trains people to
# ignore the warning that matters.
starved = []
for path in glob.glob(os.path.join(sys.argv[1], f'*-{sys.argv[2]}-*.json')):
    try:
        data = json.load(open(path))
    except Exception:
        continue
    for row in data.get('rows', []):
        if row.get('starved'):
            starved.append(
                f"  {data.get('engine','?')} {row.get('shape','?')}"
                f" {row.get('chunkRate','?')}/s {row.get('mode','?')}:"
                f" offered {row.get('streamOffered')} of ~{row.get('expectedFrames')}"
            )
if starved:
    print('')
    print('WARNING: rAF was starved in these arms — their per-frame numbers are NOT usable:')
    print('\n'.join(starved))
    print('  Keep the benchmark window focused and visible for the whole run')
    print('  (no workspace switching, no other browser raising itself).')
PY
fi

# Aggregate across processes. Only meaningful with more than one iteration, and
# deliberately skipped in profile mode, where the numbers are not quotable.
if [ "$ITERATIONS" -gt 1 ] && [ "$MODE" = measure ]; then
  echo ""
  echo "aggregating $ITERATIONS iteration(s) per browser:"
  # Never aggregates across engines — V8 and SpiderMonkey diverge enough that one
  # median over both describes no browser that exists.
  bun run _shared/aggregate.ts "$BENCH" "$RUN_ID" || status=1
fi

echo "results in $RESULTS/ (history/ keyed by runId, latest/ for the stable path)"
if [ "$ITERATIONS" -gt 1 ]; then
  echo "aggregate in $RESULTS/aggregate/ (median/p90/p95/MAD across processes)"
fi
echo "runId $RUN_ID  commit $COMMIT  mode $MODE  profile $PROFILE_STATE"
exit "$status"
