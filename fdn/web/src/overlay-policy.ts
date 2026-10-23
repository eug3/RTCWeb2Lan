/**
 * What the holder should do with the peer it is currently holding, given a
 * status query that may not have been answered.
 *
 * Extracted from holder.ts so the policy is testable without Service Worker
 * globals. The distinction matters: treating "no answer" as "tunnel dead" made
 * the holder tear down healthy connections and rebuild them in a loop.
 */

/** Result of asking the Service Worker whether the overlay is live. */
export interface OverlayStatusLike {
  enabled: boolean;
  hasTransport: boolean;
  /** False when the query timed out — we do not know the real state. */
  answered: boolean;
}

export type PeerAction =
  /** The tunnel is live; nothing to do. */
  | "stand-down"
  /** Keep the current peer and re-check on a later tick. */
  | "keep-peer"
  /** Explicitly reported down; release the peer and reconnect. */
  | "release-and-reconnect"
  /** No peer held; connect now. */
  | "connect";

/**
 * Decide what to do, given the status answer and whether a peer is held.
 *
 * The rules:
 *  - live tunnel (enabled + transport) => stand down, regardless of our peer
 *  - unanswered query + peer held      => keep it; not knowing is not evidence
 *  - answered but not live + peer held => release it and reconnect
 *  - answered but not live + no peer   => connect
 */
export function decidePeerAction(status: OverlayStatusLike, holdingPeer: boolean): PeerAction {
  if (status.enabled && status.hasTransport) return "stand-down";
  if (!status.answered) return holdingPeer ? "keep-peer" : "connect";
  return holdingPeer ? "release-and-reconnect" : "connect";
}
