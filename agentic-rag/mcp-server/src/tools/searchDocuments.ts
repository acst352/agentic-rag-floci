import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { embed } from "../embeddings.js";
import { searchDocuments } from "../rag/search.js";

export function registerSearchTool(server: McpServer): void {
  server.tool(
    "search_documents",
    "Busca documentos relevantes en la base de conocimiento interna usando búsqueda semántica. Devuelve los chunks más similares a la consulta.",
    {
      query: z
        .string()
        .min(3)
        .describe("Texto de la búsqueda en lenguaje natural (español o inglés)"),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Número de resultados a devolver (1-10, default 5)"),
    },
    async ({ query, top_k }) => {
      const t0 = Date.now();
      const queryEmbedding = await embed(query);
      const tEmbed = Date.now() - t0;

      const t1 = Date.now();
      const results = await searchDocuments(queryEmbedding, top_k);
      const tSearch = Date.now() - t1;

      const summary = results.map((r, i) => ({
        rank: i + 1,
        score: Number(r.score.toFixed(4)),
        source: r.source,
        excerpt: r.content.slice(0, 200) + (r.content.length > 200 ? "..." : ""),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                top_k,
                timing_ms: { embed: tEmbed, search: tSearch, total: Date.now() - t0 },
                results: summary,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}