import { describe, expect, it } from "vitest";
import { describeLink } from "../src/connect-flow.js";
import { targetLabelFor } from "../src/router.js";
import type { SignalMessage } from "../src/signaling.js";
import type { RouteRule } from "../src/config.js";

/**
 * A minimal RTCStatsReport stand-in.
 *
 * lib.dom's RTCIceCandidatePairStats has no `selected` flag and there is no
 * typing at all for local/remote candidate stats, so the production code reads
 * the report structurally; these objects mirror what Chrome/Firefox emit.
 */
type Stat = Record<string, unknown>;

function report(stats: Stat[]): RTCStatsReport {
  const map = new Map<string, Stat>(stats.map((s) => [String(s.id), s]));
  return map as unknown as RTCStatsReport;
}

function pairStats(opts: {
  local: Stat;
  remote: Stat;
  selected?: boolean;
  state?: string;
  nominated?: boolean;
}): Stat[] {
  return [
    {
      id: "CP1",
      type: "candidate-pair",
      localCandidateId: opts.local.id,
      remoteCandidateId: opts.remote.id,
      state: opts.state ?? "succeeded",
      nominated: opts.nominated ?? true,
      selected: opts.selected,
    },
    opts.local,
    opts.remote,
  ];
}

const easyTier = { id: "RC1", type: "remote-candidate", address: "10.1.1.229", port: 51234, candidateType: "host" };
const lan = { id: "RC2", type: "remote-candidate", address: "192.168.1.229", port: 51820, candidateType: "host" };
const srflx = { id: "RC3", type: "remote-candidate", address: "180.110.199.193", port: 41000, candidateType: "srflx" };
const myHost = { id: "LC1", type: "local-candidate", address: "192.168.1.44", port: 55443, candidateType: "host" };

/**
 * Probe the same code path peer.ts uses: `readSelectedPair` is private, so the
 * handle is exercised through a fake RTCPeerConnection instead.
 */
async function pairFrom(stats: Stat[]) {
  const { connectAsInitiator } = await import("../src/peer.js");

  const pc = {
    connectionState: "connected",
    addEventListener: () => {},
    createDataChannel: () => ({}),
    createOffer: async () => ({ type: "offer", sdp: "v=0" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    localDescription: { sdp: "v=0" },
    getStats: async () => report(stats),
    close: () => {},
  };

  let signaled = false;
  const signaling = {
    send: () => {},
    onMessage: (handler: (m: SignalMessage) => void) => {
      if (signaled) return;
      signaled = true;
      queueMicrotask(() => handler({ v: 1, type: "answer", session: "s", sdp: "v=0" }));
    },
  };

  const handle = await connectAsInitiator({
    session: "s",
    signaling,
    config: { iceServers: [] },
    deps: { createPeerConnection: () => pc as unknown as RTCPeerConnection },
  });
  return handle.selectedPair();
}

describe("selected candidate pair", () => {
  it("reports the agent address ICE settled on", async () => {
    expect(await pairFrom(pairStats({ local: myHost, remote: lan, selected: true }))).toEqual({
      local: "192.168.1.44:55443",
      remote: "192.168.1.229:51820",
      localType: "host",
      remoteType: "host",
    });
  });

  it("distinguishes the EasyTier path from the LAN path", async () => {
    const got = await pairFrom(pairStats({ local: myHost, remote: easyTier, selected: true }));
    expect(got?.remote).toBe("10.1.1.229:51234");
  });

  it("prefers the browser-flagged pair over an earlier succeeded one", async () => {
    const stats = [
      { id: "CP1", type: "candidate-pair", localCandidateId: "LC1", remoteCandidateId: "RC1", state: "succeeded" },
      { id: "CP2", type: "candidate-pair", localCandidateId: "LC1", remoteCandidateId: "RC2", state: "succeeded", selected: true },
      myHost,
      easyTier,
      lan,
    ];
    expect((await pairFrom(stats))?.remote).toBe("192.168.1.229:51820");
  });

  it("falls back to a succeeded pair when no selected flag is set", async () => {
    const got = await pairFrom(pairStats({ local: myHost, remote: srflx }));
    expect(got?.remote).toBe("180.110.199.193:41000");
    expect(got?.remoteType).toBe("srflx");
  });

  it("ignores pairs that are not usable and reports null instead of guessing", async () => {
    const got = await pairFrom(
      pairStats({ local: myHost, remote: lan, state: "in-progress", nominated: false }),
    );
    expect(got).toBeNull();
  });

  it("survives a stats call that throws (display-only path)", async () => {
    const { connectAsInitiator } = await import("../src/peer.js");
    const pc = {
      connectionState: "connected",
      addEventListener: () => {},
      createDataChannel: () => ({}),
      createOffer: async () => ({ type: "offer", sdp: "v=0" }),
      setLocalDescription: async () => {},
      setRemoteDescription: async () => {},
      localDescription: { sdp: "v=0" },
      getStats: async () => {
        throw new Error("closed");
      },
      close: () => {},
    };
    let signaled = false;
    const handle = await connectAsInitiator({
      session: "s",
      signaling: {
        send: () => {},
        onMessage: (h: (m: SignalMessage) => void) => {
          if (signaled) return;
          signaled = true;
          queueMicrotask(() => h({ v: 1, type: "answer", session: "s", sdp: "v=0" }));
        },
      },
      config: { iceServers: [] },
      deps: { createPeerConnection: () => pc as unknown as RTCPeerConnection },
    });
    await expect(handle.selectedPair()).resolves.toBeNull();
  });
});

describe("describeLink", () => {
  const pair = {
    local: "192.168.1.44:55443",
    remote: "10.1.1.229:51234",
    localType: "host",
    remoteType: "host",
  };

  it("shows the winning intranet address and the target it stands for", () => {
    expect(describeLink(pair, "10.1.1.230:9011")).toEqual({
      ip: "10.1.1.229:51234",
      detail: "目标 10.1.1.230:9011 · 本机 192.168.1.44:55443 ⇋ 内网 10.1.1.229:51234（host）",
    });
  });

  it("says the agent resolves the target when none is configured", () => {
    expect(describeLink(null, null).detail).toContain("按 Host 由内网 agent 解析");
  });

  it("reports negotiation while ICE has not picked a pair yet", () => {
    expect(describeLink(null, "10.1.1.230:9011").ip).toBe("协商中");
  });
});

describe("targetLabelFor", () => {
  const rules: RouteRule[] = [
    { kind: "host", host: "Sense.JShuaxin.net", target: { ipv4: "10.1.1.230", port: 9011 } },
    { kind: "prefix", host: "portal.example.com", prefix: "/grafana", target: { ipv4: "10.1.1.90", port: 3000 } },
  ];

  it("labels a host rule with its configured target (case-insensitive)", () => {
    expect(targetLabelFor("sense.jshuaxin.net", rules)?.authority).toBe("10.1.1.230:9011");
  });

  it("has no label for a host served only by prefix rules", () => {
    expect(targetLabelFor("portal.example.com", rules)).toBeNull();
    expect(targetLabelFor("unknown.example.com", rules)).toBeNull();
  });
});
