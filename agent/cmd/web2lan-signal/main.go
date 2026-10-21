// Command web2lan-signal runs the discovery relay for the browser and agent.
//
// It only forwards signaling JSON; no user traffic passes through it.
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

	"github.com/beijihu/easytier-web2lan/agent/internal/signaling"
)

func main() {
	var (
		addr      = flag.String("addr", ":8787", "listen address")
		staticDir = flag.String("static", "", "directory to serve as the web UI (optional)")
	)
	flag.Parse()

	logger := log.New(os.Stderr, "[web2lan-signal] ", log.LstdFlags)

	srv := signaling.NewServer(logger)
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv.HandlerWithStatic(*staticDir),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Printf("listening on %s (ws endpoint /ws?room=...&role=...)", *addr)
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
