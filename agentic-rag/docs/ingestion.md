# v1.5.0 — Ingestion Pipeline

Pipeline continuo de ingesta para el RAG agentic. Cierra
**SEC-21** (validación de contenido en la ingesta con
cuarentena) y cierra parcialmente **RF-09** (metadata.source en
cada chunk) y **RNF-04** (job con `attempts`, `last_error`,
`processed_at`, `chunk_count`).

Esta versión NO toca Floci S3 events, ACL por documento ni
Bedrock Guardrails — todo eso queda en v1.5.x / v2.0.

## Estado al cierre

- Branch: `feature/ingesta-s3-v1.5.0`.
- Tag: `v1.5.0` (lo crea el release PR).
- Tests: 85 nuevos en `mcp-server/test/ingestion/` (loader,
  chunker, quarantine, embedder, writer, jobs, watcher, e2e).
- Migración: `0001_documents_chunk_id.sql` aplicada.
- Version bump: `mcp-server` 1.4.0 → 1.5.0. `agent` sin cambio.

## Arquitectura

```
   ┌─────────────┐   ┌─────────┐   ┌────────────┐   ┌─────────┐   ┌─────────┐
   │  source     │──▶│ loader  │──▶│ quarantine │──▶│ embedder│──▶│ writer  │
   │ (file path) │   │ (.md/   │   │ (SEC-21)   │   │ (Ollama │   │ (pgvec- │
   │             │   │  .txt)  │   │ length,    │   │  retry) │   │  tor)   │
   └─────────────┘   └─────────┘   │ patterns,  │   └─────────┘   └─────────┘
                                    │ encoding)  │
                                    └────────────┘
                                          │ fail
                                          ▼
                                    ┌─────────────┐
                                    │  jobs table │
                                    │ (DynamoDB)  │
                                    │ status:     │
                                    │  quarantine │
                                    └─────────────┘
```

Cada paso se ejecuta serializado por archivo (un doc a la vez).
El job se persiste en DynamoDB en cada transición para que el
operador pueda inspeccionar y re-procesar manualmente.

## Módulos (`mcp-server/src/ingestion/`)

| Módulo | Responsabilidad |
|---|---|
| `types.ts` | `IngestionJob`, `LoadedDocument`, `ChunkRecord`, `QuarantineReason`. |
| `loader.ts` | Lee `.md` y `.txt` del disco, extrae headings de MD. |
| `chunker.ts` | Divide el doc en chunks (2000 chars / 200 overlap) con chunk_id estable. |
| `quarantine.ts` | SEC-21: rules engine first-match-wins. |
| `embedder.ts` | Ollama embedder con retry (3 intentos, 1s/4s/16s). |
| `writer.ts` | Upsert idempotente en pgvector (ON CONFLICT). |
| `jobs.ts` | State machine + DynamoDB store + in-memory fallback. |
| `pipeline.ts` | Orquestador (`processFile`). |
| `cli.ts` | `npm run ingest -- <path>`. |
| `watcher.ts` | `npm run ingest:watch` (chokidar sobre `/data/ingestion`). |

## Uso

### Levantar el watcher (modo continuo)

```sh
docker compose up -d mcp-server
make ingest-watch
# ahora cualquier .md/.txt en el volumen ingestion-data entra al pipeline
docker compose exec mcp-server wget -qO- http://localhost:11434/api/tags  # sanity ollama
```

Para parar: `Ctrl+C`. Para correr en background: el watcher
sale del `docker compose exec` al recibir SIGTERM — en producción
v1.5.x se ejecutará como sidecar del contenedor `mcp-server`.

### Procesar un archivo puntual

```sh
make ingest FILE=my-document.md
```

Equivalente a:
```sh
docker compose exec -T mcp-server \
  npm run ingest -- /data/ingestion/my-document.md
```

Sale con código 0 (`completed` o `quarantined`) o 1 (`failed`).

### Re-procesar un archivo en cuarentena

v1.5.0 no incluye el comando `npm run ingest:release`. Por
ahora, eliminar el job de la tabla DynamoDB y volver a copiar
el archivo a `/data/ingestion`. v1.5.x añade el comando
formal.

## Reglas de cuarentena (SEC-21)

Evaluadas en orden, first-match-wins:

| Razón | Trigger | Default |
|---|---|---|
| `length_too_large` | `size > 500 KB` | sí |
| `length_too_small` | `size < 100 B` | sí |
| `pattern:<id>` | cuerpo matchea una de las regex SEC-18 (ver `src/security/patterns.ts`) | sí |
| `encoding_suspicious` | control chars > 5% **o** base64-like run > 2 KB | sí |
| `mime_mismatch` | NUL byte o proporción alta de bytes no-printable en `text/*` | sí |

Los rechazos NO entran a pgvector. El job queda con
`status = quarantined` y `quarantine_reason` poblado. El
operador lo revisa en DynamoDB y decide reprocesar o descartar.

## Idempotencia

