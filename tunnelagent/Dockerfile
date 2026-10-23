# tunnelagent — intranet side of the overlay
#
# Dials the public signaling service and never listens on a port: every byte is
# outbound. Deploy it inside the network that hosts the services to expose.

FROM golang:1.27-alpine AS go
WORKDIR /src
RUN apk add --no-cache git
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tunnelagent ./cmd/tunnelagent

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app

COPY --from=go /out/tunnelagent /app/tunnelagent
# The route table decides which intranet service each public host maps to.
COPY routes.yaml /app/routes.yaml

ENTRYPOINT ["/app/tunnelagent"]
CMD ["-signal", "wss://edge.example.com/__lan/ws", "-room", "default", "-routes", "/app/routes.yaml"]
