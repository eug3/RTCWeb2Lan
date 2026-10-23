// Package fdn implements the front desk node: the public edge of the overlay.
//
// A single process serves three things on one listener:
//
//	/__lan/...   the overlay's own assets (Service Worker, connect page, holder)
//	/__lan/ws    the signaling websocket (discovery only, no user traffic)
//	everything else
//	             the FALLBACK reverse proxy. When the peer-to-peer link is up
//	             the Service Worker intercepts API calls and they never reach
//	             this process; when it is down they land here and are proxied
//	             to the intranet exactly like the old host nginx did.
//
// Keeping the fallback inside this process means the whole public edge ships as
// one container: no host nginx vhost to keep in sync, no second place to
// configure routes.
package fdn

import (
	"log"
	"net/http"
	"net/http/httputil"
	"os"
	"strings"

	"github.com/beijihu/easytier-web2lan/agent/internal/relay"
	"github.com/beijihu/easytier-web2lan/agent/internal/signaling"
)

// Options configures the front desk node.
type Options struct {
	// StaticDir holds the built web assets (index.html, sw.js, ...). Served at
	// the root and under the overlay prefix.
	StaticDir string
	// OverlayPrefix is where the overlay assets and signaling live. Default
	// "/__lan".
	OverlayPrefix string
	// Routes decides which intranet target a public host+path falls back to.
	// When nil the fallback is disabled (assets + signaling only).
	Routes *relay.RouteTable
	// Logger receives request-level diagnostics. Defaults to stderr.
	Logger *log.Logger
}

// Server is the composed public-edge handler.
type Server struct {
	opts    Options
	log     *log.Logger
	signal  *signaling.Server
	handler http.Handler
}

// New builds the front desk node handler.
func New(opts Options) *Server {
	if opts.OverlayPrefix == "" {
		opts.OverlayPrefix = "/__lan"
	}
	opts.OverlayPrefix = strings.TrimSuffix(opts.OverlayPrefix, "/")

	logger := opts.Logger
	if logger == nil {
		logger = log.New(os.Stderr, "[fdn] ", log.LstdFlags|log.Lmicroseconds)
	}

	s := &Server{opts: opts, log: logger, signal: signaling.NewServer(logger)}
	s.handler = s.build()
	return s
}

// Handler returns the composed http.Handler.
func (s *Server) Handler() http.Handler { return s.handler }

func (s *Server) build() http.Handler {
	mux := http.NewServeMux()

	prefix := s.opts.OverlayPrefix

	// Signaling websocket. The signaling server mounts its endpoint at "/ws",
	// but we must NOT use http.StripPrefix here: gorilla/websocket needs the
	// ResponseWriter to implement http.Hijacker, and StripPrefix's wrapper does
	// not, which breaks the upgrade. Rewrite the path instead and pass the
	// original ResponseWriter through untouched.
	//
	// Registering this before the asset route keeps the more specific pattern
	// winning.
	signalHandler := s.signal.Handler()
	mux.Handle(prefix+"/ws", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r2 := r.Clone(r.Context())
		r2.URL.Path = strings.TrimPrefix(r.URL.Path, prefix)
		if r2.URL.Path == "" {
			r2.URL.Path = "/"
		}
		signalHandler.ServeHTTP(w, r2)
	}))

	// Overlay assets: served from StaticDir, with the /__lan prefix stripped.
	if s.opts.StaticDir != "" {
		files := http.FileServer(http.Dir(s.opts.StaticDir))
		mux.Handle(prefix+"/", http.StripPrefix(prefix+"/", http.HandlerFunc(
			func(w http.ResponseWriter, r *http.Request) {
				// The Service Worker must be allowed to control the whole origin.
				if strings.HasSuffix(r.URL.Path, "/sw.js") || r.URL.Path == "sw.js" {
					w.Header().Set("Service-Worker-Allowed", "/")
				}
				if r.URL.Path == "sw.js" || r.URL.Path == "index.html" {
					w.Header().Set("Cache-Control", "no-store")
				}
				files.ServeHTTP(w, r)
			})))
	}

	// Fallback reverse proxy for everything else.
	mux.Handle("/", http.HandlerFunc(s.serveFallback))
	return mux
}

