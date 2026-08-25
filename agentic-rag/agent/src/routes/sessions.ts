import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ensureTable, getSession, saveSession } from "../session/store.js";

const CreateBody = z.object({
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  await ensureTable();

  app.post("/sessions", async (req, reply) => {
    // v1.3 H-03 (PRD §4, §13, SEC-03): el subject del hook HMAC es
    // el propietario de la sesión. Si el hook fallase (no debería,
    // porque /api está protegido por el hook global desde H-02),
    // devolvemos 401 en lugar de crear una sesión anónima.
    const subject = req.hmac?.subject;
    if (!subject) {
      return reply.code(401).send({ error: "unauthorized", reason: "missing_subject" });
    }

    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const id = randomUUID();
    const now = new Date().toISOString();
    await saveSession({
      session_id: id,
      user_id: subject,
      created_at: now,
      last_query: "",
      last_response: "",
      iterations: 0,
      ...(parsed.data.metadata ? { metadata: parsed.data.metadata as Record<string, unknown> } : {}),
    });
    return reply.code(201).send({ session_id: id, created_at: now });
  });

  app.get("/sessions/:id", async (req, reply) => {
    const subject = req.hmac?.subject;
    if (!subject) {
      return reply.code(401).send({ error: "unauthorized", reason: "missing_subject" });
    }
    const { id } = req.params as { id: string };
    // v1.3 H-03: getSession devuelve null tanto si la sesión no
    // existe como si pertenece a otro subject. La respuesta 404 es
    // indistinguible en ambos casos para no facilitar la
    // enumeración de session_id ajenos.
    const session = await getSession(id, subject);
    if (!session) return reply.notFound(`Session ${id} not found`);
    return session;
  });
};