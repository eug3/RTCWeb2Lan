import { describe, expect, it } from "vitest";
import { MTU, createChannelSender, fragment, type DataChannelLike } from "../src/channel.js";

/** A DataChannel stand-in with a paired peer, so send/receive can be exercised. */
class FakeChannel implements DataChannelLike {
  readyState = "open";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  readonly sent: ArrayBuffer[] = [];
  private listeners = new Map<string, Array<(...a: any[]) => void>>();

  send(data: ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = "closed"; }
  addEventListener(type: string, fn: (...a: any[]) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  emit(type: string, payload?: any) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }
  /** Peer -> us. */
  deliver(data: ArrayBuffer) { this.emit("message", { data }); }
}

describe("fragment", () => {
  it("splits into MTU-sized buffers", () => {
    const data = new Uint8Array(MTU * 2 + 10);
    const parts = fragment(data);
    expect(parts.length).toBe(3);
    expect(parts[0]!.byteLength).toBe(MTU);
    expect(parts[2]!.byteLength).toBe(10);
  });

  it("returns nothing for an empty payload", () => {
    expect(fragment(new Uint8Array(0))).toEqual([]);
  });

  it("does not alias the source", () => {
    const data = new Uint8Array(100).fill(1);
    const parts = fragment(data, 50);
    data.fill(9);
    expect(new Uint8Array(parts[0]!)[0]).toBe(1);
  });
});

describe("createChannelSender", () => {
  it("sends fragments then an empty end marker", async () => {
    const dc = new FakeChannel();
    const s = createChannelSender(dc);
    const payload = new Uint8Array(MTU + 5);
    await s.sendAll(payload);

    // 2 fragments + the empty end-of-message marker.
    expect(dc.sent.length).toBe(3);
    expect(dc.sent[0]!.byteLength).toBe(MTU);
    expect(dc.sent[1]!.byteLength).toBe(5);
    expect(dc.sent[2]!.byteLength).toBe(0);
  });

  it("waiting for open before sending", async () => {
    const dc = new FakeChannel();
    dc.readyState = "connecting";
    const s = createChannelSender(dc);
    const p = s.sendAll(new Uint8Array(4));
    await new Promise((r) => setTimeout(r, 10));
    expect(dc.sent.length).toBe(0);
    dc.readyState = "open";
    dc.emit("open");
    await p;
    expect(dc.sent.length).toBeGreaterThan(0);
  });

  it("reassembles the peer response until the empty marker", async () => {
    const dc = new FakeChannel();
    const s = createChannelSender(dc);
    const received = s.receiveAll(2000);

    dc.deliver(new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\n").buffer as ArrayBuffer);
    dc.deliver(new TextEncoder().encode("body").buffer as ArrayBuffer);
    dc.deliver(new ArrayBuffer(0));

    const out = await received;
    expect(new TextDecoder().decode(out)).toContain("HTTP/1.1 200 OK");
    expect(new TextDecoder().decode(out)).toContain("body");
  });

  it("treats a non-binary message as an error", async () => {
    const dc = new FakeChannel();
    const s = createChannelSender(dc);
    const received = s.receiveAll(2000);
    dc.deliver("text" as any);
    await expect(received).rejects.toThrow(/non-binary/);
  });

  it("times out when the peer never finishes", async () => {
    const dc = new FakeChannel();
    const s = createChannelSender(dc);
    await expect(s.receiveAll(50)).rejects.toThrow(/timed out/);
  });

  it("propagates channel errors", async () => {
    const dc = new FakeChannel();
    const s = createChannelSender(dc);
    const received = s.receiveAll(2000);
    dc.emit("error", { error: new Error("boom") });
    await expect(received).rejects.toThrow(/data channel error/);
  });
});
