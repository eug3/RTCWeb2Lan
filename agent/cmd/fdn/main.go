// Command fdn runs the front desk node: the public edge of the overlay.
//
// It serves the overlay assets, the signaling websocket, and the fallback
// reverse proxy that takes over whenever the peer-to-peer link is unavailable.
//
//	fdn -addr :8080 -static ./dist -routes routes.yaml
//
// One container, one listener. Put TLS in front (or terminate here) and point
// the public DNS name at it.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/beijihu/easytier-web2lan/agent/internal/fdn"
	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
)

func main() {
	var (
		addr      = flag.String("addr", ":8080", "listen address")
		staticDir = flag.String("static", "", "directory with the built web assets")
		routesArg = flag.String("routes", "", "route table YAML for the fallback proxy (optional)")
		prefix    = flag.String("prefix", "/__lan", "URL prefix for overlay assets and signaling")
		insecure  = flag.Bool("insecure-upstream", false, "skip TLS verification against fallback targets")
	)
	flag.Parse()

	logger := log.New(os.Stderr, "[fdn] ", log.LstdFlags|log.Lmicroseconds)

	var routes *relay.RouteTable
	if *routesArg != "" {
		loaded, err := relay.LoadRoutes(*routesArg, *insecure)
		if err != nil {
			logger.Fatalf("%v", err)
		}
		routes = loaded
		for _, r := range routes.Routes {
			logger.Printf("fallback route %-8s %-24s %-16s -> %s", r.Kind, r.Host, r.Prefix, r.Target)
		}
	} else {
		logger.Printf("no -routes given: fallback proxy disabled (assets + signaling only)")
	}

	srv := fdn.New(fdn.Options{
		StaticDir:     *staticDir,
		OverlayPrefix: *prefix,
		Routes:        routes,
		Logger:        logger,
	})

	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// The fallback may carry large uploads and long-lived websockets.
		IdleTimeout: 120 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Printf("listening on %s (overlay assets at %s/, signaling at %s/ws)", *addr, *prefix, *prefix)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("serve: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	logger.Printf("stopped")
}
