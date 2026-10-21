import { describe, expect, it } from "vitest";
import { createMockTransport } from "../src/mock-transport.js";
import { encodeRequest, parseResponse } from "../src/http1.js";

describe("mock transport", () => {
  it("answers an /api/ request with JSON", async () => {
    const wire = encodeRequest({ method: "GET", path: "/api/ping", headers: [] }, "10.1.1.154:80");
    const res = parseResponse(await createMockTransport().exchange("10.1.1.154:80", wire));
    expect(res.status).toBe(200);
    const json = JSON.parse(new TextDecoder().decode(res.body));
    expect(json.mock).toBe(true);
    expect(json.authority).toBe("10.1.1.154:80");
  });

  it("answers other paths with HTML", async () => {
    const wire = encodeRequest({ method: "GET", path: "/page", headers: [] }, "10.1.1.1:80");
    const res = parseResponse(await createMockTransport().exchange("10.1.1.1:80", wire));
    expect(res.headers.find(([n]) => n.toLowerCase() === "content-type")?.[1]).toContain("text/html");
  });
});
