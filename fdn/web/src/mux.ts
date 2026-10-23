/**
 * Multiplexing over a single DataChannel.
 *
 * One DataChannel per HTTP request meant every request paid for a fresh SCTP
 * stream: a DCEP handshake that Chrome/pion sometimes never completes
 * ("channel open timed out"), plus stream resets that poison later streams on
 * the same association. Measured in production, that path failed for nearly
 * every request, so the overlay silently degraded to the fallback proxy.
 *
 * This module keeps ONE channel open and multiplexes requests over it with an
 * explicit frame header:
 *
 *   ┌────────────┬──────────────┬─────────────────────────┐
 *   │ kind (u8)  │ stream (u32) │ payload (0..MTU-5 bytes)│
 *   └────────────┴──────────────┴─────────────────────────┘
 *
 * Frames for different streams interleave freely. A stream's body is
 * terminated by an END frame, which replaces the old "empty message" marker.
 *
 * Both sides speak this (see agent/internal/tunnel/frame.go); keep them in
 * sync.
 */

/** 16 KiB - 1 keeps a whole frame under the SCTP message limit. */
export const MTU = 16 * 1024 - 1;

/** Bytes of framing overhead per message: kind(1) + stream(4). */
export const FRAME_HEADER = 5;

/** Largest payload a single frame may carry. */
export const MAX_PAYLOAD = MTU - FRAME_HEADER;

export const KIND_DATA = 1;
export const KIND_END = 2;
/** Peer aborted this stream (e.g. upstream error); payload is UTF-8 reason. */
export const KIND_ABORT = 3;

export interface Frame {
  kind: number;
  stream: number;
  payload: Uint8Array;
}

export function encodeFrame(kind: number, stream: number, payload: Uint8Array): ArrayBuffer {
  if (payload.byteLength > MAX_PAYLOAD) {
    throw new Error("frame payload exceeds MTU: " + payload.byteLength);
  }
  const buf = new ArrayBuffer(FRAME_HEADER + payload.byteLength);
  const view = new DataView(buf);
  view.setUint8(0, kind);
  view.setUint32(1, stream);
  new Uint8Array(buf, FRAME_HEADER).set(payload);
  return buf;
}

export function decodeFrame(data: ArrayBuffer): Frame {
  if (data.byteLength < FRAME_HEADER) {
    throw new Error("frame shorter than header: " + data.byteLength);
  }
  const view = new DataView(data);
  return {
    kind: view.getUint8(0),
    stream: view.getUint32(1),
    payload: new Uint8Array(data, FRAME_HEADER),
  };
}

/** Split a payload into frame-sized pieces. */
export function fragment(payload: Uint8Array, max = MAX_PAYLOAD): Uint8Array[] {
  if (max <= 0) throw new Error("max must be positive");
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength; offset += max) {
    out.push(payload.subarray(offset, Math.min(offset + max, payload.byteLength)));
  }
  return out;
}
