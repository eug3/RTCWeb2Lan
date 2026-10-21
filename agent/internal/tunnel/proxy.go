package tunnel

import (
	"crypto/tls"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Target is the intranet endpoint requests are forwarded to.
type Target struct {
	URL                *url.URL
	ChangeHostHeader   bool
	ChangeOriginHeader bool
	InsecureTLS        bool
	UpstreamSNI        string
}

// transport forwards a request to this target.
//
// For https targets we send the configured SNI: that is what lets the agent
// speak to a vhost behind nginx/Traefik that selects a site by TLS server name.
func (t *Target) transport() http.RoundTripper {
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.ForceAttemptHTTP2 = false

	if t.URL.Scheme == "https" {
		sni := t.UpstreamSNI
		if sni == "" {
			sni = t.URL.Hostname()
		}
		base.TLSClientConfig = &tls.Config{
			ServerName:         sni,
			InsecureSkipVerify: t.InsecureTLS, // #nosec G402 - intranet self-signed certs
		}
	}
	return &targetTransport{target: t, base: base}
}

type targetTransport struct {
	target *Target
	base   *http.Transport
}

func (tt *targetTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	out := req.Clone(req.Context())

	u := *tt.target.URL
	u.Path = singleJoiningSlash(tt.target.URL.Path, req.URL.Path)
	u.RawQuery = req.URL.RawQuery
	u.Fragment = ""
	out.URL = &u
	out.RequestURI = ""

	if tt.target.ChangeHostHeader {
		out.Host = tt.target.URL.Host
	} else {
		// Keep the public Host: vhost-based backends (nginx server_name) rely on it.
		out.Host = req.Host
	}

	if tt.target.ChangeOriginHeader {
		out.Header.Set("Origin", tt.target.URL.Scheme+"://"+tt.target.URL.Host)
	}

	clientIP, _, _ := strings.Cut(req.RemoteAddr, ":")
	if clientIP == "" {
		clientIP = "127.0.0.1"
	}
	if prior := out.Header.Get("X-Forwarded-For"); prior != "" {
		out.Header.Set("X-Forwarded-For", prior+", "+clientIP)
	} else {
		out.Header.Set("X-Forwarded-For", clientIP)
	}
	if out.Header.Get("X-Forwarded-Proto") == "" {
		out.Header.Set("X-Forwarded-Proto", "http")
	}
	out.Header.Set("X-Forwarded-Host", req.Host)

	return tt.base.RoundTrip(out)
}

func singleJoiningSlash(a, b string) string {
	aslash := strings.HasSuffix(a, "/")
	bslash := strings.HasPrefix(b, "/")
	switch {
	case aslash && bslash:
		return a + b[1:]
	case !aslash && !bslash && b != "":
		return a + "/" + b
	}
	return a + b
}

// ParseTarget validates a target URL string.
func ParseTarget(raw string, changeHost, changeOrigin bool) (*Target, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("parse target: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return nil, errors.New("target must include scheme and host, e.g. http://127.0.0.1:8080")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported target scheme %q", u.Scheme)
	}
	return &Target{URL: u, ChangeHostHeader: changeHost, ChangeOriginHeader: changeOrigin}, nil
}
