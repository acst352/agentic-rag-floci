import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const HMAC_TIMESTAMP_HEADER = "x-floci-timestamp";
export const HMAC_KEY_ID_HEADER = "x-floci-key-id";
export const HMAC_SIGNATURE_HEADER = "x-floci-signature";
export const HMAC_NONCE_HEADER = "x-floci-nonce";

// v1.2 H-05 (PRD §13): ventana reducida de 300 a 60 segundos.
// Se mantiene configurable vía HMAC_WINDOW_SECONDS en el entorno.
export const DEFAULT_HMAC_WINDOW_SECONDS = 60;

export type HeaderLookup = Record<string, string | string[] | undefined>;

export interface HmacConfig {
  secret: string;
  keyId: string;
  windowSeconds?: number;
  nowSeconds?: () => number;
  nonces?: NonceStore;
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

/**
 * v1.2 H-04 (PRD §4, §13): el path canónico incluye la query string
 * ordenada alfabéticamente por clave. Esto garantiza que firmas
 * coincidan independientemente del orden de llegada de los parámetros.
 *
 * Si rawQuery se pasa explícitamente (recomendado desde middleware),
 * se ordena y se concatena. Si no, se intenta extraer de rawPath.
 */
export function canonicalizePath(rawPath: string, rawQuery?: string | null): string {
  let path = rawPath;
  let query = rawQuery ?? null;

  if (query == null) {
    const qIdx = path.indexOf("?");
    if (qIdx === -1) return path;
    query = path.slice(qIdx + 1);
    path = path.slice(0, qIdx);
  }

  if (!query) return path;

  const params = new URLSearchParams(query);
  const sorted = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${path}?${sorted}`;
}

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
  // v1.2 H-04: firmar sobre el path canónico (con query string
  // ordenada). El servidor hace la misma normalización antes de
  // verificar; de lo contrario firmas para "a=1&b=2" y "b=2&a=1" no
  // coincidirían.
  const canonicalPath = canonicalizePath(req.path);
  const canonical = buildCanonicalString({ ...req, path: canonicalPath, timestamp });
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

/**
 * v1.2 H-05 (PRD §13): NonceStore en memoria con TTL.
 * Limitación consciente: en un despliegue multi-instancia, cada
 * agente tendría su propio Map. En producción v2.0 se sustituirá
 * por una tabla DynamoDB con TTL nativo (SEC-08).
 */
export class NonceStore {
  private readonly store = new Map<string, number>();
  private readonly windowSeconds: number;
  private readonly gcInterval: NodeJS.Timeout;

  constructor(windowSeconds: number) {
    this.windowSeconds = windowSeconds;
    this.gcInterval = setInterval(() => this.gc(), windowSeconds * 1000);
    if (typeof this.gcInterval.unref === "function") this.gcInterval.unref();
  }

  consume(nonce: string, nowMs: number): boolean {
    if (this.store.has(nonce)) return false;
    this.store.set(nonce, nowMs + this.windowSeconds * 1000);
    return true;
  }

  reset(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  private gc(): void {
    const now = Date.now();
    for (const [n, exp] of this.store) {
      if (exp < now) this.store.delete(n);
    }
  }
}

const defaultNonces = new NonceStore(DEFAULT_HMAC_WINDOW_SECONDS);

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
  const nonceHeader = readHeader(headers, HMAC_NONCE_HEADER);

  if (!tsHeader || !sigHeader || !keyHeader) {
    return { ok: false, reason: "missing_auth_headers" };
  }
  if (!nonceHeader) {
    return { ok: false, reason: "missing_nonce" };
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

  // v1.2 H-05: anti-replay con nonce único por request.
  const nonces = cfg.nonces ?? defaultNonces;
  if (!nonces.consume(nonceHeader, cfg.nowSeconds!() * 1000)) {
    return { ok: false, reason: "nonce_replay" };
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
