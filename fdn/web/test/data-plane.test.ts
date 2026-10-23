import { describe, expect, it } from "vitest";
import { attachDataPlane, type OverlayInstanceLike } from "../src/data-plane.js";
import { PortOverlayTransport } from "../src/port-transport.js";
import type { DataChannelLike } from "../src/channel.js";

function portPair(): [MessagePort, MessagePort] {
  const channel = new MessageChannel();
  return [channel.port1, channel.port2];
}

/** A channel whose peer replies with canned bytes when the request ends. */
class EchoChannel implements DataChannelLike {
  readyState = "open";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  private listeners = new Map<string, Array<(...a: any[]) => void>>();

  constructor(private readonly reply: Uint8Array) {}

  send(data: ArrayBuffer) {
    if (data.byteLength !== 0) return;
    const buf = this.reply.slice().buffer;
    queueMicrotask(() => {
      for (const fn of this.listeners.get("message") ?? []) fn({ data: buf });
      for (const fn of this.listeners.get("message") ?? []) fn({ data: new ArrayBuffer(0) });
    });
  }
  close() { this.readyState = "closed"; }
  addEventListener(type: string, fn: (...a: any[]) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
}

async function roundTrip(instance: OverlayInstanceLike, authority: string, request: string) {
  const [pagePort, swPort] = portPair();
  attachDataPlane(pagePort, instance);
  const transport = new PortOverlayTransport(swPort);
  // Traffic only flows once the page announced readiness; in production the SW
  // refuses to enable the overlay before that point, so wait here rather than
  // exercising a state the SW can never reach.
  await transport.waitReady(2000);
  return transport.exchange(authority, new TextEncoder().encode(request));
}

describe("port transport readiness", () => {
  it("rejects fast when the plane has not announced readiness", async () => {
    const [pagePort, swPort] = portPair();
    attachDataPlane(pagePort, { openChannel: () => new EchoChannel(new Uint8Array()) });
    const transport = new PortOverlayTransport(swPort);
    // No waitReady: this is what a request arriving while the holder is still
    // connecting looked like. It must fail fast, not hang until the dead-port
    // timeout (which is what made the first request after a connect-page
    // redirect take ~25s before falling back).
    const started = Date.now();
    await expect(
      transport.exchange("10.0.0.1:80", new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")),
    ).rejects.toThrow(/not ready/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("data plane exchange", () => {
  it("returns the peer's serialized response", async () => {
    const reply = new TextEncoder().encode("HTTP/1.1 200 OK\r\n\r\nhello");
    const instance: OverlayInstanceLike = { openChannel: () => new EchoChannel(reply) };
    const out = await roundTrip(instance, "10.1.1.230:9011", "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    const text = new TextDecoder().decode(out);
    expect(text).toContain("HTTP/1.1 200 OK");
    expect(text).toContain("hello");
  });

  it("opens a fresh channel per exchange", async () => {
    let opened = 0;
    const reply = new TextEncoder().encode("HTTP/1.1 204 No Content\r\n\r\n");
    const instance: OverlayInstanceLike = {
      openChannel: () => { opened++; return new EchoChannel(reply); },
    };
    await roundTrip(instance, "a:80", "GET /1 HTTP/1.1\r\n\r\n");
    await roundTrip(instance, "a:80", "GET /2 HTTP/1.1\r\n\r\n");
    expect(opened).toBe(2);
  });

  it("rejects when the peer never replies", async () => {
    const instance: OverlayInstanceLike = {
      openChannel: () => ({
        readyState: "open",
        bufferedAmount: 0,
        binaryType: "arraybuffer",
        send() {},
        close() {},
        addEventListener() {},
      }),
    };
    const [pagePort, swPort] = portPair();
    attachDataPlane(pagePort, instance, { exchangeTimeoutMs: 100 });
    const transport = new PortOverlayTransport(swPort);
    await expect(transport.exchange("a:80", new Uint8Array(1))).rejects.toThrow();
  });

  it("reports ready", async () => {
    const [pagePort, swPort] = portPair();
    attachDataPlane(pagePort, { openChannel: () => new EchoChannel(new Uint8Array(0)) });
    const transport = new PortOverlayTransport(swPort);
    await expect(transport.waitReady(2000)).resolves.toBeUndefined();
  });
});
