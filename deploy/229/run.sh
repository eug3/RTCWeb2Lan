#!/usr/bin/env bash
# Start (or replace) the one agent for room "lan" on 229.
#
# docker compose is not installed on 229, so this script is the executable
# form of tunnelagent.compose.yml — keep the two in sync. Run it on 229:
#
#   bash deploy/229/run.sh
#
# It is deliberately idempotent: the old container is removed first, so a
# leftover from a previous image never keeps running alongside the new one.
set -euo pipefail

IMAGE=${IMAGE:-rtcweb2lan/tunnelagent:20261101-quiet}
ROUTES=${ROUTES:-/home/beijihu/web2lan/routes.yaml}

# A systemd unit must not coexist with this container: both would hold a full
# pool of slots (the 2026-11-01 outage). The unit was deleted from the host; the
# guard stays so re-creating one cannot silently double the pool.
if systemctl is-active --quiet web2lan-agent 2>/dev/null; then
  echo "web2lan-agent is still running; stop it first:" >&2
  echo "  sudo systemctl disable --now web2lan-agent" >&2
  exit 1
fi

docker rm -f tunnelagent >/dev/null 2>&1 || true

docker run -d --name tunnelagent --restart unless-stopped \
  --network host \
  -v "$ROUTES":/app/routes.yaml:ro \
  "$IMAGE" \
  -signal wss://sense.jshuaxin.net/__lan/ws \
  -room lan \
  -routes /app/routes.yaml \
  -slots 32 \
  -advertise-cidr 10.1.1.0/24,192.168.0.0/20 \
  -stun stun:stun.chat.bilibili.com:3478

sleep 3
docker ps --filter name=tunnelagent --format '{{.Names}} {{.Status}} {{.Image}}'
echo "slots in room: $(ss -tn state established 2>/dev/null | grep -c '111.231.65.155:443')"
