/**
 * Page-side data plane.
 *
 * Owns whatever actually reaches the intranet (WebRTC DataChannel, or a stand-in
 * in tests) and answers "exchange" requests from the Service Worker.
 *
 * Each exchange opens a fresh DataChannel, sends the serialized request, and
 * collects the serialized response until the peer's empty end-of-message marker.
 */

import { createChannelSender, type DataChannelLike } from "./channel.js";
import type { PeerConnectionHandle } from "./peer.js";

export interface OverlayInstanceLike {
  /** Open a channel for one request. */
  openChannel(): DataChannelLike;
}

export interface DataPlaneOptions {
  /** Deadline for a single exchange (request + response). */
  exchangeTimeoutMs?: number;
}

const DEFAULT_EXCHANGE_TIMEOUT_MS = 120_000;

export function attachDataPlane(
  port: MessagePort,
  instance: OverlayInstanceLike,
  options: DataPlaneOptions = {},
): () => void {
  const timeoutMs = options.exchangeTimeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  let disposed = false;

  const post = (msg: unknown) => {
    if (!disposed) port.postMessage(msg);
  };

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.t !== "exchange") return;

    const id = msg.id;
    const authority = String(msg.authority);
    const requestBytes = new Uint8Array(msg.bytes as ArrayBuffer);

    void runExchange(instance, requestBytes, timeoutMs)
      .then((bytes) => {
        post({ t: "result", id, bytes: bytes.buffer });
      })
      .catch((error: unknown) => {
        post({ t: "error", id, message: error instanceof Error ? error.message : String(error) });
      });

    void authority;
  };

  port.start();
  post({ t: "ready" });

  return () => {
    disposed = true;
  };
}

async function runExchange(
  instance: OverlayInstanceLike,
  requestBytes: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  const channel = instance.openChannel();
  const sender = createChannelSender(channel);
  try {
    await sender.sendAll(requestBytes);
    return await sender.receiveAll(timeoutMs);
  } finally {
    sender.close();
  }
}

/** Convenience: build a data plane instance from a peer connection handle. */
export function instanceFromPeer(peer: PeerConnectionHandle): OverlayInstanceLike {
  return {
    openChannel: () => peer.openChannel() as unknown as DataChannelLike,
  };
}
