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
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const id = randomUUID();
    const now = new Date().toISOString();
    await saveSession({
      session_id: id,
      created_at: now,
      last_query: "",
      last_response: "",
      iterations: 0,
      ...(parsed.data.metadata ? { metadata: parsed.data.metadata as Record<string, unknown> } : {}),
    });
    return reply.code(201).send({ session_id: id, created_at: now });
  });

  app.get("/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await getSession(id);
    if (!session) return reply.notFound(`Session ${id} not found`);
    return session;
  });
};