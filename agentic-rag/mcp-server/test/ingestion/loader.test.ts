/**
 * v1.5.0 ingestion pipeline — loader tests.
 *
 * Cubre los 5 casos del commit plan (docs/v1.5.0-plan.md §"Commit plan"):
 *   1. MD con headings
 *   2. MD plano (sin headings)
 *   3. TXT
 *   4. Documento vacío
 *   5. Extensión no soportada
 *
 * Más casos derivados:
 *   6. LoaderError se preserva con code estable
 *   7. extractHeadings exportado funciona aislado
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractHeadings,
  loadDocument,
  LoaderError,
} from "../../src/ingestion/loader.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loader-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadDocument — MD", () => {
  it("extracts headings with offsets for MD with structure", async () => {
    const content = [
      "# Title",
      "",
      "Intro paragraph before second heading.",
      "",
      "## Section A",
      "",
      "Body of section A.",
      "",
      "## Section B",
      "",
      "Body of section B.",
      "",
    ].join("\n");
    const path = join(dir, "doc.md");
    await writeFile(path, content, "utf8");

    const doc = await loadDocument(path, "doc.md");

    expect(doc.source).toBe("doc.md");
    expect(doc.mime).toBe("text/markdown");
    expect(doc.size).toBe(Buffer.byteLength(content, "utf8"));
    expect(doc.content).toBe(content);
    // 1 pre-heading + 3 headings
    expect(doc.headings).toHaveLength(4);
    expect(doc.headings[0]?.level).toBe(0);
    expect(doc.headings[1]?.level).toBe(1);
    expect(doc.headings[1]?.text).toBe("Title");
    expect(doc.headings[2]?.level).toBe(2);
    expect(doc.headings[2]?.text).toBe("Section A");
    expect(doc.headings[3]?.level).toBe(2);
    expect(doc.headings[3]?.text).toBe("Section B");
    // offsets son coherentes
    expect(doc.headings[1]?.start).toBe(0);
    expect(doc.headings[2]?.start).toBeGreaterThan(doc.headings[1]!.end);
  });

  it("returns single pre-heading block for MD without headings", async () => {
    const content = "just plain prose without any markdown structure here.\n";
    const path = join(dir, "flat.md");
    await writeFile(path, content, "utf8");

    const doc = await loadDocument(path, "flat.md");

    expect(doc.mime).toBe("text/markdown");
    expect(doc.headings).toHaveLength(1);
    expect(doc.headings[0]?.level).toBe(0);
    expect(doc.headings[0]?.start).toBe(0);
    expect(doc.headings[0]?.end).toBe(content.length);
  });

  it("accepts .markdown as an alias for .md", async () => {
    const path = join(dir, "doc.markdown");
    await writeFile(path, "# Hi\n", "utf8");

    const doc = await loadDocument(path, "doc.markdown");

    expect(doc.mime).toBe("text/markdown");
    expect(doc.headings).toHaveLength(2);
  });
});

describe("loadDocument — TXT", () => {
  it("loads plain text with mime=text/plain and no headings", async () => {
    const content = "First line.\nSecond line.\nThird line.\n";
    const path = join(dir, "notes.txt");
    await writeFile(path, content, "utf8");

    const doc = await loadDocument(path, "notes.txt");

    expect(doc.source).toBe("notes.txt");
    expect(doc.mime).toBe("text/plain");
    expect(doc.content).toBe(content);
    expect(doc.headings).toEqual([]);
  });
});

describe("loadDocument — edge cases", () => {
  it("handles an empty document without throwing", async () => {
    const path = join(dir, "empty.md");
    await writeFile(path, "", "utf8");

    const doc = await loadDocument(path, "empty.md");

    expect(doc.content).toBe("");
    expect(doc.size).toBe(0);
    // El bloque pre-heading cubre todo el documento (length 0).
    expect(doc.headings).toHaveLength(1);
    expect(doc.headings[0]?.start).toBe(0);
    expect(doc.headings[0]?.end).toBe(0);
  });

  it("throws LoaderError unsupported_format for unknown extensions", async () => {
    const path = join(dir, "data.json");
    await writeFile(path, '{"a":1}', "utf8");

    await expect(loadDocument(path, "data.json")).rejects.toMatchObject({
      name: "LoaderError",
      code: "unsupported_format",
    });
  });

  it("throws LoaderError load_failed when file is missing", async () => {
    const path = join(dir, "ghost.md");

    await expect(loadDocument(path, "ghost.md")).rejects.toMatchObject({
      name: "LoaderError",
      code: "load_failed",
    });
  });

  it("derives source from basename when not provided", async () => {
    const path = join(dir, "auto.txt");
    await writeFile(path, "body", "utf8");

    const doc = await loadDocument(path);

    expect(doc.source).toBe("auto.txt");
  });
});

describe("extractHeadings — direct", () => {
  it("ignores headings inside fenced code blocks? v1.5.0: no", () => {
    // Decisión documentada en el plan: extracción regex simple.
    // El bloque fenced # no es un heading real. Por simplicidad
    // NO parseamos el fence; el quarantine stage detecta inyecciones
    // y la longitud máxima evita payloads disfrazados de fence.
    const content = "# Real\n```\n# Fake inside code\n```\n";
    const headings = extractHeadings(content);
    expect(headings.length).toBeGreaterThanOrEqual(2);
    // El primer heading es real
    expect(headings[1]?.text).toBe("Real");
  });

  it("caps heading level at 6 for 6-hash headings", () => {
    const content = "###### Deepest\n\n# Shallow\n";
    const headings = extractHeadings(content);
    const h6 = headings.find((x) => x.level === 6);
    expect(h6?.text).toBe("Deepest");
    // La regex exige \s+ después de los hashes; 7+ hashes no matchean.
    expect(headings.some((x) => x.level > 6)).toBe(false);
  });
});