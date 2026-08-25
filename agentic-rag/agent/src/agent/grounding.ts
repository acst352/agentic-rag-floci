/**
 * v1.4 H-06 / SEC-20 (PRD §4, §13, OWASP LLM09):
 * "Verificación de fundamentación antes de devolver la respuesta; una
 * respuesta no fundamentada se marca o se sustituye por la abstención
 * de RF-02."
 *
 * Una respuesta está fundamentada cuando su texto contiene, al menos,
 * uno de los identificadores de fuente que las herramientas
 * declararon al producir el contexto. Si no, devolvemos una
 * respuesta de abstención para evitar que el modelo conteste con
 * información no respaldada por la base de conocimiento.
 *
 * Esta capa es deliberadamente conservadora: prefiere sustituir
 * una respuesta correcta que el modelo olvidó citar por una
 * abstención honesta. El coste es una fricción adicional para el
 * usuario, pero es preferible a una respuesta plausiblemente
 * incorrecta que pase el filtro del usuario.
 */

export const ABSTENTION_MESSAGE =
  "No he podido encontrar información fundamentada en la base de conocimiento para responder a esta pregunta. " +
  "Por favor reformula la consulta o verifica si el tema está cubierto en los documentos disponibles.";

/**
 * Resultado de la verificación de fundamentación.
 *  - grounded:   la respuesta cita al menos una fuente declarada.
 *  - abstained:  la respuesta fue sustituida por la abstención.
 */
export type GroundingResult =
  | { kind: "grounded"; response: string; citedSources: string[] }
  | { kind: "abstained"; response: string };

/**
 * Devuelve el conjunto de identificadores de fuente que aparecen
 * como subcadena en la respuesta. La comparación es case-insensitive
 * y se aplica tanto al nombre completo como a sufijo (por si el
 * modelo cita solo "policy-foo.md" cuando la fuente es
 * "docs/policies/policy-foo.md").
 */
function findCitedSources(response: string, sources: string[]): string[] {
  if (!response || sources.length === 0) return [];
  const lower = response.toLowerCase();
  return sources.filter((s) => {
    const candidate = s.toLowerCase();
    if (candidate.length === 0) return false;
    if (lower.includes(candidate)) return true;
    // Sufijo tras la última barra — alinea con cómo los modelos
    // suelen citar documentos.
    const basename = candidate.split("/").pop() ?? candidate;
    if (basename !== candidate && lower.includes(basename)) return true;
    return false;
  });
}

/**
 * Aplica la verificación SEC-20 sobre la respuesta del modelo.
 *
 *  - Si no hay fuentes declaradas (el modelo respondió sin usar
 *    herramientas), la respuesta pasa tal cual: no tenemos base para
 *    decir que no esté fundamentada (RF-02 deja esta puerta abierta
 *    para conocimiento general o salutations).
 *  - Si hay fuentes pero la respuesta no cita ninguna, sustituimos
 *    por la abstención.
 *  - Si la respuesta cita al menos una fuente, la dejamos pasar y
 *    devolvemos cuáles se encontraron citadas para telemetría.
 */
export function enforceGrounding(
  response: string,
  sources: string[],
  options: { abstentionMessage?: string } = {},
): GroundingResult {
  const cited = findCitedSources(response, sources);
  if (cited.length > 0 || sources.length === 0) {
    return { kind: "grounded", response, citedSources: cited };
  }
  return {
    kind: "abstained",
    response: options.abstentionMessage ?? ABSTENTION_MESSAGE,
  };
}