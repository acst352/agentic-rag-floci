import type { FastifyPluginAsync } from "fastify";

// La UI estática la sirve @fastify/static (public/index.html).
// Este plugin queda como placeholder para endpoints UI adicionales
// (e.g. /sessions/:id HTML en v0.4+).
export const uiRoutes: FastifyPluginAsync = async (_app) => {
  // intentionally empty
};