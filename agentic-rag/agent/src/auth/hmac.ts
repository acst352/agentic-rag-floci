import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const HMAC_TIMESTAMP_HEADER = "x-floci-timestamp";
export const HMAC_KEY_ID_HEADER = "x-floci-key-id";
export const HMAC_SIGNATURE_HEADER = "x-floci-signature";

export const DEFAULT_HMAC_WINDOW_SECONDS = 300;

export type HeaderLookup = Record<string, string | string[] | undefined>;

export interface HmacConfig {
  secret: string;
  keyId: string;
  windowSeconds?: number;
  nowSeconds?: () => number;
}

export interface CanonicalRequest {
  method: string;
  path: string;
  body: string | Buffer;
  timestamp: number;
}

export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

const sha256Hex = (input: string | Buffer): string =>
  createHash("sha256").update(input).digest("hex");

export function buildCanonicalString(req: CanonicalRequest): string {
  const bodyHash = sha256Hex(req.body ?? "");
  return `${req.timestamp}\n${req.method.toUpperCase()}\n${req.path}\n${bodyHash}`;
}

export function computeSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function signRequest(
  req: Omit<CanonicalRequest, "timestamp"> & { timestamp?: number },
  config: Pick<HmacConfig, "secret" | "keyId" | "nowSeconds">,
): {
  timestamp: number;
  signature: string;
  keyId: string;
  canonical: string;
} {
  const nowSeconds = config.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const timestamp = req.timestamp ?? Math.floor(nowSeconds());
  const canonical = buildCanonicalString({ ...req, timestamp });
  const signature = computeSignature(config.secret, canonical);
  return { timestamp, signature, keyId: config.keyId, canonical };
}

function readHeader(headers: HeaderLookup, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      if (Array.isArray(value)) return value[0];
      return value;
    }
  }
  return undefined;
}

export function verifyRequest(
  headers: HeaderLookup,
  req: Omit<CanonicalRequest, "timestamp">,
  config: HmacConfig,
): VerificationResult {
  const cfg: HmacConfig = {
    windowSeconds: DEFAULT_HMAC_WINDOW_SECONDS,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    ...config,
  };

  const tsHeader = readHeader(headers, HMAC_TIMESTAMP_HEADER);
  const sigHeader = readHeader(headers, HMAC_SIGNATURE_HEADER);
  const keyHeader = readHeader(headers, HMAC_KEY_ID_HEADER);

  if (!tsHeader || !sigHeader || !keyHeader) {
    return { ok: false, reason: "missing_auth_headers" };
  }

  const timestamp = Number(tsHeader);
  if (!Number.isFinite(timestamp) || !Number.isInteger(timestamp)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const now = cfg.nowSeconds!();
  if (Math.abs(now - timestamp) > cfg.windowSeconds!) {
    return { ok: false, reason: "timestamp_out_of_window" };
  }

  if (keyHeader !== cfg.keyId) {
    return { ok: false, reason: "unknown_key_id" };
  }

  const canonical = buildCanonicalString({ ...req, timestamp });
  const expected = computeSignature(cfg.secret, canonical);

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sigHeader, "hex");
  if (a.length !== b.length || a.length === 0) {
    return { ok: false, reason: "invalid_signature_format" };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}

export function loadHmacConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HmacConfig {
  const secret = env.HMAC_SECRET;
  const keyId = env.HMAC_KEY_ID;
  if (!secret || !keyId) {
    throw new Error(
      "HMAC auth not configured: set HMAC_SECRET and HMAC_KEY_ID in the environment",
    );
  }
  const windowRaw = env.HMAC_WINDOW_SECONDS;
  const windowSeconds =
    windowRaw && Number.isFinite(Number(windowRaw)) ? Number(windowRaw) : undefined;
  return {
    secret,
    keyId,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  };
}
