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
  /**
   * v1.2 H-02 (PRD §4, §13): rutas exentas de HMAC.
   * Coincidencia exacta (`path`) o por prefijo (`pathPrefix`).
   * Se aplica ANTES de la verificación HMAC. La comparación de path
   * ignora la query string.
   */
  allowlist?: Array<{ method?: string; path?: string; pathPrefix?: string }>;
}

function isAllowlisted(
  req: FastifyRequest,
  allowlist: HmacMiddlewareOptions["allowlist"],
): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const method = req.method.toUpperCase();
  const pathOnly = req.url.split("?")[0];
  for (const rule of allowlist) {
    if (rule.method && rule.method.toUpperCase() !== method) continue;
    if (rule.path && pathOnly !== rule.path) continue;
    if (rule.pathPrefix && !pathOnly.startsWith(rule.pathPrefix)) continue;
    return true;
  }
  return false;
}

// Exportado para tests unitarios sin levantar Fastify.
export const _isAllowlisted = isAllowlisted;

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
    if (isAllowlisted(req, options.allowlist)) return;

    const body = req.body ?? "";
    const bodyString = typeof body === "string" ? body : JSON.stringify(body);

    // Sin canonicación todavía (eso entra en H-04). Aquí se firma tal
    // cual la URL llega; cliente y servidor deben coincidir exactamente.
    const result = verifyRequest(
      req.headers,
      {
        method: req.method,
        path: req.url,
        body: bodyString,
      },
      config,
    );

    if (!result.ok) {
      req.log.warn(
        { reason: result.reason, path: req.url, method: req.method },
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
        path: req.url,
        method: req.method,
      },
      "hmac auth ok",
    );
  };
}
