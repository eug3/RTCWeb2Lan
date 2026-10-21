import { describe, expect, it } from "vitest";
import { extractSetCookies, toDocumentCookie } from "../src/cookie-relay.js";

describe("extractSetCookies", () => {
  it("collects every set-cookie header, case-insensitively", () => {
    const headers: Array<[string, string]> = [
      ["Content-Type", "application/json"],
      ["Set-Cookie", "sense_admin=abc; Path=/; HttpOnly; SameSite=Lax"],
      ["X-Other", "1"],
      ["set-cookie", "second=2; Max-Age=60"],
      ["SET-COOKIE", "third=3"],
    ];
    expect(extractSetCookies(headers)).toEqual([
      "sense_admin=abc; Path=/; HttpOnly; SameSite=Lax",
      "second=2; Max-Age=60",
      "third=3",
    ]);
  });

  it("skips values without an equals sign", () => {
    expect(extractSetCookies([["set-cookie", "garbage"]])).toEqual([]);
  });
});

describe("toDocumentCookie", () => {
  it("drops HttpOnly but keeps the other attributes", () => {
    expect(toDocumentCookie("sense_admin=abc; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax")).toBe(
      "sense_admin=abc; Path=/; Max-Age=43200; SameSite=Lax",
    );
  });

  it("keeps cookie values containing equals signs", () => {
    expect(toDocumentCookie("tok=a=b=c; Path=/")).toBe("tok=a=b=c; Path=/");
  });

  it("returns null for values without a name=value pair", () => {
    expect(toDocumentCookie("no-equals-here")).toBeNull();
  });
});
