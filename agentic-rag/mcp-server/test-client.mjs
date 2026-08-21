import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://localhost:3001/sse"));
const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("Tools discovered:", tools.map(t => t.name).join(", "));

const result = await client.callTool({
  name: "search_documents",
  arguments: { query: "¿Cuál es la política de vacaciones?", top_k: 3 },
});
console.log("\nTool result:\n", JSON.stringify(JSON.parse(result.content[0].text), null, 2));

await client.close();