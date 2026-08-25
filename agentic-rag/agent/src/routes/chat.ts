import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ask, askStream } from "../agent/llm.js";
import { saveSession } from "../session/store.js";
import { assessPrompt } from "../security/inputGuard.js";

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

    // v1.4 H-06 / SEC-18: guardrails de entrada. Cortocircuita
    // intentos obvios de inyección antes de gastar inferencia. El
    // motivo se loguea con identificador (no con el prompt, ver
    // SEC-16) y se devuelve al cliente como 400.
    const guard = assessPrompt(question);
    if (!guard.ok) {
      req.log.warn(
        { reason: guard.reason, q_len: question.length, route: "/chat" },
        "input guard rejected chat prompt (H-06 SEC-18)",
      );
      return reply.code(400).send({
        error: "input_guard",
        reason: guard.reason,
      });
    }

    const safeQuestion = guard.normalized;
    const sessionId = session_id ?? randomUUID();
    // v1.3 H-03 (PRD §4, §13, SEC-03): la sesión queda anclada al
    // subject verificado por el hook HMAC. Si el caller envía un
    // session_id existente, debe pertenecerle; si no, creamos una
    // nueva con su subject como propietario.
    const subject = req.hmac?.subject ?? "";

    req.log.info({ sessionId, q_len: safeQuestion.length }, "chat request");

    const result = await ask(safeQuestion);
    await saveSession({
      session_id: sessionId,
      user_id: subject,
      created_at: new Date().toISOString(),
      last_query: safeQuestion,
      last_response: result.response,
      iterations: result.iterations,
    });

    return { session_id: sessionId, ...result };
  });

  app.get("/chat/stream", async (req, reply) => {
    const q = (req.query as Record<string, string>).q;
    const sessionId = (req.query as Record<string, string>).session_id ?? randomUUID();
    const subject = req.hmac?.subject ?? "";

    if (!q || q.length < 1) {
      return reply.badRequest("Query param 'q' is required");
    }

    // v1.4 H-06 / SEC-18: el mismo guardrail sobre el prompt del
    // usuario, antes de abrir el stream SSE. Si bloquea, devolvemos
    // 400 con el motivo — el stream no llega a establecerse y no
    // hay tokens emitidos.
    const guard = assessPrompt(q);
    if (!guard.ok) {
      req.log.warn(
        { reason: guard.reason, q_len: q.length, route: "/chat/stream" },
        "input guard rejected stream prompt (H-06 SEC-18)",
      );
      return reply.code(400).send({
        error: "input_guard",
        reason: guard.reason,
      });
    }
    const safeQ = guard.normalized;

    req.log.info({ sessionId, q_len: safeQ.length }, "chat stream request");

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let fullResponse = "";
    let iterations = 0;

    try {
      for await (const event of askStream(safeQ)) {
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
              user_id: subject,
              created_at: new Date().toISOString(),
              last_query: safeQ,
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
