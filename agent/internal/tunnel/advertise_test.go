package tunnel

import (
	"net"
	"strings"
	"testing"

	"github.com/pion/webrtc/v4"
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

func TestCandidateAdmitted(t *testing.T) {
	srflxOnly := []webrtc.ICECandidateType{webrtc.ICECandidateTypeSrflx}

	// Type filter: srflx passes, host and relay are dropped.
	if !candidateAdmitted(webrtc.ICECandidateTypeSrflx, "111.198.9.10", nil, srflxOnly) {
		t.Error("srflx should be advertised under srflx-only")
	}
	if candidateAdmitted(webrtc.ICECandidateTypeHost, "10.1.1.229", nil, srflxOnly) {
		t.Error("host should not be advertised under srflx-only")
	}
	if candidateAdmitted(webrtc.ICECandidateTypeRelay, "111.198.9.11", nil, srflxOnly) {
		t.Error("relay should not be advertised under srflx-only")
	}

	// No filters at all: everything gathered is advertised.
	for _, typ := range []webrtc.ICECandidateType{
		webrtc.ICECandidateTypeHost, webrtc.ICECandidateTypeSrflx, webrtc.ICECandidateTypeRelay,
	} {
		if !candidateAdmitted(typ, "10.1.1.229", nil, nil) {
			t.Errorf("%s should be advertised when no filter is set", typ)
		}
	}

	// Host must pass BOTH filters: type allowed but outside the CIDR is dropped.
	overlay := mustCIDRs(t, "10.1.1.0/24")
	hostOnly := []webrtc.ICECandidateType{webrtc.ICECandidateTypeHost}
	if !candidateAdmitted(webrtc.ICECandidateTypeHost, "10.1.1.229", overlay, hostOnly) {
		t.Error("host inside the CIDR should be advertised")
	}
	if candidateAdmitted(webrtc.ICECandidateTypeHost, "192.168.1.229", overlay, hostOnly) {
		t.Error("host outside the CIDR should stay filtered")
	}
}

// sampleSDP mimics the candidate-bearing answer pion produces: CRLF line
// endings, host + srflx candidate lines under the media section.
const sampleSDP = "v=0\r\n" +
	"o=- 0 0 IN IP4 127.0.0.1\r\n" +
	"m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" +
	"a=ice-ufrag:abcd\r\n" +
	"a=candidate:1 1 udp 2130706431 172.17.0.1 54321 typ host generation 0\r\n" +
	"a=candidate:2 1 udp 1694498815 111.198.9.10 54322 typ srflx raddr 0.0.0.0 rport 54322 generation 0\r\n" +
	"a=candidate:3 1 udp 41885439 10.1.1.229 54323 typ host generation 0\r\n" +
	"a=end-of-candidates\r\n"

func TestStripUnadvertisedCandidatesSrflxOnly(t *testing.T) {
	srflxOnly := []webrtc.ICECandidateType{webrtc.ICECandidateTypeSrflx}
	out, stripped := stripUnadvertisedCandidates(sampleSDP, nil, srflxOnly)
	if stripped != 2 {
		t.Fatalf("expected 2 host candidates stripped, got %d", stripped)
	}
	if strings.Contains(out, "typ host") {
		t.Errorf("host candidates must not survive in the SDP:\n%s", out)
	}
	if !strings.Contains(out, "111.198.9.10 54322 typ srflx") {
		t.Errorf("srflx candidate must survive:\n%s", out)
	}
	if !strings.Contains(out, "a=end-of-candidates") || !strings.Contains(out, "a=ice-ufrag:abcd") {
		t.Errorf("non-candidate lines must be untouched:\n%s", out)
	}
	if !strings.Contains(out, "\r\n") {
		t.Error("CRLF line endings must be preserved")
	}
}

func TestStripUnadvertisedCandidatesCIDR(t *testing.T) {
	overlay := mustCIDRs(t, "10.1.1.0/24")
	out, stripped := stripUnadvertisedCandidates(sampleSDP, overlay, nil)
	if stripped != 1 {
		t.Fatalf("expected only the docker-bridge candidate stripped, got %d", stripped)
	}
	if strings.Contains(out, "172.17.0.1") {
		t.Errorf("candidate outside the CIDR must be stripped:\n%s", out)
	}
	for _, want := range []string{"10.1.1.229", "111.198.9.10"} {
		if !strings.Contains(out, want) {
			t.Errorf("%s should survive the CIDR filter:\n%s", want, out)
		}
	}
}

func TestStripUnadvertisedCandidatesNoFilterKeepsOriginal(t *testing.T) {
	out, stripped := stripUnadvertisedCandidates(sampleSDP, nil, nil)
	if stripped != 0 || out != sampleSDP {
		t.Error("with no filters the SDP must be returned untouched")
	}

	// Nothing to strip: the original string must come back byte-identical too,
	// including its line endings.
	all, stripped := stripUnadvertisedCandidates(sampleSDP, nil,
		[]webrtc.ICECandidateType{webrtc.ICECandidateTypeHost, webrtc.ICECandidateTypeSrflx})
	if stripped != 0 || all != sampleSDP {
		t.Error("SDP where every candidate is admitted must be returned untouched")
	}
}
