/**
 * Signaling protocol between the browser page and the intranet agent.
 *
 * Signaling is CONTROL PLANE ONLY: it exchanges SDP + ICE candidates so the
 * two peers can find each other, then goes idle. Business data never flows
 * through this channel — once the DataChannel is open, the browser talks to
 * the intranet web directly.
 *
 * Transport: a WebSocket to a tiny public signaling relay (or, for testing,
 * a local echo/courier). The relay only forwards these messages; it never
 * parses or proxies user traffic.
 */

export const SIGNAL_PROTOCOL_VERSION = 1;

/** Browser -> agent, and agent -> browser. */
export type SignalMessage =
  | { v: number; type: "hello"; role: "browser" | "agent"; session: string }
  | { v: number; type: "offer"; session: string; sdp: string }
  | { v: number; type: "answer"; session: string; sdp: string }
  | {
      v: number;
      type: "candidate";
      session: string;
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    }
  | { v: number; type: "bye"; session: string }
  | { v: number; type: "error"; session: string; message: string }
  // Relay status frames: informational, never forwarded to the peer.
  | { v: number; type: "ready"; session?: string; state?: string }
  | { v: number; type: "waiting"; session?: string };

/**
 * A connection request: which intranet service the browser wants.
 * The agent uses this to decide where to forward locally.
 */
export interface ConnectTargetSpec {
  /** Intranet address to reach, e.g. "10.1.1.230:9011". */
  authority: string;
  /** Stable id so the agent can reuse a channel per target. */
  channelId: string;
}

export function channelIdFor(authority: string): string {
  // Deterministic so both sides agree without extra negotiation.
  let hash = 2166136261;
  for (let i = 0; i < authority.length; i++) {
    hash ^= authority.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function isSignalMessage(value: unknown): value is SignalMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.v !== "number" || typeof m.type !== "string") return false;
  switch (m.type) {
    case "hello":
      return m.role === "browser" || m.role === "agent";
    case "ready":
    case "waiting":
      // Status frames may omit the session.
      return m.session === undefined || typeof m.session === "string";
    case "bye":
      return typeof m.session === "string";
    case "offer":
    case "answer":
      return typeof m.sdp === "string";
    case "candidate":
      return typeof m.candidate === "string";
    case "error":
      return typeof m.message === "string" && typeof m.session === "string";
    default:
      return false;
  }
}

export function encodeSignal(msg: SignalMessage): string {
  return JSON.stringify(msg);
}

export function decodeSignal(raw: string): SignalMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSignalMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
