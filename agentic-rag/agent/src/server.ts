import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chatRoutes } from "./routes/chat.js";
import { sessionRoutes } from "./routes/sessions.js";
import { uiRoutes } from "./routes/ui.js";
import { authBootstrapRoutes } from "./routes/auth-bootstrap.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3002);

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "../public");

async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } },
    },
  });

  // v1.2 H-01 (PRD §4, §13): CORS restringido a allowlist explícita.
  // `origin: true` reflejaba cualquier Origin del cliente, lo que junto
  // con la fuga de /api/auth/config hacía al control HMAC decorativo.
  const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3002,http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  await app.register(sensible);
  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    decorateReply: false,
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "agent-api",
    version: "0.2.0",
    uptime: process.uptime(),
  }));

  await app.register(authBootstrapRoutes, { prefix: "/api" });
  await app.register(chatRoutes, { prefix: "/api" });
  await app.register(sessionRoutes, { prefix: "/api" });
  await app.register(uiRoutes);

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info(`agent-api ready on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();