Cada chunk tiene un `chunk_id = ${source}:${index}` estable.
La tabla `documents` tiene `UNIQUE(source, chunk_id)` que es la
clave del `INSERT ... ON CONFLICT DO UPDATE`. Reprocesar el
mismo archivo reemplaza in-place — no duplica filas.

## Modos de operación

| `JOBS_STORE` | Backend | Cuándo |
|---|---|---|
| `dynamo` (default) | DynamoDB (Floci o AWS) | Producción, dev con credenciales |
| `memory` | In-memory Map | Tests E2E, smoke local sin AWS |

Para tests e2e locales sin AWS:
```sh
JOBS_STORE=memory npm run ingest -- ./some-doc.md
```

## Formatos soportados

v1.5.0: `.md`, `.markdown`, `.txt`.

v1.5.x: PDF, DOCX, HTML (requieren nuevas dependencias y un
parser más robusto — fuera del scope de esta tanda).

## Variables de entorno relevantes

| Var | Default | Descripción |
|---|---|---|
| `INGEST_WATCH_DIR` | `/data/ingestion` | Volumen vigilado por el watcher. |
| `JOBS_STORE` | `dynamo` | `dynamo` o `memory`. |
| `JOBS_TABLE` | `ingestion_jobs` | Tabla DynamoDB (PK: `job_id`). |
| `AWS_REGION` | `us-east-1` | Región para el cliente DynamoDB. |
| `OLLAMA_HOST` | `http://localhost:11434` | Endpoint de Ollama. |
| `EMBED_MODEL` | `nomic-embed-text` | Modelo de embeddings (768 dims). |

## Tabla DynamoDB requerida

Si `JOBS_STORE=dynamo`, la tabla debe existir con:

- Partition key: `job_id` (String)
- Billing: on-demand (pocos jobs por tanda, no vale provisionar)
- Atributos relevantes (no obligatorios en el schema):
  `status`, `source`, `attempts`, `last_error`,
  `quarantine_reason`, `processed_at`, `chunk_count`.

Provisionar con Floci o Terraform (TODO v1.5.x):
```sh
floci dynamodb create-table \
  --table-name ingestion_jobs \
  --attribute-definitions AttributeName=job_id,AttributeType=S \
  --key-schema AttributeName=job_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

## Tests

```sh
cd mcp-server
npm test -- test/ingestion/
```

Suite actual: 85 tests en 8 archivos. Cubre:

- loader (10): MD con/sin headings, MD alias, TXT, vacío,
  extensión no soportada, archivo inexistente, source derivado,
  regex de headings (level cap, fence decision).
- chunker (10): chunking por heading, subdivisión de bloques
  grandes, overlap entre chunks consecutivos, TXT sin headings,
  doc vacío, single-chunk path, pre-heading vacío skipped,
  validación de opciones (maxChars>0, overlap<maxChars,
  overlap=0).
- quarantine (16): las 5 reglas, 5 patrones SEC-18 (it.each),
  extraPatterns config, base64 corto no flagged, NUL byte →
  mime_mismatch, happy path, determinismo, first-match-wins.
- embedder (7): happy path con `embedding` populated, retry
  sobre 5xx, delays respetados en orden, fail tras 3 intentos,
  fail-fast en 4xx, embedding vacío → error.
- writer (10): insert nuevo, lista vacía, re-insert sin
  duplicar, mix nuevo+existente, SQL contract (ON CONFLICT
  presente), drizzle SQL marker, validación pre-DB de embedding,
  propagación de errores con chunk_id.
- jobs (18): state machine completa, transiciones válidas /
  inválidas, quarantine/fail helpers, isValidTransition,
  not_found, get.
- watcher (5): detección de add events, ignore de extensiones
  no matcheadas, surface del módulo, smoke integration.
- e2e (9): happy MD/TXT, vacío (size ficticio), quarantine
  pattern + length, failed en loader/embedder/writer,
  idempotencia entre ejecuciones.

## Decisiones cerradas (del plan original)

| Área | Decisión |
|---|---|
| Localización | `mcp-server/src/ingestion/` |
| Trigger | Local dir + CLI; S3 events → v1.5.x |
| Tests | `mcp-server/test/ingestion/` (convención `agent/test/`) |
| SEC-18 regex | Duplicadas con referencia (`src/security/patterns.ts`) |
| Idempotencia | `chunk_id` UNIQUE por (source, chunk_id) |
| Embedder retry | 3 intentos, 1s/4s/16s |
| Concurrencia | Serial (1 worker) |
| Lifecycle archivo | Dejar tras éxito; CLI `release` → v1.5.x |

## Out of scope (recordatorio)

- PDF / DOCX / HTML parsing
- Floci S3 events / AWS Lambda triggers
- Real AWS S3 + IAM roles (H-07)
- Bedrock Guardrails (SEC-22 layer 2)
- ACL por documento (RF-09 completo)
- Multi-tenant quarantine (un bucket por cliente)
- Streaming ingestion
- Background watcher (v1.5.0 corre en foreground)
- CLI `npm run ingest:release <job_id>` (v1.5.x)