# Agentic RAG — Local $0 stack

Simulación local (Windows + WSL2 + Docker) de una arquitectura **Agentic RAG
híbrida** con aislamiento AWS vs On-Premises usando **MCP** (Model Context
Protocol) sobre **Floci** + **Ollama** + **pgvector**.

## Producción objetivo

```
┌─────────────────── AWS (VPC) ───────────────────┐         ┌──────── On-Premises ────────┐
│  Agent (MCP Host) ──► Bedrock (LLM)             │  VPN    │  MCP Server                │
│  DynamoDB (session), S3 (cache)                 │ ◄────►  │       │                    │
└──────────────────────────────────────────────────┘ Tunnel  │       ▼                    │
                                                                  │  pgvector (RAG DB)        │
                                                                  └────────────────────────────┘
```

## Local simulado (este repo)

```
┌──────────── net-aws-sim ────────────┐    ┌────── net-onprem-sim ──────┐
│  floci (4566) — AWS API emulator    │    │  rag-postgres :5432         │
│  agent (MCP Host, en host)          │    │  rag-ollama  :11434         │
│       │   SSE/HTTP                  │    │       ▲                    │
│       ▼                             │    │       │                    │
│  rag-mcp-server ◄───────────────────┼────┼───────┘                    │
│  (gateway: vive en AMBAS redes)     │    │                            │
└─────────────────────────────────────┘    └────────────────────────────┘
```

El **mcp-server** es el único componente en ambas redes → simula la VPN que
expone únicamente el servicio MCP hacia AWS, no la DB directamente. El
**agente nunca habla con Postgres/Ollama**; siempre pasa por MCP.

## Stack

| Capa | Tecnología |
|---|---|
| Orquestación | Docker Compose v2 (en WSL2 Ubuntu) |
| AWS emulator | Floci v1.6.0 (DynamoDB, IAM, etc.) |
| LLM | Ollama + qwen2.5:3b (tool calling nativo) |
| Embeddings | Ollama + nomic-embed-text (768 dims) |
| Vector DB | PostgreSQL 16 + pgvector 0.8.6 |
| MCP | `@modelcontextprotocol/sdk` v1.0.x (SSE transport) |
| Lenguaje | TypeScript / Node 22 |
| ORM | Drizzle ORM + drizzle-kit |

## Estructura

```
agentic-rag/
├── compose/
│   ├── docker-compose.yml          # 4 servicios + 2 redes
│   └── postgres-init/
│       └── 01-pgvector.sql          # CREATE EXTENSION
├── mcp-server/                      # TypeScript, gateway
│   ├── src/
│   │   ├── index.ts                 # Express + SSE bootstrap
│   │   ├── db/{schema,client,migrate}.ts
│   │   ├── embeddings.ts            # Ollama embeddings client
│   │   ├── tools/searchDocuments.ts # MCP tool RAG
│   │   ├── rag/{search,seed}.ts
│   │   └── data/policies.ts         # 10 documentos seed
│   ├── drizzle/                     # migraciones generadas
│   ├── Dockerfile
│   └── package.json
└── agent/                           # TypeScript, MCP host
    ├── src/
    │   ├── index.ts                 # CLI
    │   ├── mcpClient.ts             # SSE client
    │   ├── llm.ts                   # Ollama + tool-calling loop
    │   ├── tools.ts                 # MCP→Ollama adapter
    │   └── session.ts               # DynamoDB (Floci) persistence
    └── package.json
```

## Quick start

### 1. Prerrequisitos (WSL2 Ubuntu con Docker nativo)

```bash
# Node 22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
nvm install 22
```

### 2. Levantar el stack

```bash
cd ~/floci-aws-local/agentic-rag/compose
docker compose up -d

# Pull modelos Ollama (una vez, ~5 min total)
docker exec rag-ollama ollama pull nomic-embed-text
docker exec rag-ollama ollama pull qwen2.5:3b
```

### 3. Build + seed del MCP server

```bash
cd ../mcp-server
yarn install   # npm install --ignore-scripts si hay issues con binarios nativos

# Generar migración Drizzle (solo cuando cambia schema.ts)
./node_modules/.bin/drizzle-kit generate

# Aplicar migración (ejecutar SQL directo vía docker exec; no resuelve
# 'postgres' desde el host):
docker exec -i rag-postgres psql -U rag -d rag < drizzle/0000_*.sql

# Seed: genera embeddings de los 10 documentos
export DATABASE_URL="postgres://rag:rag@localhost:5432/rag"
export OLLAMA_HOST="http://localhost:11434"
./node_modules/.bin/tsx src/rag/seed.ts

# Reconstruir imagen con código real y reiniciar
cd ../compose
docker compose build mcp-server
docker compose up -d mcp-server
```

### 4. Ejecutar el agente

