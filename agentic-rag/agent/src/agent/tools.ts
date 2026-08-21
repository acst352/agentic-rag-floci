import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// Convierte MCP tools (JSON Schema) → Ollama tools (OpenAI function calling format).
export function mcpToolsToOllama(mcpTools: Tool[]) {
  return mcpTools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: sanitizeSchema(t.inputSchema),
    },
  }));
}

// pgvector-like custom types y campos opcionales pueden dar problemas
// con strict mode de Ollama. Aquí simplificamos al mínimo viable.
function sanitizeSchema(schema: Tool["inputSchema"]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "object",
    properties: {},
    required: [] as string[],
  };
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(props)) {
    const v = value as { type?: string; description?: string; enum?: unknown[] };
    const prop: Record<string, unknown> = { type: v.type ?? "string" };
    if (v.description) prop.description = v.description;
    if (v.enum) prop.enum = v.enum;
    (out.properties as Record<string, unknown>)[key] = prop;
  }
  if (Array.isArray(schema.required)) {
    out.required = schema.required;
  }
  return out;
}