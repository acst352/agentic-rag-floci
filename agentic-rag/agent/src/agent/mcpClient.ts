import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:3001/sse";

let client: Client | null = null;
let toolsCache: Awaited<ReturnType<Client["listTools"]>>["tools"] | null = null;

export async function getMcpClient(): Promise<Client> {
  if (client) return client;
  const transport = new SSEClientTransport(new URL(MCP_URL));
  client = new Client({ name: "rag-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

export async function listMcpTools() {
  if (toolsCache) return toolsCache;
  const c = await getMcpClient();
  const { tools } = await c.listTools();
  toolsCache = tools;
  return tools;
}

export async function callMcpTool(name: string, args: Record<string, unknown>) {
  const c = await getMcpClient();
  const result = await c.callTool({ name, arguments: args });
  const blocks = (result.content ?? []) as Array<{ type: string; text?: string }>;
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return text;
}

export async function closeMcpClient() {
  if (client) {
    await client.close();
    client = null;
    toolsCache = null;
  }
}