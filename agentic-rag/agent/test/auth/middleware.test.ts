import { describe, expect, it } from "vitest";
import { buildHmacHook, _isAllowlisted } from "../../src/auth/middleware";

function fakeReq(method: string, url: string) {
  return { method, url } as unknown as Parameters<typeof _isAllowlisted>[0];
}

describe("isAllowlisted (H-02)", () => {
  it("returns false when allowlist is undefined", () => {
    expect(_isAllowlisted(fakeReq("GET", "/api/chat"), undefined)).toBe(false);
    expect(_isAllowlisted(fakeReq("GET", "/api/chat"), [])).toBe(false);
  });

  it("matches exact path", () => {
    expect(
      _isAllowlisted(fakeReq("GET", "/health"), [{ path: "/health" }]),
    ).toBe(true);
    expect(
      _isAllowlisted(fakeReq("GET", "/other"), [{ path: "/health" }]),
    ).toBe(false);
  });

  it("matches by prefix", () => {
    expect(
      _isAllowlisted(fakeReq("GET", "/style.css"), [{ pathPrefix: "/" }]),
    ).toBe(true);
    expect(
      _isAllowlisted(fakeReq("GET", "/api/chat"), [{ pathPrefix: "/" }]),
    ).toBe(true);
  });

  it("honours method constraint when set; ignores method when unset", () => {
    // Sin method en la regla, cualquier método pasa.
    expect(
      _isAllowlisted(fakeReq("POST", "/api/x"), [{ path: "/api/x" }]),
    ).toBe(true);
    // Con method, se aplica y rechaza otros verbos.
    expect(
      _isAllowlisted(fakeReq("POST", "/api/x"), [
        { method: "GET", path: "/api/x" },
      ]),
    ).toBe(false);
    expect(
      _isAllowlisted(fakeReq("GET", "/api/x"), [
        { method: "GET", path: "/api/x" },
      ]),
    ).toBe(true);
  });

  it("ignores query string when matching path", () => {
    expect(
      _isAllowlisted(fakeReq("GET", "/health?deep-check=1"), [
        { path: "/health" },
      ]),
    ).toBe(true);
    expect(
      _isAllowlisted(fakeReq("GET", "/api/chat/stream?q=hi"), [
        { pathPrefix: "/" },
      ]),
    ).toBe(true);
  });

  it("returns true if any rule matches", () => {
    expect(
      _isAllowlisted(fakeReq("GET", "/x"), [
        { path: "/a" },
        { path: "/b" },
        { pathPrefix: "/x" },
      ]),
    ).toBe(true);
  });
});

describe("buildHmacHook (H-02 smoke)", () => {
  it("returns a function even when no options are passed", () => {
    const hook = buildHmacHook({
      config: { secret: "s", keyId: "k" },
      enabled: true,
    });
    expect(typeof hook).toBe("function");
  });
});