```bash
cd ~/floci-aws-local/agentic-rag/agent
yarn install

export OLLAMA_HOST="http://localhost:11434"
export MCP_URL="http://localhost:3001/sse"
export FLOCI_ENDPOINT="http://localhost:4566"
export LLM_MODEL="qwen2.5:3b"

node --import tsx src/index.ts -- "¿Cuál es la política de vacaciones?" --verbose
```

Salida esperada:

```
[agent] session=9262bcbf-...
[agent] q="¿Cuál es la política de vacaciones?"
[llm] iter 1 56224ms
[tool] search_documents({"query":"política de vacaciones","top_k":1})
[tool] search_documents → {... "score":0.59, "source":"hr/politica-vacaciones.md"...}
[llm] iter 2 31800ms

============================================================
RESPUESTA (2 iter, 94801ms):
============================================================
La política de vacaciones indica que todos los empleados tienen derecho a 22 días laborables de vacaciones al año...

[agent] session persisted: 9262bcbf-...
```

## Aislamiento de redes (simulación de VPN)

Tests verificados en `compose/` (ver sección Troubleshooting):

| Desde → Hacia | postgres:5432 | ollama:11434 | mcp-server:3001 | floci:4566 |
|---|---|---|---|---|
| **net-aws-sim** (agente, floci) | ❌ bloqueado | ❌ bloqueado | ✅ alcanzable | ✅ self |
| **net-onprem-sim** (postgres) | ✅ self | ✅ self | ✅ alcanzable | ❌ bloqueado |

El agente en `net-aws-sim` **solo puede llegar a mcp-server**, nunca a la DB
directamente. Esto emula el patrón producción: la VPN expone el servicio MCP,
no la base de datos on-prem.

## Persistencia de sesiones (DynamoDB via Floci)

Cada query del agente se guarda en la tabla `agent_sessions` en DynamoDB
local de Floci. Para inspeccionar:

```bash
# Desde PowerShell (con AWS CLI instalado)
$env:AWS_ACCESS_KEY_ID = "floci"
$env:AWS_SECRET_ACCESS_KEY = "floci"
$env:AWS_DEFAULT_REGION = "us-east-1"
$env:AWS_ENDPOINT_URL = "http://localhost:4566"
aws dynamodb scan --table-name agent_sessions
```

La tabla se crea automáticamente al primer run del agente. Floci persiste
el estado en el volumen `agentic-rag_floci-data`.

## Comandos útiles

```bash
# Ver estado de los 4 servicios
docker compose -f compose/docker-compose.yml ps

# Logs del MCP server
docker logs rag-mcp-server -f

# Re-seed (limpia + re-inserts)
docker exec -i rag-postgres psql -U rag -d rag -c "TRUNCATE documents;"
cd mcp-server && ./node_modules/.bin/tsx src/rag/seed.ts

# Apagar todo
docker compose -f compose/docker-compose.yml down

# Apagar Y borrar volúmenes (reset total)
docker compose -f compose/docker-compose.yml down -v
```

## Troubleshooting

### npm install falla con `ruta UNC` en WSL2

Síntoma: `command C:\WINDOWS\system32\cmd.exe /d /s /c node install.js`.

Causa: binarios nativos (esbuild) instalados para Windows siendo ejecutados
en WSL2 Linux.

Fix:
```bash
rm -rf node_modules package-lock.json
yarn install    # yarn maneja binarios por plataforma mejor que npm
```

### Ollama tarda mucho en la primera query (60s+)

Causa: el modelo `qwen2.5:3b` (~1.9 GB) se carga bajo demanda en CPU.

Fix: query "warmup" al iniciar o usar `OLLAMA_KEEP_ALIVE=24h`.

### WSL2 se apaga y los contenedores caen

Síntoma: después de unos minutos sin actividad, los puertos dejan de
responder desde Windows.

Causa: WSL2 cierra la VM cuando no hay sesiones activas; los contenedores
se reinician por la policy `restart: unless-stopped` que está aplicada.

Fix: dejar una sesión WSL2 abierta, o configurar `/etc/wsl.conf` con
`[boot] systemd=true` para servicios persistentes.

### Floci no persiste tablas DynamoDB

Síntoma: tabla `agent_sessions` desaparece tras reinicio de Floci.

Causa: el volumen `agentic-rag_floci-data` SÍ persiste; pero Floci DynamoDB
puede demorar en inicializar tras el restart.

Fix: el `ensureTable()` del agente re-crea la tabla si falta. Esperar ~3s
después del primer Put.

### SSE timeout con qwen2.5:3b

Síntoma: el modelo tarda 60s+ por iteración y el EventSource da timeout.

Causa: generación lenta en CPU sin GPU.

Fix: usar modelo más pequeño (`qwen2.5:1.5b`) o tener paciencia
(~50s por iteración en CPU moderna).

## Próximos pasos