// Cookie names shared with the browser side (see nav-gate.ts / connect.ts).
const (
	// graceCookie is set for a short window after a successful connect, so the
	// site root keeps loading while the SPA boots and its holder reconnects.
	graceCookie = "w2l_grace"
	// directCookie records that the visitor chose to use the fallback path and
	// does not want to be offered the overlay again for a while.
	directCookie = "w2l_direct"
)

// wantsConnectPage reports whether this request should be steered to the
// connect page instead of being proxied.
//
// The Service Worker already does this for a browser that has one (see
// decideNavigation), but a first-time visitor has no worker yet, so the request
// never reaches it. Without this, such a visitor silently gets the fallback
// path and never learns the overlay exists. Only the site root, only a
// top-level HTML navigation, and only when the visitor has expressed no
// preference either way.
func (s *Server) wantsConnectPage(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if r.URL.Path != "/" {
		return false
	}
	if !strings.Contains(r.Header.Get("Accept"), "text/html") {
		return false
	}
	if r.Header.Get("Sec-Fetch-Mode") != "" && r.Header.Get("Sec-Fetch-Mode") != "navigate" {
		return false
	}
	for _, c := range r.Cookies() {
		if c.Name == graceCookie || c.Name == directCookie {
			return false
		}
	}
	return true
}

// joinURLPath joins a target's base path with a request path, preserving a
// trailing slash.
//
// path.Join is the obvious choice but it cleans the result, so "/socket.io/"
// becomes "/socket.io". Socket.IO serves only the former and 404s the latter,
// which silently broke the app's realtime channel through the fallback.
func joinURLPath(base, reqPath string) string {
	if base == "" || base == "/" {
		return reqPath
	}
	if reqPath == "" {
		return base
	}
	joined := strings.TrimSuffix(base, "/") + "/" + strings.TrimPrefix(reqPath, "/")
	if strings.HasSuffix(reqPath, "/") && !strings.HasSuffix(joined, "/") {
		joined += "/"
	}
	return joined
}

// serveFallback proxies a request to the intranet target chosen by the route
// table. It is the container-side replacement for the old nginx `location /`.
func (s *Server) serveFallback(w http.ResponseWriter, r *http.Request) {
	if s.opts.Routes == nil {
		http.NotFound(w, r)
		return
	}

	if s.wantsConnectPage(r) {
		http.Redirect(w, r, s.opts.OverlayPrefix+"/connect.html", http.StatusFound)
		return
	}

	host := r.Host
	if h, _, ok := strings.Cut(host, ":"); ok {
		host = h
	}
	target, outPath, ok := s.opts.Routes.Match(host, r.URL.Path)
	if !ok {
		s.log.Printf("no route: host=%s path=%s", host, r.URL.Path)
		http.Error(w, "no route for "+host+r.URL.Path, http.StatusBadGateway)
		return
	}

	rp := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.URL.Scheme
			req.URL.Host = target.URL.Host
			req.URL.Path = joinURLPath(target.URL.Path, outPath)
			// The query string must survive verbatim: Socket.IO's handshake
			// encodes its transport there (/socket.io/?EIO=4&transport=...).
			req.URL.RawQuery = r.URL.RawQuery
			req.Host = req.Header.Get("X-Forwarded-Host")
			if req.Host == "" {
				req.Host = host
			}
			req.Header.Set("X-Forwarded-Host", host)
			if req.Header.Get("X-Forwarded-Proto") == "" {
				req.Header.Set("X-Forwarded-Proto", "https")
			}
		},
		Transport: target.Transport(),
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			s.log.Printf("fallback proxy: %s %s -> %s: %v", r.Method, r.URL.Path, target.URL, err)
			http.Error(w, "fallback proxy error", http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(w, r)
}
