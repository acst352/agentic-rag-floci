/**
 * v1.5.0 ingestion pipeline — MD/TXT loader (commit 3).
 *
 * Lee un archivo del filesystem, lo clasifica por extensión y
 * extrae metadata mínima + (en MD) la lista de headings con sus
 * offsets en el contenido. Los headings alimentan al chunker
 * (commit 4) para que cada bloque de contenido sepa a qué sección
 * pertenece — eso termina en pgvector.metadata y permite al
 * grounding check (SEC-20) citar la sección exacta.
 *
 * Formatos soportados en v1.5.0:
 *   - .md  → text/markdown. Extrae headings con sus offsets.
 *   - .txt → text/plain. Sin headings.
 *
 * Formatos NO soportados (PDF/DOCX/HTML): van a v1.5.x. Aquí
 * devolvemos ProcessingError con code=unsupported_format para que
 * el caller marque el job como failed con un mensaje claro.
 *
 * `loadDocument` no hace IO async de red — solo fs y parseo.
 */
import { promises as fs } from "node:fs";
import { basename, extname } from "node:path";
import type {
  HeadingSection,
  LoadedDocument,
  ProcessingError,
} from "./types.js";

const MAX_HEADING_LEVEL = 6;

const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;

export class LoaderError extends Error {
  readonly code: ProcessingError["code"];
  readonly cause?: unknown;

  constructor(
    code: ProcessingError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "LoaderError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Carga un archivo del disco y devuelve un LoadedDocument.
 *
 * @param path        ruta absoluta al archivo.
 * @param source      ruta relativa estable (persiste en pgvector).
 *                    Si se omite, se deriva del basename.
 */
export async function loadDocument(
  path: string,
  source?: string,
): Promise<LoadedDocument> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    throw new LoaderError(
      "load_failed",
      `cannot stat ${path}: ${(err as Error).message}`,
      err,
    );
  }

  if (!stat.isFile()) {
    throw new LoaderError(
      "load_failed",
      `${path} is not a regular file`,
    );
  }

  let content: string;
  try {
    content = await fs.readFile(path, "utf8");
  } catch (err) {
    throw new LoaderError(
      "load_failed",
      `cannot read ${path}: ${(err as Error).message}`,
      err,
    );
  }

  const ext = extname(path).toLowerCase();
  const stableSource = source ?? basename(path);

  if (ext === ".md" || ext === ".markdown") {
    return {
      path,
      source: stableSource,
      content,
      mime: "text/markdown",
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      headings: extractHeadings(content),
    };
  }

  if (ext === ".txt") {
    return {
      path,
      source: stableSource,
      content,
      mime: "text/plain",
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      headings: [],
    };
  }

  throw new LoaderError(
    "unsupported_format",
    `unsupported file extension "${ext}" (supported: .md, .markdown, .txt)`,
  );
}

/**
 * Extrae headings ATX (#, ##, …) con sus offsets en `content`.
 *
 * - El offset `start` apunta al primer carácter del heading
 *   (incluyendo los #).
 * - El offset `end` apunta al carácter siguiente al último
 *   carácter del heading (exclusivo).
 * - El primer bloque (pre-heading) se modela con level=0 y
 *   text="" para que el chunker pueda decidir qué hacer con él.
 *
 * Esta función es exportada para testeo granular. NO se considera
 * API pública estable más allá de los tests.
 */
export function extractHeadings(content: string): HeadingSection[] {
  const headings: HeadingSection[] = [];

  // Bloque pre-heading: desde 0 hasta el primer heading (o el final
  // del documento si no hay headings).
  const firstMatch = HEADING_REGEX.exec(content);
  if (firstMatch) {
    headings.push({
      level: 0,
      text: "",
      start: 0,
      end: firstMatch.index,
    });
  } else {
    headings.push({
      level: 0,
      text: "",
      start: 0,
      end: content.length,
    });
    return headings;
  }

  // Reset regex state porque lo reutilizamos.
  HEADING_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = HEADING_REGEX.exec(content)) !== null) {
    const hashes = match[1] ?? "";
    const text = (match[2] ?? "").trim();
    const level = Math.min(hashes.length, MAX_HEADING_LEVEL);
    const start = match.index;
    const end = match.index + match[0].length;
    headings.push({ level, text, start, end });
  }

  return headings;
}