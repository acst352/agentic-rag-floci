/**
 * v1.5.0 ingestion pipeline — SEC-18 regex patterns (mirror).
 *
 * MIRROR of agent/src/security/inputGuard.ts DEFAULT_PATTERNS.
 *
 * Mantenemos una copia aquí (en vez de importar cross-package)
 * porque mcp-server y agent son dos paquetes sin workspace
 * compartido en este monorepo (ver docs/v1.5.0-plan.md §"Decisiones
 * locked-in"). Si agent modifica DEFAULT_PATTERNS, hay que
 * sincronizar este archivo en el siguiente PR.
 *
 * El uso de estos patrones en el contexto de la ingesta es
 * DETECTAR documentos cuyo cuerpo intenta inyectar instrucciones
 * al agente. Si el cuerpo del documento matchea cualquiera de
 * estos patrones, el documento va a cuarentena con
 * reason `pattern:<id>` y NO se embeddea ni se persiste en
 * pgvector. El operador lo revisa y decide.
 *
 * Esta capa complementa (no reemplaza) SEC-20 (grounding check
 * en runtime) y SEC-19 (delimitadores <<CONTEXT_*>>). Documentación
 * completa en docs/prompt-injection.md.
 */

export interface NamedPattern {
  /** Identificador estable, parte de QuarantineReason (`pattern:<id>`). */
  id: string;
  /** Regex compilada. */
  regex: RegExp;
}

/**
 * Lista conservadora. Ver agent/src/security/inputGuard.ts para
 * el rationale completo y el orden de evaluación (importa: el
 * primer match gana).
 */
export const DEFAULT_INGEST_PATTERNS: NamedPattern[] = [
  {
    id: "ignore_prior_instructions",
    regex: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|preceding)\s+(?:instructions?|directives?|prompts?|rules?)\b/i,
  },
  {
    id: "disregard_prior",
    regex: /\b(?:disregard|forget|drop)\b[^.\n]*\b(?:previous|prior|above|preceding|earlier)\b/i,
  },
  {
    id: "you_are_now",
    regex: /\byou\s+(?:are|will\s+be|have\s+become)\s+(?:now\s+)?(?:a|an)\b/i,
  },
  {
    id: "system_role_tag",
    regex: /^\s*(?:\[?\s*(?:system|assistant|admin)\s*\]?\s*:|<\s*(?:system|assistant)\s*>)/i,
  },
  {
    id: "reveal_system_prompt",
    regex: /\b(?:show|reveal|print|output|dump|leak)\b[^.\n]*\b(?:system\s+prompt|hidden\s+instructions?|internal\s+prompt)\b/i,
  },
];