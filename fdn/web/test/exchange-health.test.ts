import { describe, expect, it } from "vitest";
import { ExchangeHealth, MAX_CONSECUTIVE_EXCHANGE_FAILURES } from "../src/exchange-health.js";

describe("ExchangeHealth", () => {
  it("tolerates a single failure (no teardown on one blip)", () => {
    const h = new ExchangeHealth();
    expect(h.fail()).toBe(false);
    expect(h.consecutiveFailures).toBe(1);
  });

  it("only reports dead once the threshold is reached", () => {
    const h = new ExchangeHealth();
    for (let i = 1; i < MAX_CONSECUTIVE_EXCHANGE_FAILURES; i++) {
      expect(h.fail(), "failure " + i).toBe(false);
    }
    expect(h.fail(), "failure at threshold").toBe(true);
  });

  it("resets the run on a success", () => {
    const h = new ExchangeHealth();
    h.fail();
    h.fail();
    h.ok();
    expect(h.consecutiveFailures).toBe(0);
    // A fresh run needs the full threshold again.
    expect(h.fail()).toBe(false);
    expect(h.fail()).toBe(false);
    expect(h.fail()).toBe(true);
  });

  it("keeps reporting dead while failures continue", () => {
    const h = new ExchangeHealth(2);
    expect(h.fail()).toBe(false);
    expect(h.fail()).toBe(true);
    expect(h.fail()).toBe(true);
  });

  it("supports an explicit reset", () => {
    const h = new ExchangeHealth(2);
    h.fail();
    h.reset();
    expect(h.consecutiveFailures).toBe(0);
    expect(h.fail()).toBe(false);
  });

  it("rejects a nonsensical threshold", () => {
    expect(() => new ExchangeHealth(0)).toThrow();
  });
});
