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
