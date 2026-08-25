import type { FastifyPluginAsync } from "fastify";
import { loadHmacConfigFromEnv } from "../auth/hmac.js";

interface AuthBootstrapResponse {
  keyId: string;
  secret: string;
  windowSeconds: number;
  enabled: boolean;
}

export const authBootstrapRoutes: FastifyPluginAsync = async (app) => {
  let cached: AuthBootstrapResponse | null = null;

  app.get("/auth/config", async (req, reply) => {
    // v1.2 H-01 (PRD §4, §13): el secreto HMAC nunca debe salir del
    // servidor en un entorno expuesto. Bloqueamos con 404 cualquier
    // arranque de producción; la demo local sigue funcionando porque
    // NODE_ENV se deja sin asignar o !== 'production' por defecto.
    // Sustitución completa por POST /api/auth/token con firma
    // server-side: planificada para v1.3.x.
    if (process.env.NODE_ENV === "production") {
      req.log.warn(
        { ip: req.ip },
        "blocked auth bootstrap in production (H-01 containment)",
      );
      return reply.code(404).send({ error: "not_found" });
    }

    if (process.env.HMAC_AUTH_ENABLED === "false") {
      return reply.code(204).send();
    }

    if (!cached) {
      try {
        const cfg = loadHmacConfigFromEnv();
        cached = {
          keyId: cfg.keyId,
          secret: cfg.secret,
          windowSeconds: cfg.windowSeconds ?? 300,
          enabled: true,
        };
      } catch (err) {
        req.log.error({ err }, "HMAC bootstrap failed");
        return reply.code(503).send({
          error: "hmac_not_configured",
          message: (err as Error).message,
        });
      }
    }

    reply.header("Cache-Control", "no-store");
    return cached;
  });
};
