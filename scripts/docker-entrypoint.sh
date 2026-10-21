#!/bin/sh
# Serve the static bundle and the signaling relay from one container.
#
#   :8080  static page (put nginx/TLS in front)
#   :8787  signaling websocket at /ws
set -eu

STATIC_DIR="${STATIC_DIR:-/app/dist}"
STATIC_PORT="${STATIC_PORT:-8080}"
SIGNAL_ADDR="${SIGNAL_ADDR:-:8787}"

echo "[entrypoint] static=$STATIC_DIR on :$STATIC_PORT  signal on $SIGNAL_ADDR"

# BusyBox httpd is enough for static files and keeps the image small.
httpd -f -p "$STATIC_PORT" -h "$STATIC_DIR" &
HTTPD_PID=$!

/app/web2lan-signal -addr "$SIGNAL_ADDR" &
SIGNAL_PID=$!

trap 'kill $HTTPD_PID $SIGNAL_PID 2>/dev/null || true; exit 0' TERM INT
wait
