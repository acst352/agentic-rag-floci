/**
 * v1.5.0 ingestion pipeline — chunker (commit 4).
 *
 * Estrategia:
 *   1. Si el documento tiene headings (MD), cada heading delimita
 *      un bloque. Un bloque puede exceder maxChars y se subdivide
 *      por overlap (ver más abajo).
 *   2. Si el documento NO tiene headings (TXT, MD plano), se trata
 *      como un único bloque (pre-heading en headings[0]).
 *   3. Cada bloque se subdivide con una ventana deslizante de
 *      maxChars con overlap configurable. Esto preserva contexto
 *      entre chunks adyacentes (importante para embeddings).
 *
 * `chunk_id = ${source}:${index}` — estable entre re-procesos del
 * mismo archivo, lo que hace el upsert idempotente (commit 7).
 *
 * Decisión documentada: el chunker opera SOLO sobre `content` y
 * `headings` del LoadedDocument. NO consulta el disco. Es una
 * función pura.
 */
import type {
  ChunkerOptions,
  ChunkRecord,
  LoadedDocument,
} from "./types.js";

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_OVERLAP_CHARS = 200;

/**
 * Chunkifica un LoadedDocument.
 *
 * Devuelve un array (posiblemente vacío) de ChunkRecord. El array
 * es vacío SOLO si el documento es completamente vacío (no
 * generamos un chunk fantasma para un doc vacío).
 */
export function chunkDocument(
  doc: LoadedDocument,
  options: ChunkerOptions = {},
): ChunkRecord[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  if (maxChars <= 0) {
    throw new RangeError("maxChars must be > 0");
  }
  if (overlapChars < 0 || overlapChars >= maxChars) {
    throw new RangeError("overlapChars must be in [0, maxChars)");
  }

  if (doc.content.length === 0) {
    return [];
  }

  const blocks = extractBlocks(doc);
  const chunks: ChunkRecord[] = [];
  let index = 0;

  for (const block of blocks) {
    const text = doc.content.slice(block.start, block.end);
    const subChunks = slidingWindow(
      text,
      maxChars,
      overlapChars,
      block.start,
    );

    for (const sub of subChunks) {
      chunks.push({
        chunk_id: `${doc.source}:${index}`,
        source: doc.source,
        content: sub.text,
        index,
        heading: block.heading,
      });
      index++;
    }
  }

  return chunks;
}

/**
 * Convierte `headings` (de loader) en bloques chunkables. Cada
 * bloque es un rango [start, end] dentro de `content` con su
 * heading asociado. Para TXT (headings vacío), devuelve un único
 * bloque que cubre todo el documento.
 */
function extractBlocks(
  doc: LoadedDocument,
): Array<{ start: number; end: number; heading: string | undefined }> {
  const blocks: Array<{
    start: number;
    end: number;
    heading: string | undefined;
  }> = [];

  if (doc.headings.length === 0) {
    return [{ start: 0, end: doc.content.length, heading: undefined }];
  }

  for (let i = 0; i < doc.headings.length; i++) {
    const h = doc.headings[i];
    if (!h) continue;

    // El bloque pre-heading (level 0) NO tiene heading asociado.
    if (h.level === 0) {
      if (h.end > h.start) {
        blocks.push({
          start: h.start,
          end: h.end,
          heading: undefined,
        });
      }
      continue;
    }

    // Heading real: el bloque va desde este heading hasta el
    // siguiente (de cualquier nivel).
    const next = doc.headings[i + 1];
    const end = next ? next.start : doc.content.length;
    blocks.push({
      start: h.start,
      end,
      heading: h.text,
    });
  }

  return blocks;
}

/**
 * Ventana deslizante. Devuelve segmentos de texto de hasta
 * `maxChars` con `overlapChars` de solapamiento entre segmentos
 * consecutivos. El último segmento puede ser más corto.
 *
 * Los offsets son absolutos sobre `doc.content`. `blockStart` es
 * el offset donde empieza el bloque actual (necesario para mapear
 * cada chunk de vuelta a su posición global).
 */
function slidingWindow(
  text: string,
  maxChars: number,
  overlapChars: number,
  blockStart: number,
): Array<{ text: string; absStart: number; absEnd: number }> {
  const out: Array<{ text: string; absStart: number; absEnd: number }> = [];
  if (text.length === 0) return out;

  // Si el bloque cabe en un solo chunk, lo emitimos tal cual.
  if (text.length <= maxChars) {
    out.push({
      text,
      absStart: blockStart,
      absEnd: blockStart + text.length,
    });
    return out;
  }

  const stride = maxChars - overlapChars;
  let cursor = 0;
  while (cursor < text.length) {
    const sliceEnd = Math.min(cursor + maxChars, text.length);
    const slice = text.slice(cursor, sliceEnd);
    out.push({
      text: slice,
      absStart: blockStart + cursor,
      absEnd: blockStart + sliceEnd,
    });
    if (sliceEnd === text.length) break;
    cursor += stride;
  }

  return out;
}