- [ ] Hacer al agente un contenedor en `net-aws-sim` (más fiel a prod).
- [x] **v1.1.0** — Autenticación HMAC en `GET /api/chat/stream`. Ver [docs/hmac-auth.md](docs/hmac-auth.md).
- [x] **v1.2.0** — Contención HMAC (PRD §13). Cierra **H-01, H-02, H-04, H-05**: hook global `onRequest` con allowlist, CORS allowlist, canonical path con query string ordenada, nonce único por request (`X-Floci-Nonce`), ventana 60 s. `/api/auth/config` bloqueado en producción. Ver [docs/hmac-auth.md](docs/hmac-auth.md).
- [x] **v1.2.1** — Hardening de contenedores (PRD §13). Contenedores corren como `node` no-root, el puerto `3001` (mcp-server) deja de publicarse en el host, y el prompt del usuario ya no aparece en el log de aplicación (SEC-16, queda solo `q_len` como metadato). El script `mcp-server/test-client.mjs` debe ejecutarse ahora dentro del contenedor: `docker compose exec mcp-server node dist/test-client.mjs`.
- [x] **v1.3.0** — Cierre H-03 IDOR (PRD §13). Cada request lleva a un quinto header (`X-Floci-Subject`) firmado en la cadena canónica; las sesiones pertenecen a un `user_id` y `GET /api/sessions/:id` devuelve 404 si la sesión es de otro subject. La respuesta 404 es indistinguible del caso "no existe" para no facilitar enumeración. La identidad por defecto en dev es el `HMAC_KEY_ID`; en producción será el `sub` del OIDC. Ver [docs/hmac-auth.md](docs/hmac-auth.md).
- [x] **v1.4.0** — Defensa contra prompt injection (PRD §4 H-06). Cierra SEC-18 (input guardrails: regex + límite de longitud 4000), SEC-19 (delimitadores `<<CONTEXT_*>>` en chunks recuperados + system prompt reforzado), SEC-20 (verificación de fundamentación: si la respuesta no cita ninguna fuente declarada por la herramienta, se sustituye por abstención RF-02) y SEC-24 (banco de pruebas adversarias en CI con 21 casos que mockean Ollama y mcpClient). SEC-21 (validación de ingesta con cuarentena) queda fuera: no hay pipeline de ingesta todavía.
- [x] **v1.5.0** — Pipeline de ingesta con cuarentena (PRD §15). Cierra SEC-21: pipeline `load → chunk → quarantine → embed → upsert` en `mcp-server/src/ingestion/`. Volumen `ingestion-data` montado en `/data/ingestion`. CLI `npm run ingest -- <path>` y watcher `npm run ingest:watch`. La cuarentena evalúa length (100B–500KB), las regex SEC-18, control-char ratio y NUL byte; los rechazos se persisten en DynamoDB con `quarantine_reason` estable. RF-09 parcial: el chunk persiste con `metadata.source`. RNF-04 parcial: job con `attempts`, `last_error`, `processed_at`, `chunk_count`. Migración `0001_documents_chunk_id.sql` añade `chunk_id` + `UNIQUE(source, chunk_id)` para upsert idempotente. 85 tests nuevos en `mcp-server/test/ingestion/`. Ver [docs/ingestion.md](docs/ingestion.md).
- [ ] Sustituir Ollama por Bedrock en producción (cambiar `OLLAMA_HOST` →
      `BEDROCK_ENDPOINT`, swap del cliente).
- [ ] Pipeline de ingesta continuo (S3 → embeddings → pgvector).
- [ ] CI/CD: Floci + Ollama en GitHub Actions para tests E2E.

### HMAC auth quick reference

Todos los endpoints `/api` exigen cinco headers (v1.3 hook global):

```
X-Floci-Timestamp: <epoch seconds>
X-Floci-Key-Id:    <HMAC_KEY_ID>
X-Floci-Nonce:     <uuid v4 único por request>
X-Floci-Subject:   <identidad lógica del llamante, p.ej. HMAC_KEY_ID en dev>
X-Floci-Signature: hex(HMAC_SHA256(HMAC_SECRET, "<ts>\n<METHOD>\n<path?sorted-query>\n<sha256(body)>\n<subject>"))
```

`path?sorted-query` es la URL solicitada con los parámetros de query
ordenados alfabéticamente por clave. El prompt del usuario (`?q=...`)
entra así en la firma.

Configurar el secreto antes de `make up`:

```bash
export HMAC_SECRET=$(openssl rand -hex 32)
export HMAC_KEY_ID=local-dev
export CORS_ALLOWED_ORIGINS=http://localhost:3002
make up
```

La UI (`public/script.js`) firma automáticamente; no hay nada que cambiar
en el navegador. Para integradores externos hay ejemplos de `curl` y un
helper de Python en `docs/hmac-auth.md`.

## Referencias

- Floci: <https://floci.io>
- MCP SDK: <https://github.com/modelcontextprotocol/typescript-sdk>
- Ollama: <https://ollama.com>
- pgvector: <https://github.com/pgvector/pgvector>
- qwen2.5 tool calling: <https://qwen.readthedocs.io>