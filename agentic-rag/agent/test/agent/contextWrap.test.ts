import { describe, expect, it } from "vitest";
import {
  CONTEXT_END,
  CONTEXT_START,
  extractContextSources,
  extractSourcesFromContextOrNull,
  looksLikeContextBlock,
  wrapContextBlock,
} from "../../src/agent/contextWrap";

describe("wrapContextBlock (H-06 / SEC-19)", () => {
  it("wraps raw content with start and end delimiters", () => {
    const wrapped = wrapContextBlock("hello world", { source: "search_documents" });
    expect(wrapped).toContain(CONTEXT_START);
    expect(wrapped).toContain(CONTEXT_END);
    expect(wrapped).toContain("hello world");
  });

  it("embeds the tool source in the start delimiter header", () => {
    const wrapped = wrapContextBlock("x", { source: "search_documents" });
    expect(wrapped).toContain(`tool=${JSON.stringify("search_documents")}`);
  });

  it("embeds sources JSON in the start delimiter header when provided", () => {
    const wrapped = wrapContextBlock("x", {
      source: "search_documents",
      sources: ["a.md", "b.md"],
    });
    expect(wrapped).toContain(`sources=${JSON.stringify(["a.md", "b.md"])}`);
  });

  it("omits the sources attribute when the list is empty", () => {
    const wrapped = wrapContextBlock("x", { source: "search_documents", sources: [] });
    expect(wrapped).not.toContain("sources=");
  });

  it("preserves the raw content verbatim (including newlines)", () => {
    const raw = "línea 1\nlínea 2\n<<COSA>>";
    const wrapped = wrapContextBlock(raw, { source: "t" });
    expect(wrapped).toContain(raw);
  });

  it("places the closing delimiter on its own line", () => {
    const wrapped = wrapContextBlock("payload", { source: "t" });
    expect(wrapped.endsWith(`\n${CONTEXT_END}`)).toBe(true);
  });
});

describe("looksLikeContextBlock", () => {
  it("returns true for a wrapped block", () => {
    const wrapped = wrapContextBlock("x", { source: "t" });
    expect(looksLikeContextBlock(wrapped)).toBe(true);
  });

  it("returns false for plain user content", () => {
    expect(looksLikeContextBlock("¿Cuál es la política?")).toBe(false);
  });

  it("is not fooled by a partial start delimiter without the end", () => {
    expect(looksLikeContextBlock(`${CONTEXT_START} tool="t">\nhello`)).toBe(false);
  });

  it("ignores leading whitespace", () => {
    const wrapped = wrapContextBlock("x", { source: "t" });
    expect(looksLikeContextBlock(`   \n${wrapped}`)).toBe(true);
  });
});

describe("extractContextSources / extractSourcesFromContextOrNull", () => {
  it("round-trips the sources declared in the header", () => {
    const wrapped = wrapContextBlock("x", {
      source: "search_documents",
      sources: ["policy-vacaciones.md", "policy-codereview.md"],
    });
    expect(extractContextSources(wrapped)).toEqual([
      "policy-vacaciones.md",
      "policy-codereview.md",
    ]);
  });

  it("returns [] when no sources attribute is present", () => {
    const wrapped = wrapContextBlock("x", { source: "search_documents" });
    expect(extractContextSources(wrapped)).toEqual([]);
  });

  it("returns null when the text is not a context block", () => {
    expect(extractSourcesFromContextOrNull("plain text")).toBeNull();
  });

  it("survives a sources array with a single string", () => {
    const wrapped = wrapContextBlock("x", {
      source: "search_documents",
      sources: ["only-one.md"],
    });
    expect(extractContextSources(wrapped)).toEqual(["only-one.md"]);
  });

  it("returns [] when the sources JSON is malformed", () => {
    const broken = `${CONTEXT_START} tool="t" sources=[unclosed>>\nx\n${CONTEXT_END}`;
    // Cabecera malformada → sin sources, pero sigue siendo un bloque.
    expect(extractContextSources(broken)).toEqual([]);
  });
});