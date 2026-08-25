import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ask, askStream } from "../agent/llm.js";
import { saveSession, getSession } from "../session/store.js";

const ChatBody = z.object({
  question: z.string().min(1),
  session_id: z.string().optional(),
});

export const chatRoutes: FastifyPluginAsync = async (app) => {
  // v1.2 H-02 (PRD §4, §13): el hook HMAC se aplica como addHook
  // global onRequest en server.ts. Esta ruta ya no necesita
  // configurar preHandler propio.

  app.post("/chat", async (req, reply) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.message);
    }
    const { question, session_id } = parsed.data;
    const sessionId = session_id ?? randomUUID();

    req.log.info({ sessionId, q_len: question.length }, "chat request");

    const result = await ask(question);
    await saveSession({
      session_id: sessionId,
      created_at: new Date().toISOString(),
      last_query: question,
      last_response: result.response,
      iterations: result.iterations,
    });

    return { session_id: sessionId, ...result };
  });

  app.get("/chat/stream", async (req, reply) => {
    const q = (req.query as Record<string, string>).q;
    const sessionId = (req.query as Record<string, string>).session_id ?? randomUUID();

    if (!q || q.length < 1) {
      return reply.badRequest("Query param 'q' is required");
    }

    req.log.info({ sessionId, q_len: q.length }, "chat stream request");

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let fullResponse = "";
    let iterations = 0;

    try {
      for await (const event of askStream(q)) {
        switch (event.type) {
          case "token":
            fullResponse += event.token;
            reply.raw.write(`event: token\ndata: ${JSON.stringify({ token: event.token })}\n\n`);
            break;
          case "tool_call":
            reply.raw.write(
              `event: tool_call\ndata: ${JSON.stringify({ name: event.name, args: event.args })}\n\n`,
            );
            break;
          case "tool_result":
            reply.raw.write(
              `event: tool_result\ndata: ${JSON.stringify({ name: event.name, result: event.result, ms: event.ms })}\n\n`,
            );
            break;
          case "done":
            iterations = event.iterations;
            await saveSession({
              session_id: sessionId,
              created_at: new Date().toISOString(),
              last_query: q,
              last_response: fullResponse,
              iterations,
            });
            reply.raw.write(
              `event: done\ndata: ${JSON.stringify({ session_id: sessionId, iterations, totalMs: event.totalMs })}\n\n`,
            );
            break;
        }
      }
    } catch (err) {
      req.log.error({ err }, "stream error");
      reply.raw.write(
        `event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`,
      );
    }

    reply.raw.end();
  });
};
