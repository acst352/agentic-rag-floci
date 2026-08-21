import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export interface SearchResult {
  source: string;
  content: string;
  score: number;
}

export async function searchDocuments(
  queryEmbedding: number[],
  topK: number,
): Promise<SearchResult[]> {
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT source,
           content,
           1 - (embedding <=> ${vectorLiteral}::vector) AS score
    FROM documents
    ORDER BY embedding <=> ${vectorLiteral}::vector
    LIMIT ${topK}
  `);
  const rows = (result as { rows?: Record<string, unknown>[] }).rows ?? [];
  return rows.map((r) => ({
    source: String(r.source),
    content: String(r.content),
    score: Number(r.score),
  }));
}