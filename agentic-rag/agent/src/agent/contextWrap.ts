/**
 * v1.4 H-06 / SEC-19 (PRD §4, §13, OWASP LLM01):
 * "Separación explícita de datos e instrucciones. El contenido
 * recuperado se delimita con marcadores y se acompaña de una
 * instrucción que prohíbe obedecer instrucciones contenidas en él."
 *
 * Cada bloque de contexto que el agente reinyecta al LLM se envuelve
 * en `<<CONTEXT_START ...>>...<<CONTEXT_END>>` para que el modelo
 * pueda distinguir, sin ambigüedad, qué partes del prompt son
 * instrucciones del sistema/usuario y cuáles son datos no
 * confiables que podrían contener instrucciones adversarias
 * (indirect prompt injection, OWASP LLM01).
 *
 * El delimitador se aplica a nivel del orquestador (este módulo),
 * no en el mcp-server. Eso evita que un futuro cambio en el
 * transporte del MCP borre los marcadores accidentalmente, y
 * deja la lógica defensiva en el único componente que ejecuta el
 * prompt.
 */

export interface WrappedContextOptions {
  /**
   * Etiqueta libre del origen del bloque (tool name, ingestion
   * pipeline, etc.). Aparece en el delimitador de apertura y
   * nunca como instrucción ejecutable.
   */
  source: string;
  /**
   * Lista de identificadores de fuente (e.g. nombres de archivo,
   * URLs de Confluence, IDs de documento). Se serializa como JSON
   * válido dentro del delimitador; el parser lo ignora salvo que
   * se llame explícitamente a extractContextSources (usado por el
   * grounding check SEC-20 en otro commit).
   */
  sources?: string[];
}

export const CONTEXT_START = "<<CONTEXT_START";
export const CONTEXT_END = "<<CONTEXT_END>>";

/**
 * Envuelve `raw` en un bloque CONTEXT delimitado. La cadena
 * resultante es segura de pasar como contenido de un mensaje
 * `{ role: "tool" }` al LLM; el delimitador no contiene saltos de
 * línea en la cabecera para que ningún modelo pueda confundir el
 * cierre accidentalmente.
 */
export function wrapContextBlock(raw: string, options: WrappedContextOptions): string {
  const sourcesAttr = options.sources && options.sources.length > 0
    ? ` sources=${JSON.stringify(options.sources)}`
    : "";
  const header = `${CONTEXT_START} tool=${JSON.stringify(options.source)}${sourcesAttr}>>`;
  return `${header}\n${raw}\n${CONTEXT_END}`;
}

/**
 * Detecta si un texto dado es un bloque CONTEXT nuestro (es decir,
 * cumple el formato que wrapContextBlock produce). Usado por
 * herramientas de auditoría y por el parser del grounding check
 * (SEC-20) cuando se hace round-trip del mensaje.
 */
export function looksLikeContextBlock(text: string): boolean {
  return text.trimStart().startsWith(CONTEXT_START) && text.includes(CONTEXT_END);
}

/**
 * Intenta recuperar la lista de `sources` que puso
 * wrapContextBlock en la cabecera. Devuelve [] si no se reconoce
 * el bloque, lo que el grounding check trata como "no cited" y
 * dispara abstención.
 */
export function extractContextSources(text: string): string[] {
  const start = text.indexOf(CONTEXT_START);
  if (start === -1) return [];
  const end = text.indexOf(">>", start + CONTEXT_START.length);
  if (end === -1) return [];
  const header = text.slice(start, end);
  const match = header.match(/sources=("([^"]*)"|\[(.*)\])/);
  if (!match) return [];
  const raw = match[2] !== undefined ? match[2] : match[3] ?? "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.startsWith("[") ? raw : `[${raw}]`);
    if (Array.isArray(parsed)) return parsed.map((s) => String(s));
  } catch {
    // Fallback: split por coma si parece CSV
    return raw
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return [];
}

/**
 * Extrae las `sources` que el bloque CONTEXT declara, sin
 * distinguir si el bloque fue producido por wrapContextBlock.
 * Devuelve null si el texto no parece un bloque CONTEXT, lo que
 * el grounding check trata como "no cited" y dispara abstención.
 */
export function extractSourcesFromContextOrNull(text: string): string[] | null {
  if (!looksLikeContextBlock(text)) return null;
  return extractContextSources(text);
}