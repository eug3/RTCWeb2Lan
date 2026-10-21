# Static page + signaling relay, served from one container.
# Multi-stage: build the web bundle and the Go binaries, ship a slim runtime.

FROM node:22-alpine AS web
WORKDIR /web
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN pnpm run build

FROM golang:1.27-alpine AS go
WORKDIR /src
RUN apk add --no-cache git
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/web2lan-signal ./cmd/web2lan-signal \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/web2lan-agent ./cmd/web2lan-agent

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

# Static assets (index.html, sw.js, js)
COPY --from=web /web/dist ./dist
# Signaling relay
COPY --from=go /out/web2lan-signal /app/web2lan-signal
# Agent is included for convenience (run it on an intranet host instead)
COPY --from=go /out/web2lan-agent /app/web2lan-agent

EXPOSE 8080 8787

# One container, two listeners: static files on :8080, signaling on :8787.
COPY scripts/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
