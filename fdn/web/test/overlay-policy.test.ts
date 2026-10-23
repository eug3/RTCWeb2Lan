import { describe, expect, it } from "vitest";
import { decidePeerAction, type OverlayStatusLike } from "../src/overlay-policy.js";

const live: OverlayStatusLike = { enabled: true, hasTransport: true, answered: true };
const down: OverlayStatusLike = { enabled: false, hasTransport: false, answered: true };
const unknown: OverlayStatusLike = { enabled: false, hasTransport: false, answered: false };

describe("decidePeerAction", () => {
  it("stands down when the tunnel is live", () => {
    expect(decidePeerAction(live, true)).toBe("stand-down");
    expect(decidePeerAction(live, false)).toBe("stand-down");
  });

  it("KEEPS a held peer when the status query went unanswered", () => {
    // Regression: this used to release the peer, which tore down healthy
    // connections and caused a reconnect storm.
    expect(decidePeerAction(unknown, true)).toBe("keep-peer");
  });

  it("connects when unanswered and no peer is held", () => {
    expect(decidePeerAction(unknown, false)).toBe("connect");
  });

  it("releases and reconnects only on an explicit down answer", () => {
    expect(decidePeerAction(down, true)).toBe("release-and-reconnect");
  });

  it("connects when explicitly down and no peer is held", () => {
    expect(decidePeerAction(down, false)).toBe("connect");
  });

  it("requires both enabled and transport to count as live", () => {
    expect(decidePeerAction({ enabled: true, hasTransport: false, answered: true }, true)).toBe(
      "release-and-reconnect",
    );
    expect(decidePeerAction({ enabled: false, hasTransport: true, answered: true }, true)).toBe(
      "release-and-reconnect",
    );
  });
});
