# fdn — front desk node (public edge)
#
# One container, one listener: overlay assets + signaling + fallback reverse
# proxy. The fallback replaces the host nginx vhost, so nothing else needs to
# know the intranet routes.

FROM node:22-alpine AS web
WORKDIR /web
# Pin pnpm explicitly instead of relying on corepack: corepack resolves the
# latest release, whose dependency-approval config key differs between major
# versions and silently breaks the install.
RUN npm install -g pnpm@11.28.5
COPY fdn/web/package.json fdn/web/pnpm-lock.yaml fdn/web/pnpm-workspace.yaml ./
# pnpm refuses to run dependency build scripts unless approved; esbuild needs
# one for vite's bundler.
RUN pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true
COPY fdn/web/tsconfig.json fdn/web/vite.config.ts fdn/web/index.html fdn/web/connect.html fdn/web/holder.html ./
COPY fdn/web/src ./src
COPY fdn/web/public ./public
RUN pnpm run build

FROM golang:1.27-alpine AS go
WORKDIR /src
RUN apk add --no-cache git
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/fdn ./cmd/fdn

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

COPY --from=web /web/dist ./dist
COPY --from=go /out/fdn /app/fdn

# Overlay assets and signaling share one port; the fallback proxy serves the
# rest of the origin from the same listener.
EXPOSE 8080

# -routes is optional: without it the node serves assets + signaling only.
ENTRYPOINT ["/app/fdn"]
CMD ["-addr", ":8080", "-static", "/app/dist", "-routes", "/app/routes.yaml"]
