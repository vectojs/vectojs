#!/usr/bin/env bash
# Reusable real-hardware selection-diff driver (CTX-0018). Serves a prebuilt
# surface page, launches a REAL browser foregrounded on a dedicated Hyprland
# workspace (isolated profile — never touches the user's browser), lets the page
# self-report its DOM-vs-canvas selection drift as JSON, grabs a grim screenshot,
# and returns home. Works for both engines and any DPR/zoom.
#
#   ./drive.sh <chrome|firefox> <page-dir> <port> <out.png> <out.json> [workspace]
#
# DPR/zoom: pass DPR=1.5 ZOOM=0.9 as env vars.
#   Chrome  → --force-device-scale-factor + a zoom querystring the page honors.
#   Firefox → layout.css.devPixelsPerPx pref + full-zoom pref in the temp profile.
set -euo pipefail

ENGINE="${1:?chrome|firefox}"
PAGE_DIR="${2:?page dir}"
PORT="${3:-8210}"
OUT_PNG="${4:?out.png}"
OUT_JSON="${5:?out.json}"
WORKSPACE="${6:-3}"
DPR="${DPR:-1}"
ZOOM="${ZOOM:-1}"
URL="http://127.0.0.1:${PORT}/?dpr=${DPR}&zoom=${ZOOM}"
HERE="$(cd "$(dirname "$0")" && pwd)"

HOME_WS=$(hyprctl activeworkspace -j | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])' 2>/dev/null || echo 2)
: >"$OUT_JSON"

cleanup() {
  [ -n "${WIN_ADDR:-}" ] && hyprctl dispatch closewindow "address:$WIN_ADDR" >/dev/null 2>&1 || true
  [ -n "${SERVE_PID:-}" ] && kill "$SERVE_PID" >/dev/null 2>&1 || true
  [ -n "${FF_PROFILE:-}" ] && rm -rf "$FF_PROFILE" >/dev/null 2>&1 || true
  hyprctl dispatch workspace "$HOME_WS" >/dev/null 2>&1 || true
}
trap cleanup EXIT

bun "$HERE/serve.ts" "$PORT" "$PAGE_DIR" "$OUT_JSON" &
SERVE_PID=$!
sleep 1

if [ "$ENGINE" = "chrome" ]; then
  CLS="chrome"
  hyprctl dispatch exec \
    "[workspace $WORKSPACE] google-chrome-stable --incognito --new-window --force-device-scale-factor=$DPR --window-size=1200,700 $URL" >/dev/null
else
  CLS="firefox"
  FF_PROFILE="$(mktemp -d /tmp/agents/sel-ff-XXXXXX)"
  cat >"$FF_PROFILE/user.js" <<PREFS
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.firstRunURL", "");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("layout.css.devPixelsPerPx", "$DPR");
user_pref("browser.zoom.full", true);
PREFS
  hyprctl dispatch exec \
    "[workspace $WORKSPACE] firefox --no-remote --profile $FF_PROFILE $URL" >/dev/null
fi
hyprctl dispatch workspace "$WORKSPACE" >/dev/null

# Find our window on the dedicated workspace (Firefox cold-starts slowly).
WIN_ADDR=""
for _ in $(seq 1 60); do
  WIN_ADDR=$(hyprctl clients -j | python3 -c "
import json,sys
ws=$WORKSPACE; cls='$CLS'
for c in json.load(sys.stdin):
    k=(c.get('class') or '').lower()
    if c.get('workspace',{}).get('id')==ws and cls in k:
        print(c['address']); break
" 2>/dev/null || true)
  [ -n "$WIN_ADDR" ] && break
  sleep 0.5
done
[ -z "$WIN_ADDR" ] && {
  echo "$ENGINE window not found"
  exit 1
}
hyprctl dispatch focuswindow "address:$WIN_ADDR" >/dev/null

# Wait for the page to POST /results (the harness self-reports when done), up to
# ~30s; then screenshot whatever is on screen regardless.
for _ in $(seq 1 60); do
  [ -s "$OUT_JSON" ] && break
  sleep 0.5
done
sleep 1 # let the on-page <pre> paint before the shot
grim -w "$WIN_ADDR" "$OUT_PNG" 2>/dev/null || grim "$OUT_PNG"
echo "screenshot -> $OUT_PNG"
[ -s "$OUT_JSON" ] && echo "results -> $OUT_JSON" || echo "WARN: no /results JSON (screenshot-only)"
