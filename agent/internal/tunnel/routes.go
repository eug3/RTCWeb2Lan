package tunnel

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Route maps incoming public traffic onto an intranet target.
//
// Two kinds, mirroring the browser-side router:
//
//	host   - the whole public host maps to one target
//	prefix - a path prefix on a public host maps to one target
//
// The browser sends the public host and the original path; the agent decides
// where it really goes. This is what lets ONE agent serve many intranet
// services instead of one process per service.
type Route struct {
	Name   string `yaml:"name"`
	Kind   string `yaml:"kind"`             // "host" | "prefix"
	Host   string `yaml:"host"`             // public host, e.g. sense.jshuaxin.net
	Prefix string `yaml:"prefix,omitempty"` // only for kind=prefix
	Target string `yaml:"target"`           // http://10.1.1.230:9011

	// TLS handling for the upstream leg.
	InsecureTLS bool   `yaml:"insecure_tls,omitempty"` // skip upstream cert verification
	UpstreamSNI string `yaml:"upstream_sni,omitempty"` // SNI for the upstream (defaults to target host)

	parsed *Target
}

// RouteTable is the ordered rule set.
type RouteTable struct {
	Routes []Route `yaml:"routes"`
}

// LoadRoutes reads a YAML route table. When insecure is set, all routes skip
// upstream TLS verification (intranet self-signed certificates).
func LoadRoutes(path string, insecure bool) (*RouteTable, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read routes: %w", err)
	}
	var t RouteTable
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("parse routes: %w", err)
	}
	if len(t.Routes) == 0 {
		return nil, errors.New("route table is empty")
	}
	for i := range t.Routes {
		r := &t.Routes[i]
		if r.Kind == "" {
			r.Kind = "host"
		}
		if r.Kind != "host" && r.Kind != "prefix" {
			return nil, fmt.Errorf("route %q: kind must be host or prefix", r.Name)
		}
		if r.Host == "" {
			return nil, fmt.Errorf("route %q: host is required", r.Name)
		}
		if r.Kind == "prefix" && r.Prefix == "" {
			return nil, fmt.Errorf("route %q: prefix is required for kind=prefix", r.Name)
		}
		if r.Target == "" {
			return nil, fmt.Errorf("route %q: target is required", r.Name)
		}
		parsed, err := ParseTarget(r.Target, false, false)
		if err != nil {
			return nil, fmt.Errorf("route %q: %w", r.Name, err)
		}
		parsed.InsecureTLS = r.InsecureTLS || insecure
		if r.UpstreamSNI != "" {
			parsed.UpstreamSNI = r.UpstreamSNI
		}
		r.parsed = parsed
	}
	return &t, nil
}

// Match resolves a public host + path to a target.
// Prefix rules win over host rules when both apply; longest prefix first.
func (t *RouteTable) Match(host, path string) (*Target, string, bool) {
	host = strings.ToLower(host)

	var best *Route
	bestLen := -2 // -1 means a host rule matched

	for i := range t.Routes {
		r := &t.Routes[i]
		// An empty host acts as a wildcard (single-target mode).
		if r.Host != "" && strings.ToLower(r.Host) != host {
			continue
		}
		if r.Kind == "host" {
			if best == nil || bestLen < 0 {
				best = r
				bestLen = -1
			}
			continue
		}
		p := strings.TrimSuffix(r.Prefix, "/")
		if path != p && path != p+"/" && !strings.HasPrefix(path, p+"/") {
			continue
		}
		if best == nil || len(p) > bestLen {
			best = r
			bestLen = len(p)
		}
	}

	if best == nil {
		return nil, "", false
	}

	// Prefix rules strip their addressing prefix so the intranet app sees its
	// own path; host rules forward the path untouched.
	outPath := path
	if best.Kind == "prefix" {
		stripped := strings.TrimPrefix(path, strings.TrimSuffix(best.Prefix, "/"))
		if stripped == "" {
			stripped = "/"
		}
		outPath = stripped
	}
	return best.parsed, outPath, true
}

// SingleRoute builds a catch-all table for the -target shortcut: any host and
// any path maps to that one target. Intended for quick tests, not for serving
// multiple sites.
func SingleRoute(target string, insecure bool) (*RouteTable, error) {
	parsed, err := ParseTarget(target, false, false)
	if err != nil {
		return nil, err
	}
	parsed.InsecureTLS = insecure
	return &RouteTable{Routes: []Route{
		{
			Name:   "single",
			Kind:   "prefix",
			Host:   "",
			Prefix: "/",
			Target: target,
			parsed: parsed,
		},
	}}, nil
}
