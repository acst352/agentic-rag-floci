import { createHmac, timingSafeEqual, createHash } from "node:crypto";

export const HMAC_TIMESTAMP_HEADER = "x-floci-timestamp";
export const HMAC_KEY_ID_HEADER = "x-floci-key-id";
export const HMAC_SIGNATURE_HEADER = "x-floci-signature";
export const HMAC_NONCE_HEADER = "x-floci-nonce";

// v1.3 H-03 (PRD §4, §13): subject firmado. Es la identidad lógica
// del llamante; en producción será el `sub` del OIDC. En desarrollo
// se reutiliza el HMAC_KEY_ID como subject por defecto.
export const HMAC_SUBJECT_HEADER = "x-floci-subject";

// v1.2 H-05 (PRD §13): ventana reducida de 300 a 60 segundos.
// Se mantiene configurable vía HMAC_WINDOW_SECONDS en el entorno.
export const DEFAULT_HMAC_WINDOW_SECONDS = 60;

export type HeaderLookup = Record<string, string | string[] | undefined>;

export interface HmacConfig {
  secret: string;
  keyId: string;
  /**
   * v1.3 H-03: subject por defecto cuando el cliente no envía
   * `X-Floci-Subject`. Útil en la transición desde v1.2.x donde el
   * header no existía; en v2.0 será obligatorio y este default caerá.
   * Si no se define, se exige el header (recommended).
   */
  defaultSubject?: string;
  windowSeconds?: number;
  nowSeconds?: () => number;
  nonces?: NonceStore;
}

export interface CanonicalRequest {
  method: string;
  path: string;
  body: string | Buffer;
  timestamp: number;
  // v1.3 H-03: subject (identidad lógica del llamante). Requerido
  // por signRequest (quien firma) y por buildCanonicalString; lo
  // omite el caller de verifyRequest porque el servidor lo lee del
  // header X-Floci-Subject.
  subject?: string;
}

export interface VerificationResult {
  ok: boolean;
  reason?: string;
  // v1.3 H-03: subject verificado (vacío si ok === false).
  subject?: string;
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
  // v1.3 H-03: la cadena canónica incluye el subject como quinto
  // campo, al final. Mantener el subject en la firma garantiza que
  // un atacante con una firma capturada no pueda suplantar la
  // identidad del llamante; sin este campo, GET /api/sessions/:id
  // sería vulnerable a IDOR incluso con HMAC válido.
  return `${req.timestamp}\n${req.method.toUpperCase()}\n${req.path}\n${bodyHash}\n${req.subject ?? ""}`;
}

export function computeSignature(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function signRequest(
  req: Omit<CanonicalRequest, "timestamp" | "subject"> & {
    timestamp?: number;
    // v1.3 H-03: el subject es obligatorio al firmar; quien firma
    // declara explícitamente bajo qué identidad emite la firma.
    subject: string;
  },
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
  // v1.3 H-03: subject leído del header. Si está vacío, cae al
  // defaultSubject configurado (compatibilidad transitoria desde
  // v1.2.x donde el header no existía); si no hay default, se
  // rechaza con missing_subject.
  const subjectHeader = readHeader(headers, HMAC_SUBJECT_HEADER);

  if (!tsHeader || !sigHeader || !keyHeader) {
    return { ok: false, reason: "missing_auth_headers" };
  }
  if (!nonceHeader) {
    return { ok: false, reason: "missing_nonce" };
  }

  let subject = subjectHeader ?? "";
  if (!subject) {
    if (!cfg.defaultSubject) {
      return { ok: false, reason: "missing_subject" };
    }
    subject = cfg.defaultSubject;
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

  const canonical = buildCanonicalString({ ...req, timestamp, subject });
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

  return { ok: true, subject };
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
  const defaultSubject = env.HMAC_SUBJECT;
  return {
    secret,
    keyId,
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    // v1.3 H-03: si HMAC_SUBJECT está en el entorno, se usa como
    // identidad por defecto cuando el cliente no envía
    // X-Floci-Subject. En desarrollo esto evita romper clientes que
    // aún no propagan el header. En v2.0 este fallback caerá.
    ...(defaultSubject ? { defaultSubject } : {}),
  };
}
