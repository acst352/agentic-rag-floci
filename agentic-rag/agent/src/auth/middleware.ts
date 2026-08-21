import type { FastifyReply, FastifyRequest } from "fastify";
import {
  HMAC_KEY_ID_HEADER,
  HMAC_SIGNATURE_HEADER,
  HMAC_TIMESTAMP_HEADER,
  loadHmacConfigFromEnv,
  verifyRequest,
  type HmacConfig,
} from "./hmac.js";

declare module "fastify" {
  interface FastifyRequest {
    hmac?: {
      keyId: string;
      timestamp: number;
    };
  }
}

export interface HmacMiddlewareOptions {
  config?: HmacConfig;
  enabled?: boolean;
}

export function buildHmacHook(options: HmacMiddlewareOptions = {}) {
  const enabled = options.enabled ?? process.env.HMAC_AUTH_ENABLED !== "false";
  const config = options.config ?? (enabled ? loadHmacConfigFromEnv() : null);

  if (enabled && !config) {
    throw new Error(
      "HMAC middleware enabled but no config provided and env vars are missing",
    );
  }

  return async function hmacAuthHook(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!enabled || !config) return;

    const body = req.body ?? "";
    const bodyString = typeof body === "string" ? body : JSON.stringify(body);

    const decodedPath = req.routeOptions?.url ?? req.url;
    const result = verifyRequest(
      req.headers,
      {
        method: req.method,
        path: decodedPath,
        body: bodyString,
      },
      config,
    );

    if (!result.ok) {
      req.log.warn(
        { reason: result.reason, path: decodedPath, method: req.method },
        "hmac auth rejected",
      );
      reply.header(HMAC_TIMESTAMP_HEADER, HMAC_TIMESTAMP_HEADER);
      reply.header(HMAC_KEY_ID_HEADER, HMAC_KEY_ID_HEADER);
      reply.header(HMAC_SIGNATURE_HEADER, HMAC_SIGNATURE_HEADER);
      return reply.code(401).send({
        error: "unauthorized",
        reason: result.reason,
      });
    }

    req.hmac = {
      keyId: config.keyId,
      timestamp: Number(req.headers[HMAC_TIMESTAMP_HEADER]),
    };
    req.log.debug(
      {
        keyId: config.keyId,
        timestamp: req.hmac.timestamp,
        path: decodedPath,
        method: req.method,
      },
      "hmac auth ok",
    );
  };
}
