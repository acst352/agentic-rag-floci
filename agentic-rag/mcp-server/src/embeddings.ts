const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "nomic-embed-text";

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embeddings failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { embedding: number[] };
  return json.embedding;
}