import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { documents } from "../db/schema.js";
import { policyDocuments } from "../data/policies.js";
import { embed } from "../embeddings.js";

console.log("Seeding documents with embeddings...");
console.log(`Embedding model: ${process.env.EMBED_MODEL ?? "nomic-embed-text"}`);
console.log(`Ollama host: ${process.env.OLLAMA_HOST ?? "http://localhost:11434"}`);

await db.delete(documents);

for (const doc of policyDocuments) {
  const start = Date.now();
  const vector = await embed(doc.content);
  const elapsed = Date.now() - start;
  await db.insert(documents).values({
    source: doc.source,
    content: doc.content,
    embedding: vector,
    chunk_id: `${doc.source}:0`,
  });
  console.log(`  [${elapsed}ms] ${doc.source} (${vector.length} dims)`);
}

const result = await db.execute<{ count: string }>(
  sql`SELECT count(*)::int AS count FROM documents`,
);
const count = (result as { rows: { count: string }[] }).rows?.[0]?.count ?? "?";
console.log(`Done. ${count} documents in pgvector.`);
await pool.end();