import { describe, expect, it } from "vitest";
import {
  ABSTENTION_MESSAGE,
  enforceGrounding,
  type GroundingResult,
} from "../../src/agent/grounding";

describe("enforceGrounding (H-06 / SEC-20)", () => {
  it("passes through when no sources were declared", () => {
    const r = enforceGrounding("Hola, soy un asistente.", []);
    expect(r.kind).toBe("grounded");
    if (r.kind === "grounded") {
      expect(r.response).toBe("Hola, soy un asistente.");
      expect(r.citedSources).toEqual([]);
    }
  });

  it("passes through when the response cites at least one source verbatim", () => {
    const r = enforceGrounding(
      "Según policy-vacaciones.md, tienes 22 días.",
      ["policy-vacaciones.md", "policy-codereview.md"],
    );
    expect(r.kind).toBe("grounded");
    if (r.kind === "grounded") {
      expect(r.response).toContain("policy-vacaciones.md");
      expect(r.citedSources).toEqual(["policy-vacaciones.md"]);
    }
  });

  it("accepts citation of the basename when the source is a path", () => {
    const r = enforceGrounding(
      "Ver policy-vacaciones.md, sección 3.",
      ["docs/policies/policy-vacaciones.md"],
    );
    expect(r.kind).toBe("grounded");
    if (r.kind === "grounded") {
      expect(r.citedSources).toEqual(["docs/policies/policy-vacaciones.md"]);
    }
  });

  it("is case-insensitive on the citation match", () => {
    const r = enforceGrounding("Mira POLICY-VACACIONES.MD", ["policy-vacaciones.md"]);
    expect(r.kind).toBe("grounded");
  });

  it("substitutes with abstention when sources exist but none are cited", () => {
    const r = enforceGrounding(
      "Hay 22 días disponibles, según la empresa.",
      ["policy-vacaciones.md"],
    );
    expect(r.kind).toBe("abstained");
    if (r.kind === "abstained") {
      expect(r.response).toBe(ABSTENTION_MESSAGE);
    }
  });

  it("accepts a custom abstention message when configured", () => {
    const custom = "Reformula, no encuentro base.";
    const r = enforceGrounding(
      "Cualquier cosa sin fuente.",
      ["policy.md"],
      { abstentionMessage: custom },
    );
    expect(r.kind).toBe("abstained");
    if (r.kind === "abstained") expect(r.response).toBe(custom);
  });

  it("returns multiple cited sources when several appear in the response", () => {
    const r = enforceGrounding(
      "policy-a.md y policy-b.md lo confirman.",
      ["policy-a.md", "policy-b.md", "policy-c.md"],
    );
    expect(r.kind).toBe("grounded");
    if (r.kind === "grounded") {
      expect(r.citedSources.sort()).toEqual(["policy-a.md", "policy-b.md"]);
    }
  });

  it("treats an empty response with declared sources as not grounded", () => {
    const r = enforceGrounding("", ["policy.md"]);
    expect(r.kind).toBe("abstained");
  });

  it("treats an empty response with no declared sources as grounded (passthrough)", () => {
    const r = enforceGrounding("", []);
    expect(r.kind).toBe("grounded");
    if (r.kind === "grounded") expect(r.response).toBe("");
  });

  it("ignores empty source strings when matching citations", () => {
    const r = enforceGrounding("Texto que cita policy.md.", ["", "policy.md"]);
    expect(r.kind).toBe("grounded");
    if (r.kind === "grounded") {
      expect(r.citedSources).toEqual(["policy.md"]);
    }
  });

  it("falls back to the default abstention message when none configured", () => {
    const r = enforceGrounding("sin cita", ["a.md"]);
    expect(r.kind).toBe("abstained");
    if (r.kind === "abstained") {
      expect(r.response.length).toBeGreaterThan(0);
      expect(r.response).toContain("fundamentada");
    }
  });
});

describe("GroundingResult discriminated union", () => {
  it("narrows on .kind === 'grounded'", () => {
    const r: GroundingResult = enforceGrounding("hola", []);
    if (r.kind === "grounded") {
      // La rama grounded expone response y citedSources.
      expect(typeof r.response).toBe("string");
      expect(Array.isArray(r.citedSources)).toBe(true);
    }
  });

  it("narrows on .kind === 'abstained'", () => {
    const r: GroundingResult = enforceGrounding("hola", ["a.md"]);
    if (r.kind === "abstained") {
      expect(typeof r.response).toBe("string");
    }
  });
});