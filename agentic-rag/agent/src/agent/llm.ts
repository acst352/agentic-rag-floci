import { Ollama } from "ollama";
import type { Message, Tool as OllamaTool } from "ollama";
import { listMcpTools, callMcpTool } from "./mcpClient.js";
import { mcpToolsToOllama } from "./tools.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const LLM_MODEL = process.env.LLM_MODEL ?? "qwen2.5:3b";
const MAX_ITERATIONS = 5;

const ollama = new Ollama({ host: OLLAMA_HOST });

const SYSTEM_PROMPT = `Eres un asistente corporativo que responde preguntas sobre políticas internas de la empresa.
Tienes acceso a una herramienta de búsqueda semántica sobre la base de conocimiento.

Reglas:
- Si necesitas información documental, usa la herramienta search_documents.
- Cita SIEMPRE la fuente (source) del documento en tu respuesta.
- Si la búsqueda no devuelve resultados relevantes, indícalo claramente.
- Responde en español salvo que te pregunten en otro idioma.
- Sé conciso (máximo 3 párrafos).`;

let ollamaToolsCache: OllamaTool[] | null = null;

async function getOllamaTools(): Promise<OllamaTool[]> {
  if (ollamaToolsCache) return ollamaToolsCache;
  const mcpTools = await listMcpTools();
  ollamaToolsCache = mcpToolsToOllama(mcpTools);
  return ollamaToolsCache;
}

export interface AgentResult {
  response: string;
  iterations: number;
  toolCalls: Array<{ name: string; args: unknown; result: string }>;
  totalMs: number;
}

export type AgentEvent =
  | { type: "token"; token: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; args: unknown; result: string; ms: number }
  | {
      type: "done";
      response: string;
      iterations: number;
      toolCalls: AgentResult["toolCalls"];
      totalMs: number;
    };

export async function* askStream(question: string): AsyncGenerator<AgentEvent> {
  const t0 = Date.now();
  const tools = await getOllamaTools();
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];
  const toolCalls: AgentResult["toolCalls"] = [];
  let fullResponse = "";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let accumulatedContent = "";
    let pendingToolCalls: NonNullable<Message["tool_calls"]> = [];

    const stream = await ollama.chat({
      model: LLM_MODEL,
      messages,
      tools,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.message;
      if (delta.content) {
        accumulatedContent += delta.content;
        fullResponse += delta.content;
        yield { type: "token", token: delta.content };
      }
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        pendingToolCalls = pendingToolCalls.concat(delta.tool_calls);
      }
    }

    if (pendingToolCalls.length === 0) {
      yield {
        type: "done",
        response: accumulatedContent,
        iterations: i + 1,
        toolCalls,
        totalMs: Date.now() - t0,
      };
      return;
    }

    messages.push({
      role: "assistant",
      content: accumulatedContent,
      tool_calls: pendingToolCalls,
    });

    for (const call of pendingToolCalls) {
      const fn = call.function;
      const args = parseArgs(fn.arguments);
      yield { type: "tool_call", name: fn.name, args };
      const t = Date.now();
      const result = await callMcpTool(fn.name, args);
      const ms = Date.now() - t;
      yield { type: "tool_result", name: fn.name, args, result, ms };
      toolCalls.push({ name: fn.name, args, result });
      messages.push({ role: "tool", content: result });
    }
  }

  yield {
    type: "done",
    response: fullResponse || "El agente no pudo converger en el número máximo de iteraciones.",
    iterations: MAX_ITERATIONS,
    toolCalls,
    totalMs: Date.now() - t0,
  };
}

export async function ask(question: string): Promise<AgentResult> {
  let response = "";
  const toolCalls: AgentResult["toolCalls"] = [];
  let iterations = 0;
  let totalMs = 0;
  for await (const event of askStream(question)) {
    switch (event.type) {
      case "token":
        response += event.token;
        break;
      case "tool_call":
        break;
      case "tool_result":
        toolCalls.push({ name: event.name, args: event.args, result: event.result });
        break;
      case "done":
        iterations = event.iterations;
        totalMs = event.totalMs;
        if (!response) response = event.response;
        break;
    }
  }
  return { response, iterations, toolCalls, totalMs };
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return {};
}