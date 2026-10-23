package tunnel

import (
	"net"
	"testing"
)

func mustCIDRs(t *testing.T, specs ...string) []*net.IPNet {
	t.Helper()
	var out []*net.IPNet
	for _, s := range specs {
		_, n, err := net.ParseCIDR(s)
		if err != nil {
			t.Fatalf("ParseCIDR(%q): %v", s, err)
		}
		out = append(out, n)
	}
	return out
}

func TestAdvertiseCIDRFilter(t *testing.T) {
	// No restriction: everything is allowed.
	if !hostCandidateAllowed("172.17.0.1", nil) {
		t.Error("with no CIDR list every host candidate should be advertised")
	}

	// Overlay only: the LAN address is filtered out.
	overlay := mustCIDRs(t, "10.1.1.0/24")
	if !hostCandidateAllowed("10.1.1.229", overlay) {
		t.Error("overlay address should be advertised")
	}
	if hostCandidateAllowed("192.168.1.229", overlay) {
		t.Error("LAN address should be filtered when only the overlay is listed")
	}

	// Overlay + LAN: both advertised, unrelated interfaces still filtered.
	both := mustCIDRs(t, "10.1.1.0/24", "192.168.1.0/24")
	for _, addr := range []string{"10.1.1.229", "192.168.1.229"} {
		if !hostCandidateAllowed(addr, both) {
			t.Errorf("%s should be advertised when its network is listed", addr)
		}
	}
	for _, addr := range []string{"172.17.0.1", "100.96.0.27"} {
		if hostCandidateAllowed(addr, both) {
			t.Errorf("%s should stay filtered: it is not a usable path", addr)
		}
	}

	// Unparseable addresses never pass when a list is set.
	if hostCandidateAllowed("not-an-ip", both) {
		t.Error("unparseable address should be rejected")
	}
}