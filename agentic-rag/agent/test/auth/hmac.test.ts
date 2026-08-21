import { describe, expect, it } from "vitest";
import {
  buildCanonicalString,
  computeSignature,
  loadHmacConfigFromEnv,
  signRequest,
  verifyRequest,
  DEFAULT_HMAC_WINDOW_SECONDS,
  HMAC_KEY_ID_HEADER,
  HMAC_SIGNATURE_HEADER,
  HMAC_TIMESTAMP_HEADER,
  type HeaderLookup,
} from "../../src/auth/hmac";

const SECRET = "test-secret-do-not-use-in-prod";
const KEY_ID = "test-key";
const NOW = 1_700_000_000;

const baseConfig = {
  secret: SECRET,
  keyId: KEY_ID,
  windowSeconds: DEFAULT_HMAC_WINDOW_SECONDS,
  nowSeconds: () => NOW,
};

function signedHeadersFor(
  method: string,
  path: string,
  body: string,
  overrides: { timestamp?: number; keyId?: string; secret?: string } = {},
): HeaderLookup {
  const { timestamp, signature } = signRequest(
    { method, path, body },
    {
      secret: overrides.secret ?? SECRET,
      keyId: overrides.keyId ?? KEY_ID,
      nowSeconds: () => overrides.timestamp ?? NOW,
    },
  );
  return {
    [HMAC_TIMESTAMP_HEADER]: String(timestamp),
    [HMAC_KEY_ID_HEADER]: overrides.keyId ?? KEY_ID,
    [HMAC_SIGNATURE_HEADER]: signature,
  };
}

describe("buildCanonicalString", () => {
  it("produces a stable canonical string with sha256 of body", () => {
    const canonical = buildCanonicalString({
      method: "GET",
      path: "/api/chat/stream",
      body: "",
      timestamp: NOW,
    });
    expect(canonical).toMatch(
      /^1700000000\nGET\n\/api\/chat\/stream\n[0-9a-f]{64}$/,
    );
  });

  it("hashes body deterministically", () => {
    const a = buildCanonicalString({
      method: "POST",
      path: "/api/sessions",
      body: '{"a":1}',
      timestamp: NOW,
    });
    const b = buildCanonicalString({
      method: "POST",
      path: "/api/sessions",
      body: '{"a":1}',
      timestamp: NOW,
    });
    expect(a).toEqual(b);
  });

  it("uppercases method", () => {
    const lower = buildCanonicalString({
      method: "get",
      path: "/x",
      body: "",
      timestamp: NOW,
    });
    const upper = buildCanonicalString({
      method: "GET",
      path: "/x",
      body: "",
      timestamp: NOW,
    });
    expect(lower).toEqual(upper);
  });

  it("differentiates empty body from no body", () => {
    const empty = buildCanonicalString({
      method: "GET",
      path: "/x",
      body: "",
      timestamp: NOW,
    });
    expect(empty.endsWith(createSha256Marker(""))).toBe(true);
  });
});

function createSha256Marker(input: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

describe("computeSignature", () => {
  it("is deterministic", () => {
    const a = computeSignature(SECRET, "payload");
    const b = computeSignature(SECRET, "payload");
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes with secret", () => {
    const a = computeSignature("secret-a", "payload");
    const b = computeSignature("secret-b", "payload");
    expect(a).not.toEqual(b);
  });
});

describe("verifyRequest", () => {
  it("accepts a correctly signed request", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects when timestamp is outside the window", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "", {
      timestamp: NOW - DEFAULT_HMAC_WINDOW_SECONDS - 1,
    });
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timestamp_out_of_window");
  });

  it("rejects when timestamp is in the future beyond the window", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "", {
      timestamp: NOW + DEFAULT_HMAC_WINDOW_SECONDS + 1,
    });
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timestamp_out_of_window");
  });

  it("rejects when signature is corrupt", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    headers[HMAC_SIGNATURE_HEADER] = "00".repeat(32);
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects when body is altered after signing", () => {
    const headers = signedHeadersFor("POST", "/api/sessions", '{"a":1}');
    const result = verifyRequest(
      headers,
      {
        method: "POST",
        path: "/api/sessions",
        body: '{"a":2}',
      },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects when path is altered after signing", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/other", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects when method is altered after signing", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    const result = verifyRequest(
      headers,
      { method: "POST", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects when key id is unknown", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    headers[HMAC_KEY_ID_HEADER] = "rogue-key";
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown_key_id");
  });

  it("rejects when headers are missing", () => {
    const result = verifyRequest(
      {},
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_auth_headers");
  });

  it("rejects when timestamp is not a number", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    headers[HMAC_TIMESTAMP_HEADER] = "not-a-number";
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_timestamp");
  });

  it("rejects when signature is not valid hex", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    headers[HMAC_SIGNATURE_HEADER] = "not-hex";
    const result = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature_format");
  });

  it("is case-insensitive when reading headers", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "");
    const swapped: HeaderLookup = {
      [HMAC_TIMESTAMP_HEADER.toUpperCase()]: headers[HMAC_TIMESTAMP_HEADER],
      [HMAC_KEY_ID_HEADER.toUpperCase()]: headers[HMAC_KEY_ID_HEADER],
      [HMAC_SIGNATURE_HEADER.toUpperCase()]: headers[HMAC_SIGNATURE_HEADER],
    };
    const result = verifyRequest(
      swapped,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a replayed request after the window expires", () => {
    const headers = signedHeadersFor("GET", "/api/chat/stream", "", {
      timestamp: NOW - 60,
    });
    const stillFresh = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      baseConfig,
    );
    expect(stillFresh.ok).toBe(true);

    const afterExpiry = verifyRequest(
      headers,
      { method: "GET", path: "/api/chat/stream", body: "" },
      {
        ...baseConfig,
        nowSeconds: () => NOW - 60 + DEFAULT_HMAC_WINDOW_SECONDS + 1,
      },
    );
    expect(afterExpiry.ok).toBe(false);
    expect(afterExpiry.reason).toBe("timestamp_out_of_window");
  });
});

describe("loadHmacConfigFromEnv", () => {
  it("loads secret, key id and window from env", () => {
    const cfg = loadHmacConfigFromEnv({
      HMAC_SECRET: "s",
      HMAC_KEY_ID: "k",
      HMAC_WINDOW_SECONDS: "120",
    });
    expect(cfg).toEqual({ secret: "s", keyId: "k", windowSeconds: 120 });
  });

  it("throws when required vars are missing", () => {
    expect(() => loadHmacConfigFromEnv({})).toThrow(/HMAC_SECRET/);
    expect(() => loadHmacConfigFromEnv({ HMAC_SECRET: "s" })).toThrow(/HMAC_KEY_ID/);
    expect(() => loadHmacConfigFromEnv({ HMAC_KEY_ID: "k" })).toThrow(/HMAC_SECRET/);
  });

  it("ignores invalid window values", () => {
    const cfg = loadHmacConfigFromEnv({
      HMAC_SECRET: "s",
      HMAC_KEY_ID: "k",
      HMAC_WINDOW_SECONDS: "not-a-number",
    });
    expect(cfg.windowSeconds).toBeUndefined();
  });
});
