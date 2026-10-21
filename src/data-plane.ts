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
  const exchangeTimeoutMs = options.exchangeTimeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
  let disposed = false;

  const post = (msg: unknown) => {
    if (!disposed) port.postMessage(msg);
  };

  // Concurrent exchanges on one peer connection intermittently wedge
  // (one channel's transfer stalls the others in the SCTP layer). Requests are
  // seconds apart in practice, so a serial queue costs nothing and removes the
  // failure mode entirely.
  let queue: Promise<void> = Promise.resolve();

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.t !== "exchange") return;

    const id = msg.id;
    const authority = String(msg.authority);
    const requestBytes = new Uint8Array(msg.bytes as ArrayBuffer);

    queue = queue.then(() =>
      disposed
        ? undefined
        : runExchange(instance, requestBytes, exchangeTimeoutMs)
            .then((bytes) => {
              post({ t: "result", id, bytes: bytes.buffer });
            })
            .catch((error: unknown) => {
              post({ t: "error", id, message: error instanceof Error ? error.message : String(error) });
            }),
    );

    void authority;
  };

  port.start();
  post({ t: "ready" });

  return () => {
    disposed = true;
  };
}

/**
 * Wedged SCTP streams open but never deliver a single byte. Detection is a
 * short first-chunk budget (well above the LAN RTT); each attempt then retries
 * on a fresh channel. Attempts are capped so a truly dead connection surfaces.
 */
const FIRST_CHUNK_BUDGET_MS = 2_000;
const MAX_ATTEMPTS = 5;

async function runExchange(
  instance: OverlayInstanceLike,
  requestBytes: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  let lastError: unknown = new Error("exchange never ran");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const channel = instance.openChannel();
    const sender = createChannelSender(channel);
    let delivered = false;
    try {
      await sender.sendAll(requestBytes);
      const out = await sender.receiveAll(timeoutMs, FIRST_CHUNK_BUDGET_MS);
      delivered = true;
      return out;
    } catch (error) {
      lastError = error;
      console.warn(
        "[data-plane] attempt", attempt + "/" + MAX_ATTEMPTS, "failed:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      // Closing a channel right after its transfer resets the SCTP stream and
      // poisons later streams on the same association (see agent.go). Failed
      // attempts must still close; successful channels are reclaimed when the
      // peer connection goes away.
      if (!delivered) sender.close();
    }
  }
  throw lastError;
}

/** Convenience: build a data plane instance from a peer connection handle. */
export function instanceFromPeer(peer: PeerConnectionHandle): OverlayInstanceLike {
  return {
    openChannel: () => peer.openChannel() as unknown as DataChannelLike,
  };
}
