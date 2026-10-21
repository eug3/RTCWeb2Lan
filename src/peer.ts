/**
 * Browser-side WebRTC connection.
 *
 * The RTCPeerConnection (and its DataChannel factory) lives in the page; the SW
 * asks it for a fresh channel per HTTP request. Signaling is control plane only.
 */

import { SIGNAL_PROTOCOL_VERSION, type SignalMessage } from "./signaling.js";

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PeerConfig {
  iceServers: IceServerConfig[];
  connectTimeoutMs?: number;
}

/** Label the agent looks for when accepting a data channel. */
export const DATA_CHANNEL_LABEL = "http";
export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;

export interface SignalChannel {
  send(msg: SignalMessage): void;
  onMessage(handler: (msg: SignalMessage) => void): void;
}

export interface PeerConnectionHandle {
  /** Open a fresh DataChannel for one HTTP request. */
  openChannel(): RTCDataChannel;
  connectionState(): string;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  isRelayed: boolean;
  close(): void;
}

export class PeerConnectError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PeerConnectError";
  }
}

export interface PeerDeps {
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

function candidateType(candidate: string): string | null {
  return /typ\s+(\w+)/.exec(candidate)?.[1] ?? null;
}

/** Waits for ICE to reach a usable state or fail. */
function waitConnected(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.connectionState === "connected") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PeerConnectError("peer connection timed out after " + timeoutMs + "ms")),
      timeoutMs,
    );
    pc.addEventListener("connectionstatechange", () => {
      const s = pc.connectionState;
      if (s === "connected") {
        clearTimeout(timer);
        resolve();
      } else if (s === "failed" || s === "closed") {
        clearTimeout(timer);
        reject(new PeerConnectError("peer connection " + s));
      }
    });
  });
}

/**
 * Browser side: creates the offer, sends it, waits for the answer and for the
 * connection to come up.
 */
export async function connectAsInitiator(opts: {
  session: string;
  signaling: SignalChannel;
  config: PeerConfig;
  deps: PeerDeps;
}): Promise<PeerConnectionHandle> {
  const { session, signaling, config, deps } = opts;
  const ctor = deps.createPeerConnection ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
  const pc = ctor({ iceServers: config.iceServers as RTCIceServer[] });

  let localType: string | null = null;
  let remoteType: string | null = null;
  let primaryChannel: RTCDataChannel | null = null;

  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    const t = candidateType(event.candidate.candidate);
    if (t !== null && localType === null) localType = t;
    signaling.send({
      v: SIGNAL_PROTOCOL_VERSION,
      type: "candidate",
      session,
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    });
  });

  const answered = new Promise<void>((resolve, reject) => {
    signaling.onMessage((msg) => {
      if (msg.session !== session) return;
      if (msg.type === "answer") {
        pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).then(resolve, reject);
      } else if (msg.type === "candidate") {
        const t = candidateType(msg.candidate);
        if (t !== null && remoteType === null) remoteType = t;
        void pc
          .addIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex })
          .catch(() => {});
      } else if (msg.type === "error") {
        reject(new PeerConnectError("peer rejected: " + msg.message));
      }
    });
  });

  const timeout = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  // A DataChannel MUST exist before createOffer(): the SDP only gains an m-line
  // (and therefore ICE credentials) once there is something to negotiate.
  // Several requests share the one connection; extra channels are created on
  // demand by the data plane.
  primaryChannel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  // Send pc.localDescription, NOT the raw offer: the offer produced by
  // createOffer() may lack ICE credentials until it is installed locally.
  // Sending the raw one makes the remote fail with "no ice-ufrag".
  const localSdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
  signaling.send({ v: SIGNAL_PROTOCOL_VERSION, type: "offer", session, sdp: localSdp });

  await withTimeout(answered, timeout, "answer");
  await waitConnected(pc, timeout);

  // The pre-offer channel exists only so the SDP gains an m-line; handing it
  // out for the first exchange proved unreliable (its SCTP stream sometimes
  // never delivers, agent-side the channel opens but no bytes arrive). Every
  // request opens a fresh channel on the established connection instead.
  primaryChannel = null;
  return makeHandle(pc, () => localType, () => remoteType, session, signaling);
}

/**
 * Agent-adjacent deployments and tests: waits for a remote offer and answers.
 * (Browsers act as initiators here, but keeping the symmetric path makes the
 * module testable and usable for a browser-to-browser deployment.)
 */
export async function connectAsResponder(opts: {
  session: string;
  signaling: SignalChannel;
  config: PeerConfig;
  deps: PeerDeps;
}): Promise<PeerConnectionHandle> {
  const { session, signaling, config, deps } = opts;
  const ctor = deps.createPeerConnection ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
  const pc = ctor({ iceServers: config.iceServers as RTCIceServer[] });

  let localType: string | null = null;
  let remoteType: string | null = null;

  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    const t = candidateType(event.candidate.candidate);
    if (t !== null && localType === null) localType = t;
    signaling.send({
      v: SIGNAL_PROTOCOL_VERSION,
      type: "candidate",
      session,
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    });
  });

  const timeout = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const offered = new Promise<void>((resolve, reject) => {
    signaling.onMessage((msg) => {
      if (msg.session !== session) return;
      if (msg.type === "offer") {
        (async () => {
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          const answerSdp = pc.localDescription?.sdp ?? answer.sdp ?? "";
          signaling.send({ v: SIGNAL_PROTOCOL_VERSION, type: "answer", session, sdp: answerSdp });
          resolve();
        })().catch(reject);
      } else if (msg.type === "candidate") {
        const t = candidateType(msg.candidate);
        if (t !== null && remoteType === null) remoteType = t;
        void pc
          .addIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex })
          .catch(() => {});
      }
    });
  });

  await withTimeout(offered, timeout, "offer");
  await waitConnected(pc, timeout);

  return makeHandle(pc, () => localType, () => remoteType, session, signaling);
}

function makeHandle(
  pc: RTCPeerConnection,
  localType: () => string | null,
  remoteType: () => string | null,
  session: string,
  signaling: SignalChannel,
  takePrimary: () => RTCDataChannel | null = () => null,
): PeerConnectionHandle {
  return {
    openChannel: () => {
      // Hand out the channel created before the offer first; it is already
      // negotiated. Later requests get fresh channels on the same connection.
      const primary = takePrimary();
      return primary ?? pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
    },
    connectionState: () => pc.connectionState,
    get localCandidateType() {
      return localType();
    },
    get remoteCandidateType() {
      return remoteType();
    },
    get isRelayed() {
      return localType() === "relay" || remoteType() === "relay";
    },
    close() {
      signaling.send({ v: SIGNAL_PROTOCOL_VERSION, type: "bye", session });
      pc.close();
    },
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PeerConnectError(what + " timed out after " + timeoutMs + "ms")),
      timeoutMs,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}