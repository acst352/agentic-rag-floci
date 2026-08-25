/**
 * v1.4 H-06 / SEC-18 (PRD §4, §13, OWASP LLM01):
 * "Guardrails de entrada y salida en todas las rutas de generación."
 *
 * assessPrompt es la primera capa de defensa sobre el prompt del
 * usuario. NO pretende ser un detector exhaustivo — un atacante
 * motivado puede evadir regex con paraphraseo o codificación.
 * Su función es detener los intentos de libro, elevar el coste del
 * ataque y dejar evidencia en el log (con un identificador, no con
 * el prompt, ver SEC-16).
 *
 * Las capas posteriores son:
 *   - los delimitadores <<CONTEXT_*>> (SEC-19) que separan el
 *     contenido recuperado de las instrucciones,
 *   - la verificación de fundamentación (SEC-20) que reemplaza
 *     respuestas no citadas por abstención,
 *   - el banco de pruebas adversarias (SEC-24) en CI que detecta
 *     regresiones cuando se relajen las reglas.
 *
 * Cualquier cambio en este módulo debe ir acompañado de un caso
 * adversarial correspondiente en test/security/ (SEC-24).
 */

export interface InputGuardConfig {
  /** Máximo de caracteres permitidos. Default 4000. */
  maxLength?: number;
  /** Lista adicional de regex a bloquear (case-insensitive). */
  extraPatterns?: RegExp[];
}

export interface InputGuardOk {
  ok: true;
  /** Prompt normalizado: trim de espacios. La forma es la misma
   *  que el original salvo los espacios al borde. */
  normalized: string;
}

export interface InputGuardBlocked {
  ok: false;
  /** Código estable del motivo: max_length | pattern:<id>. */
  reason: string;
  /** Longitud del prompt si el motivo es max_length, sino undefined. */
  length?: number;
}

export type InputGuardResult = InputGuardOk | InputGuardBlocked;

interface NamedPattern {
  id: string;
  regex: RegExp;
}

/**
 * Patrones por defecto. Diseñados para ser tolerantes con preguntas
 * legítimas en español e inglés. Orden importa: el primer match
 * gana y se loguea su identificador.
 *
 * Mantenemos la lista corta y conservadora. Es preferible un falso
 * negativo (pregunta legítima bloqueada, pero detectable en review)
 * que un falso positivo agresivo que frustra a los usuarios
 * legítimos (riesgo documentado en PRD §14).
 */
const DEFAULT_PATTERNS: NamedPattern[] = [
  {
    id: "ignore_prior_instructions",
    // "ignore all previous instructions", "ignore prior directives"
    regex: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|preceding)\s+(?:instructions?|directives?|prompts?|rules?)\b/i,
  },
  {
    id: "disregard_prior",
    // "disregard the previous rules", "forget everything above"
    regex: /\b(?:disregard|forget|drop)\b[^.\n]*\b(?:previous|prior|above|preceding|earlier)\b/i,
  },
  {
    id: "you_are_now",
    // "you are now a...", "you will be a system that..."
    regex: /\byou\s+(?:are|will\s+be|have\s+become)\s+(?:now\s+)?(?:a|an)\b/i,
  },
  {
    id: "system_role_tag",
    // Mensajes que empiezan con "System:" o "[SYSTEM]" o "Assistant:"
    // cuando llegan al canal de usuario — claramente fuera de banda.
    regex: /^\s*(?:\[?\s*(?:system|assistant|admin)\s*\]?\s*:|<\s*(?:system|assistant)\s*>)/i,
  },
  {
    id: "reveal_system_prompt",
    // "show me your system prompt", "reveal the system instructions"
    regex: /\b(?:show|reveal|print|output|dump|leak)\b[^.\n]*\b(?:system\s+prompt|hidden\s+instructions?|internal\s+prompt)\b/i,
  },
];

export const DEFAULT_INPUT_GUARD_MAX_LENGTH = 4000;

/**
 * Aplica los guardrails de entrada al prompt del usuario.
 *
 * - Vacío o solo whitespace → bloqueado (empty_input). El
 *   validador del schema de Fastify lo cortocircuita para la
 *   mayoría de los casos, pero defendemos aquí por si el caller
 *   cambia el schema.
 * - Excede maxLength → bloqueado (max_length). El cuerpo se
 *   rechaza antes de llegar al LLM, así evitamos amplify
 *   attempts (LLM10) en una sola request.
 * - Matchea uno de los patrones → bloqueado (pattern:<id>).
 *   El id se usa para métricas, no para feedback al usuario.
 * - En cualquier otro caso → ok con la versión normalizada.
 */
export function assessPrompt(
  input: string,
  config: InputGuardConfig = {},
): InputGuardResult {
  const maxLength = config.maxLength ?? DEFAULT_INPUT_GUARD_MAX_LENGTH;
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: "empty_input" };
  }

  if (trimmed.length > maxLength) {
    return { ok: false, reason: "max_length", length: trimmed.length };
  }

  const patterns = [...DEFAULT_PATTERNS];
  if (config.extraPatterns) {
    for (let i = 0; i < config.extraPatterns.length; i++) {
      patterns.push({ id: `extra_${i}`, regex: config.extraPatterns[i] });
    }
  }

  for (const { id, regex } of patterns) {
    if (regex.test(trimmed)) {
      return { ok: false, reason: `pattern:${id}` };
    }
  }

  return { ok: true, normalized: trimmed };
}