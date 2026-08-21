import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { registerSearchTool } from "./tools/searchDocuments.js";

const server = new McpServer(
  { name: "rag-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

registerSearchTool(server);

const app = express();
app.use(express.json());

let transport: SSEServerTransport | null = null;

app.get("/sse", async (_req, res) => {
  console.log("[mcp] SSE client connected");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (!transport) {
    res.status(503).json({ error: "No SSE connection established" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "rag-mcp", version: "1.0.0" });
});

const port = Number(process.env.MCP_PORT ?? 3001);
const host = process.env.MCP_HOST ?? "0.0.0.0";

app.listen(port, host, () => {
  console.log(`[mcp] rag-mcp server listening on http://${host}:${port}`);
  console.log(`[mcp] SSE endpoint: GET /sse`);
  console.log(`[mcp] Messages endpoint: POST /messages`);
});

process.on("SIGTERM", () => {
  console.log("[mcp] SIGTERM received, shutting down");
  process.exit(0);
});