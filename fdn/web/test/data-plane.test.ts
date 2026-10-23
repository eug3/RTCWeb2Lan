import { describe, expect, it } from "vitest";
import { attachDataPlane, type OverlayInstanceLike } from "../src/data-plane.js";
import { PortOverlayTransport } from "../src/port-transport.js";
import {
  decodeFrame,
  encodeFrame,
  KIND_DATA,
  KIND_END,
  type Frame,
} from "../src/mux.js";
import type { DataChannelLike } from "../src/mux-client.js";

function portPair(): [MessagePort, MessagePort] {
  const channel = new MessageChannel();
  return [channel.port1, channel.port2];
}

/**
 * A DataChannel stand-in that speaks the multiplexed protocol.
 *
 * It answers each stream with the canned reply: DATA frames carrying the reply
 * bytes, then an END frame. This mirrors what the agent does.
 */
class MuxEchoChannel implements DataChannelLike {
  readyState = "open";
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  private listeners = new Map<string, Array<(...a: any[]) => void>>();
  /** Stream ids seen, in order, so tests can assert multiplexing behaviour. */
  readonly streams: number[] = [];

  constructor(private readonly reply: Uint8Array) {}

  send(data: ArrayBuffer) {
    const frame: Frame = decodeFrame(data);
    if (frame.kind === KIND_DATA) {
      if (!this.streams.includes(frame.stream)) this.streams.push(frame.stream);
      return;
    }
    if (frame.kind !== KIND_END) return;

    const id = frame.stream;
    queueMicrotask(() => {
      for (const fn of this.listeners.get("message") ?? []) {
        fn({ data: encodeFrame(KIND_DATA, id, this.reply) });
      }
      for (const fn of this.listeners.get("message") ?? []) {
        fn({ data: encodeFrame(KIND_END, id, new Uint8Array(0)) });
      }
    });
  }

  close() {
    this.readyState = "closed";
    for (const fn of this.listeners.get("close") ?? []) fn({});
  }

  addEventListener(type: string, fn: (...a: any[]) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  removeEventListener(type: string, fn: (...a: any[]) => void) {
    const arr = this.listeners.get(type);
    if (!arr) return;
    this.listeners.set(
      type,
      arr.filter((f) => f !== fn),
    );
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
    attachDataPlane(pagePort, { openChannel: () => new MuxEchoChannel(new Uint8Array()) });
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
    const instance: OverlayInstanceLike = { openChannel: () => new MuxEchoChannel(reply) };
    const out = await roundTrip(instance, "10.1.1.230:9011", "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    const text = new TextDecoder().decode(out);
    expect(text).toContain("HTTP/1.1 200 OK");
    expect(text).toContain("hello");
  });

  it("reuses ONE channel for every exchange", async () => {
    // The whole point of the multiplexer: no per-request channel (and no
    // per-request DCEP handshake, which is what used to fail in the field).
    let opened = 0;
    const reply = new TextEncoder().encode("HTTP/1.1 204 No Content\r\n\r\n");
    const channel = new MuxEchoChannel(reply);
    const instance: OverlayInstanceLike = {
      openChannel: () => {
        opened++;
        return channel;
      },
    };

    // One data plane, many exchanges: the channel must be created once.
    const [pagePort, swPort] = portPair();
    attachDataPlane(pagePort, instance);
    const transport = new PortOverlayTransport(swPort);
    await transport.waitReady(2000);

    await transport.exchange("a:80", new TextEncoder().encode("GET /1 HTTP/1.1\r\n\r\n"));
    await transport.exchange("a:80", new TextEncoder().encode("GET /2 HTTP/1.1\r\n\r\n"));
    expect(opened).toBe(1);
  });

  it("assigns a distinct stream id per exchange", async () => {
    const reply = new TextEncoder().encode("HTTP/1.1 204 No Content\r\n\r\n");
    const channel = new MuxEchoChannel(reply);
    const instance: OverlayInstanceLike = { openChannel: () => channel };

    const [pagePort, swPort] = portPair();
    attachDataPlane(pagePort, instance);
    const transport = new PortOverlayTransport(swPort);
    await transport.waitReady(2000);

    await transport.exchange("a:80", new TextEncoder().encode("GET /1 HTTP/1.1\r\n\r\n"));
    await transport.exchange("a:80", new TextEncoder().encode("GET /2 HTTP/1.1\r\n\r\n"));
    expect(channel.streams).toEqual([1, 2]);
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
    attachDataPlane(pagePort, { openChannel: () => new MuxEchoChannel(new Uint8Array(0)) });
    const transport = new PortOverlayTransport(swPort);
    await expect(transport.waitReady(2000)).resolves.toBeUndefined();
  });
});
