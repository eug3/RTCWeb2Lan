package relay

import "testing"

func TestMatchHostRule(t *testing.T) {
	bl, err := NewTableForTest([]RouteSpec{
		{Kind: "host", Host: "sense.jshuaxin.net", Target: "http://10.1.1.230:9011"},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	tg, path, ok := bl.Match("sense.jshuaxin.net", "/api/runs?x=1")
	if !ok || tg.URL.Host != "10.1.1.230:9011" {
		t.Fatalf("route mismatch: ok=%v target=%v", ok, tg)
	}
	if path != "/api/runs?x=1" {
		t.Fatalf("host rule must keep the path, got %q", path)
	}
}

func TestMatchPrefixStripsPrefix(t *testing.T) {
	bl, err := NewTableForTest([]RouteSpec{
		{Kind: "prefix", Host: "portal.example.com", Prefix: "/dsh", Target: "http://10.1.1.12:3080"},
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	tg, path, ok := bl.Match("portal.example.com", "/dsh/workflow-admin/ui")
	if !ok || tg.URL.Host != "10.1.1.12:3080" {
		t.Fatalf("route mismatch")
	}
	if path != "/workflow-admin/ui" {
		t.Fatalf("prefix must be stripped, got %q", path)
	}
}

func TestMatchPrefixBoundary(t *testing.T) {
	bl, _ := NewTableForTest([]RouteSpec{
		{Kind: "prefix", Host: "p.example.com", Prefix: "/dsh", Target: "http://127.0.0.1:1"},
	}, false)
	if _, _, ok := bl.Match("p.example.com", "/dshx"); ok {
		t.Fatal("must not match /dshx against prefix /dsh")
	}
	if _, _, ok := bl.Match("other.example.com", "/dsh/a"); ok {
		t.Fatal("must not match a different host")
	}
}

func TestMatchLongestPrefixWins(t *testing.T) {
	bl, _ := NewTableForTest([]RouteSpec{
		{Kind: "prefix", Host: "p.example.com", Prefix: "/a", Target: "http://127.0.0.1:1111"},
		{Kind: "prefix", Host: "p.example.com", Prefix: "/a/b", Target: "http://127.0.0.1:2222"},
	}, false)
	if _, _, ok := bl.Match("p.example.com", "/a/b/c"); !ok {
		t.Fatal("expected a match")
	}
	tg, _, _ := bl.Match("p.example.com", "/a/b/c")
	if tg.URL.Port() != "2222" {
		t.Fatalf("longest prefix must win, got port %s", tg.URL.Port())
	}
}

func TestSingleRouteWildcard(t *testing.T) {
	bl, err := SingleRoute("http://127.0.0.1:8099", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, path, ok := bl.Match("anything.example.com", "/x/y"); !ok || path != "/x/y" {
		t.Fatalf("wildcard route failed: ok=%v path=%q", ok, path)
	}
}