#!/usr/bin/env bash
# Start the full local stack: demo target service, fdn (assets + signaling +
# fallback), tunnelagent, and the web dev server.
#
#   pnpm run dev:stack
#
# Layout:
#   :8099  demo target (python http.server, stands in for the intranet web)
#   :8787  fdn signaling + fallback proxy + static assets
#   :5273  vite dev server (browser side, hot reload)
#         tunnelagent connects the browser to the target over WebRTC
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/.dev-bin"
TARGET_PORT="${TARGET_PORT:-8099}"
FDN_PORT="${FDN_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5273}"

mkdir -p "$BIN" "$ROOT/.dev-target"
printf "%s\n" "HELLO-FROM-INTRANET-SERVICE" "private data 42" > "$ROOT/.dev-target/marker.txt"

echo "== building binaries =="
(cd "$ROOT/agent" && go build -o "$BIN/fdn" ./cmd/fdn && go build -o "$BIN/tunnelagent" ./cmd/tunnelagent)

pids=()
cleanup() {
  echo
  echo "== stopping =="
  for p in "${pids[@]:-}"; do [ -n "${p:-}" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "== target  http://127.0.0.1:$TARGET_PORT =="
(cd "$ROOT/.dev-target" && python3 -m http.server "$TARGET_PORT" --bind 127.0.0.1) &
pids+=($!)

echo "== fdn     http://127.0.0.1:$FDN_PORT  (signaling at /__lan/ws) =="
"$BIN/fdn" -addr "127.0.0.1:$FDN_PORT" &
pids+=($!)

sleep 1
echo "== agent   exposing target on room demo =="
"$BIN/tunnelagent" -signal "ws://127.0.0.1:$FDN_PORT/__lan/ws" -room demo -target "http://127.0.0.1:$TARGET_PORT" -stun "${STUN:-}" &
pids+=($!)

SIGNAL_ENC="$(printf %s "ws://127.0.0.1:$FDN_PORT/__lan/ws" | sed "s|/|%2F|g; s|:|%3A|g")"
echo "== web     http://127.0.0.1:$WEB_PORT/?signal=$SIGNAL_ENC&room=demo =="
echo
echo "Open the URL above and wait for the tunnel to come up."
echo
cd "$ROOT/fdn/web" && exec npx vite --port "$WEB_PORT" --host 127.0.0.1
