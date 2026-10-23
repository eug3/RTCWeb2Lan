/**
 * Page-side data plane.
 *
 * Owns whatever actually reaches the intranet and answers "exchange" requests
 * from the Service Worker.
 *
 * All exchanges share ONE DataChannel and are multiplexed by stream id (see
 * mux.ts). Opening a channel per request used to be simpler, but every request
 * then depended on a fresh DCEP handshake that Chrome and pion often never
 * completed, so in practice almost nothing went through the tunnel and the
 * overlay silently degraded to the fallback proxy.
 *
 * Exchanges are still serialised for the SW's benefit: HTTP requests arrive
 * seconds apart, and keeping one in flight at a time means a wedged stream
 * cannot starve the others behind it.
 */

import { MuxClient, type DataChannelLike } from "./mux-client.js";
import type { PeerConnectionHandle } from "./peer.js";

export interface OverlayInstanceLike {
  /** The single multiplexed channel for this peer connection. */
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
  let mux: MuxClient | null = null;

  const post = (msg: unknown) => {
    if (!disposed) port.postMessage(msg);
  };

  const getMux = (): MuxClient => {
    if (!mux) mux = new MuxClient(instance.openChannel());
    return mux;
  };

  let queue: Promise<void> = Promise.resolve();

  port.onmessage = (event: MessageEvent) => {
    const msg = event.data as Record<string, unknown> | null;
    if (!msg || msg.t !== "exchange") return;

    const id = msg.id;
    const requestBytes = new Uint8Array(msg.bytes as ArrayBuffer);

    queue = queue.then(() =>
      disposed
        ? undefined
        : getMux()
            .exchange(requestBytes, exchangeTimeoutMs)
            .then((bytes) => {
              post({ t: "result", id, bytes: bytes.buffer });
            })
            .catch((error: unknown) => {
              post({ t: "error", id, message: error instanceof Error ? error.message : String(error) });
            }),
    );
  };

  port.start();
  post({ t: "ready" });

  return () => {
    disposed = true;
    mux?.close();
    mux = null;
  };
}

/**
 * Run one exchange directly over the peer connection, bypassing the SW and the
 * message port. Used to verify a freshly built tunnel.
 */
export async function runExchange(
  instance: OverlayInstanceLike,
  requestBytes: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  const mux = new MuxClient(instance.openChannel());
  try {
    return await mux.exchange(requestBytes, timeoutMs);
  } finally {
    mux.close();
  }
}

/** Convenience: build a data plane instance from a peer connection handle. */
export function instanceFromPeer(peer: PeerConnectionHandle): OverlayInstanceLike {
  return {
    openChannel: () => peer.openChannel() as unknown as DataChannelLike,
  };
}
