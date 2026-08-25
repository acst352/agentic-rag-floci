/**
 * v1.5.0 ingestion pipeline — chunker tests.
 *
 * Cubre los casos del commit plan:
 *   1. Chunking por headings (MD con estructura → 1 chunk por heading)
 *   2. Tamaño máximo respetado cuando un bloque excede maxChars
 *   3. Overlap presente entre chunks consecutivos
 *
 * Más casos:
 *   4. Doc vacío → array vacío
 *   5. TXT sin headings → un único bloque
 *   6. chunk_id estable: ${source}:${index}
 *   7. heading del bloque se asigna al chunk
 *   8. Validación de opciones inválidas
 */
import { describe, expect, it } from "vitest";
import { chunkDocument } from "../../src/ingestion/chunker.js";
import type { LoadedDocument } from "../../src/ingestion/types.js";

function makeDoc(
  content: string,
  headings: LoadedDocument["headings"] = [],
): LoadedDocument {
  return {
    path: "/tmp/test.md",
    source: "test.md",
    content,
    mime: "text/markdown",
    size: Buffer.byteLength(content, "utf8"),
    mtime: "2026-01-01T00:00:00.000Z",
    headings,
  };
}

describe("chunkDocument — MD with headings", () => {
  it("emits one chunk per heading (small sections fit in one chunk)", () => {
    const content = [
      "# Title",
      "Intro of title section.",
      "",
      "## Section A",
      "Body of A.",
      "",
      "## Section B",
      "Body of B.",
      "",
    ].join("\n");
    const headings = [
      { level: 0, text: "", start: 0, end: 0 },
      { level: 1, text: "Title", start: 0, end: 7 },
      { level: 2, text: "Section A", start: 38, end: 48 },
      { level: 2, text: "Section B", start: 61, end: 71 },
    ];
    const doc = makeDoc(content, headings);

    const chunks = chunkDocument(doc, { maxChars: 200, overlapChars: 20 });

    // 1 pre-heading vacío (no se emite porque length 0) + 3 headings
    // = 3 chunks
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.heading).toBe("Title");
    expect(chunks[1]?.heading).toBe("Section A");
    expect(chunks[2]?.heading).toBe("Section B");
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[2]?.index).toBe(2);
    expect(chunks[0]?.chunk_id).toBe("test.md:0");
    expect(chunks[2]?.chunk_id).toBe("test.md:2");
  });

  it("subdivides a single large heading block via sliding window", () => {
    const heading = "# Big Section";
    const body = "a".repeat(500);
    const content = `${heading}\n${body}\n`;
    const headings = [
      { level: 0, text: "", start: 0, end: 0 },
      { level: 1, text: "Big Section", start: 0, end: heading.length },
    ];
    const doc = makeDoc(content, headings);

    const chunks = chunkDocument(doc, { maxChars: 100, overlapChars: 20 });

    // 500 chars en bloques de 100 con stride 80 → ceil(500/80) ≈ 7
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(100);
      expect(c.heading).toBe("Big Section");
    }
  });

  it("includes overlap between consecutive chunks of the same block", () => {
    const heading = "# X";
    const body = "abcdefghij".repeat(50); // 500 chars
    const content = `${heading}\n${body}\n`;
    const headings = [
      { level: 0, text: "", start: 0, end: 0 },
      { level: 1, text: "X", start: 0, end: heading.length },
    ];
    const doc = makeDoc(content, headings);

    const chunks = chunkDocument(doc, { maxChars: 100, overlapChars: 30 });

    // Verifica que el último overlapChars del chunk N aparece como
    // prefijo del chunk N+1.
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const curr = chunks[i]!;
      const tail = prev.content.slice(-30);
      expect(curr.content.startsWith(tail)).toBe(true);
    }
  });
});

describe("chunkDocument — TXT / no headings", () => {
  it("emits one chunk per maxChars window for plain text", () => {
    const content = "x".repeat(450);
    const doc = makeDoc(content, []);

    const chunks = chunkDocument(doc, { maxChars: 200, overlapChars: 20 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(200);
      expect(c.heading).toBeUndefined();
    }
  });
});

describe("chunkDocument — edge cases", () => {
  it("returns empty array for empty content", () => {
    const doc = makeDoc("", []);
    expect(chunkDocument(doc)).toEqual([]);
  });

  it("emits single chunk when content fits in maxChars", () => {
    const content = "short content here";
    const doc = makeDoc(content, []);

    const chunks = chunkDocument(doc, { maxChars: 1000, overlapChars: 50 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(content);
    expect(chunks[0]?.index).toBe(0);
  });

  it("skips empty pre-heading blocks", () => {
    // Heading al inicio → no hay bloque pre-heading con contenido.
    const content = "# T\nbody\n";
    const headings = [
      { level: 0, text: "", start: 0, end: 0 },
      { level: 1, text: "T", start: 0, end: 3 },
    ];
    const doc = makeDoc(content, headings);

    const chunks = chunkDocument(doc, { maxChars: 100, overlapChars: 10 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.heading).toBe("T");
  });
});

describe("chunkDocument — option validation", () => {
  it("rejects maxChars <= 0", () => {
    const doc = makeDoc("body", []);
    expect(() => chunkDocument(doc, { maxChars: 0 })).toThrow(RangeError);
  });

  it("rejects overlapChars >= maxChars", () => {
    const doc = makeDoc("body", []);
    expect(() =>
      chunkDocument(doc, { maxChars: 100, overlapChars: 100 }),
    ).toThrow(RangeError);
    expect(() =>
      chunkDocument(doc, { maxChars: 100, overlapChars: 200 }),
    ).toThrow(RangeError);
  });

  it("accepts overlapChars = 0 (no overlap)", () => {
    // Contenido con chars distintos en cada posición para que
    // startsWith() no dé trivialmente true.
    const content = Array.from({ length: 300 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)),
    ).join("");
    const doc = makeDoc(content, []);
    const chunks = chunkDocument(doc, {
      maxChars: 100,
      overlapChars: 0,
    });
    expect(chunks.length).toBe(3);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.content.startsWith(chunks[i - 1]!.content)).toBe(
        false,
      );
    }
  });
});