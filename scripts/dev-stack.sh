#!/usr/bin/env bash
# Start the full local stack: demo target service, signaling relay, agent, web UI.
#
#   pnpm run dev:stack
#
# Layout:
#   :8099  demo target (python http.server, stands in for the intranet web)
#   :8787  signaling relay (discovery only)
#   :5273  web UI (browser side)
#         agent connects the UI to the target over WebRTC
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/.dev-bin"
TARGET_PORT="${TARGET_PORT:-8099}"
SIGNAL_PORT="${SIGNAL_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5273}"

mkdir -p "$BIN" "$ROOT/.dev-target"
printf "%s\n" "HELLO-FROM-INTRANET-SERVICE" "private data 42" > "$ROOT/.dev-target/marker.txt"

echo "== building agent binaries =="
(cd "$ROOT/agent" && go build -o "$BIN/agent" ./cmd/web2lan-agent && go build -o "$BIN/signal" ./cmd/web2lan-signal)

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

echo "== relay   ws://127.0.0.1:$SIGNAL_PORT/ws =="
"$BIN/signal" -addr "127.0.0.1:$SIGNAL_PORT" &
pids+=($!)

sleep 1
echo "== agent   exposing target on room demo =="
"$BIN/agent" -signal "ws://127.0.0.1:$SIGNAL_PORT/ws" -room demo -target "http://127.0.0.1:$TARGET_PORT" -stun "${STUN:-}" &
pids+=($!)

echo "== web     http://127.0.0.1:$WEB_PORT/?signal=$(printf %s "ws://127.0.0.1:$SIGNAL_PORT/ws" | sed "s|/|%2F|g; s|:|%3A|g")&room=demo =="
echo
echo "Open the URL above, wait for \"已连接\", then click a probe button."
echo
cd "$ROOT" && exec npx vite --port "$WEB_PORT" --host 127.0.0.1