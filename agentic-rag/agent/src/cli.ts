import { randomUUID } from "node:crypto";
import { ask } from "./agent/llm.js";
import { ensureTable, saveSession } from "./session/store.js";
import { closeMcpClient } from "./agent/mcpClient.js";

const VERBOSE = process.argv.includes("--verbose") || process.argv.includes("-v");

function usage(): never {
  console.log(`Uso: npm run start -- -- "<pregunta>" [--session <id>] [--verbose]

Ejemplos:
  npm run start -- "¿Cuál es la política de vacaciones?"
  npm run start -- -- "¿Qué dice sobre code review?" --session abc-123`);
  process.exit(1);
}

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const questionIdx = process.argv.findIndex((a) => a === "--");
  const question = questionIdx >= 0 ? process.argv[questionIdx + 1] : process.argv[2];

  if (!question || question.startsWith("--")) usage();

  const sessionId = getArg("--session") ?? randomUUID();

  console.log(`[agent] session=${sessionId}`);
  console.log(`[agent] q="${question}"`);

  await ensureTable();
  const result = await ask(question);

  console.log("\n" + "=".repeat(60));
  console.log(`RESPUESTA (${result.iterations} iter, ${result.totalMs}ms):`);
  console.log("=".repeat(60));
  console.log(result.response);

  if (VERBOSE && result.toolCalls.length > 0) {
    console.log("\n" + "-".repeat(60));
    console.log("TOOL CALLS:");
    for (const tc of result.toolCalls) {
      console.log(`  → ${tc.name}(${JSON.stringify(tc.args)})`);
    }
  }

  await saveSession({
    session_id: sessionId,
    // v1.3 H-03: el CLI no pasa por el hook HMAC. Usamos el
    // HMAC_KEY_ID como subject por defecto, alineado con el
    // bootstrap de la UI; si en el futuro se quiere multiusuario
    // en CLI, este punto es donde se lee el subject del entorno.
    user_id: process.env.HMAC_KEY_ID ?? "cli",
    created_at: new Date().toISOString(),
    last_query: question,
    last_response: result.response,
    iterations: result.iterations,
  });

  await closeMcpClient();
  console.log(`\n[agent] session persisted: ${sessionId}`);
}

main().catch((e) => {
  console.error("[agent] fatal:", e);
  process.exit(1);
});