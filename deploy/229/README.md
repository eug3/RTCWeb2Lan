# 229 — tunnelagent (the only agent in room `lan`)

The agent holds a pool of signaling slots; the relay binds one per browser.
Everything P2P goes through it, so it must be the single instance: the
systemd unit `web2lan-agent` is kept as a rollback path only and MUST stay
disabled while the container runs.

## Build the image (from this repo)

```bash
# on a machine that can cross-compile for linux/amd64
cd agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" \
  -o /tmp/tunnelagent ./cmd/tunnelagent

# on 229: wrap the binary in the existing base image (no network needed)
mkdir -p /tmp/agentimg && cp /tmp/tunnelagent /tmp/agentimg/
printf 'FROM rtcweb2lan/tunnelagent:amd64\nCOPY tunnelagent /app/tunnelagent\n' \
  > /tmp/agentimg/Dockerfile
docker build -t rtcweb2lan/tunnelagent:$(date +%Y%m%d)-$(sha256sum /tmp/tunnelagent | cut -c1-7) \
  -f /tmp/agentimg/Dockerfile /tmp/agentimg
```

Tag by date + binary hash prefix, and update `image:` in the compose file —
that tag is the rollback point.

## Run / replace

```bash
cd deploy/229
sudo docker compose -f tunnelagent.compose.yml up -d
```

Replacing the image keeps the same container name and restarts it; every live
P2P session drops for a few seconds and browsers re-pair.

## Verify

```bash
sudo ss -tn state established | grep -c '111.231.65.155:443'   # == slots (32)
sudo docker logs --tail 20 tunnelagent                          # joined room "lan"
```

On the relay (1号机): `docker logs --tail 30 fdn` must show 32 `agent joined`
lines and then `browser joined (paired=true)` when a page connects.
