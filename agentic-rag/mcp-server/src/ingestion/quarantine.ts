/**
 * v1.5.0 ingestion pipeline — quarantine stage (SEC-21).
 *
 * Evalúa un LoadedDocument y decide si pasa al pipeline de
 * embedding o va a cuarentena. Las reglas v1.5.0 son:
 *
 *   - length_too_large:   doc > 500 KB (probablemente abuso o error)
 *   - length_too_small:   doc < 100 B (probablemente ruido)
 *   - pattern:<id>:       el cuerpo matchea una de las regex SEC-18
 *                         (mirror en src/security/patterns.ts)
 *   - encoding_suspicious: > 5% control chars, o bloque base64 > 2 KB
 *   - mime_mismatch:       extensión declarada vs content sniff
 *
 * La evaluación es first-match-wins en el orden de arriba.
 * El primer motivo encontrado se reporta; los siguientes NO se
 * evalúan. Esto da razones estables en logs y métricas.
 *
 * Si el documento pasa todas las reglas → { ok: true }. Si falla
 * alguna → { ok: false, reason } con `reason` poblado. El caller
 * (cli.ts / watcher.ts) marca el job como `quarantined` con esa
 * razón.
 *
 * Esta función es pura: NO hace IO, NO consulta servicios. La
 * orquestación es responsabilidad del pipeline.
 */
import type {
  LoadedDocument,
  QuarantineReason,
} from "./types.js";
import {
  DEFAULT_INGEST_PATTERNS,
  type NamedPattern,
} from "../security/patterns.js";

export interface QuarantineOk {
  ok: true;
}
export interface QuarantineBlocked {
  ok: false;
  reason: QuarantineReason;
}
export type QuarantineResult = QuarantineOk | QuarantineBlocked;

export interface QuarantineLimits {
  /** Doc con tamaño estrictamente mayor a este pasa a length_too_large. */
  maxBytes?: number;
  /** Doc con tamaño estrictamente menor a este pasa a length_too_small. */
  minBytes?: number;
  /** Fracción máxima (0..1) de control chars sobre el total. */
  maxControlRatio?: number;
  /** Bloque base64 contiguo más largo permitido (chars). */
  maxBase64Run?: number;
  /** Patrones adicionales a aplicar (extiende los DEFAULT_INGEST_PATTERNS). */
  extraPatterns?: NamedPattern[];
}

export const DEFAULT_QUARANTINE_LIMITS: Required<
  Omit<QuarantineLimits, "extraPatterns">
> = {
  maxBytes: 500 * 1024, // 500 KB
  minBytes: 100, // 100 B
  maxControlRatio: 0.05, // 5 %
  maxBase64Run: 2048, // 2 KB
};

const BASE64_LIKE_REGEX = /[A-Za-z0-9+/=]{64,}/g;

export function assessDocument(
  doc: LoadedDocument,
  limits: QuarantineLimits = {},
): QuarantineResult {
  const cfg = { ...DEFAULT_QUARANTINE_LIMITS, ...limits };
  const patterns = [...DEFAULT_INGEST_PATTERNS];
  if (limits.extraPatterns) {
    for (let i = 0; i < limits.extraPatterns.length; i++) {
      const p = limits.extraPatterns[i];
      if (p) patterns.push({ id: `extra_${i}`, regex: p.regex });
    }
  }

  // 1. length_too_large
  if (doc.size > cfg.maxBytes) {
    return { ok: false, reason: "length_too_large" };
  }

  // 2. length_too_small
  if (doc.size < cfg.minBytes) {
    return { ok: false, reason: "length_too_small" };
  }

  // 3. pattern:<id> — sobre el cuerpo completo del documento.
  for (const { id, regex } of patterns) {
    if (regex.test(doc.content)) {
      return { ok: false, reason: `pattern:${id}` };
    }
  }

  // 4. encoding_suspicious
  if (hasEncodingIssues(doc.content, cfg.maxControlRatio, cfg.maxBase64Run)) {
    return { ok: false, reason: "encoding_suspicious" };
  }

  // 5. mime_mismatch — solo verificable cuando extension ↔ sniff
  //    discrepan. Para v1.5.0 sniff básico: presencia de bytes
  //    binarios en un doc que se declara text/*.
  if (isBinary(doc.content) && doc.mime.startsWith("text/")) {
    return { ok: false, reason: "mime_mismatch" };
  }

  return { ok: true };
}

/**
 * Cuenta chars de control (NUL, BEL, etc.) y runs de base64-like.
 * Un run es una secuencia contigua de [A-Za-z0-9+/=] de longitud
 * ≥ 64 (suficiente para embebir una instrucción en base64).
 */
function hasEncodingIssues(
  content: string,
  maxControlRatio: number,
  maxBase64Run: number,
): boolean {
  if (content.length === 0) return false;

  let controlCount = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (
      (code >= 0 && code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      controlCount++;
    }
  }
  if (controlCount / content.length > maxControlRatio) return true;

  BASE64_LIKE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASE64_LIKE_REGEX.exec(content)) !== null) {
    if (match[0].length > maxBase64Run) return true;
  }

  return false;
}

/**
 * Heurística binaria: presencia de NUL o proporción alta de chars
 * fuera del rango printable ASCII / tab / newline.
 */
function isBinary(content: string): boolean {
  if (content.length === 0) return false;
  let weird = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 0) return true; // NUL es señal fuerte
    if (code > 127 && code < 160) weird++;
    if (code > 245) weird++;
  }
  return weird / content.length > 0.1;
}