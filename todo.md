revisar esto:
Nota técnica encontrada: el contenedor rag-agent-api se reinicia cada ~4 min en tu entorno (probablemente un watchdog externo o healthcheck que falla). Si te pasa connection refused 102, espera 5-10 s y reintenta — el contenedor vuelve solo. No afecta a la demo porque la respuesta la da en el siguiente ciclo.

Si quieres investigar el watchdog: wsl -d Ubuntu -- bash -c "docker logs rag-agent-api --tail 50" muestra los timestamps Server listening cada ~260 s.

Variables de entorno centralizadas
Crea agentic-rag/.env.example con DATABASE_URL, OLLAMA_HOST, MCP_URL, FLOCI_ENDPOINT, LLM_MODEL. Usa dotenv o docker compose --env-file. Hoy están hardcoded en docker-compose.yml.
4. Tests (hoy no hay ninguno)
Unit tests (Vitest): mcp-server tools/searchDocuments.ts (lógica pura), embeddings.ts, agent session/store.ts.
Integration tests: levantar compose con perfil test, ejecutar queries reales contra MCP, verificar SSE.
Contract tests: grabar respuestas de Ollama con nock/msw para tests rápidos y deterministas.
# Añadir a package.json
"test": "vitest run"
"test:watch": "vitest"
"test:coverage": "vitest run --coverage"
5. Observabilidad
pino ya viene con Fastify — activa pretty-print en dev.
Endpoint /metrics Prometheus en ambos servicios (request duration, tokens, iterations).
Structured logs con correlation_id por request para tracear SSE stream → tool call → DB query.
6. DX del agent loop
Cachear respuestas de Ollama deterministas (nomic-embed-text lo es).
/api/chat/debug que devuelva el trace completo (prompt, tool calls, resultados) sin streaming.
Reintentos con backoff en mcpClient.ts cuando el SSE se cae.
7. CI local
pre-commit con tsc --noEmit, eslint, vitest related.
GitHub Actions: lint + typecheck + test contra compose efímero.
8. Pequeños fixes que noté
agent/package.json tiene "typecheck" pero mcp-server/package.json no.
No hay .dockerignore (verificar) — evita copiar node_modules al build.
cli.ts está marcado deprecated en el README; bórralo en v1.1.


- Asume que ejecutas desde WSL con Docker nativo (como en el README).
- make seed usa DATABASE_URL=postgres://rag:rag@localhost:5432/rag — coincide con el README.
- make test requiere haber añadido vitest a los package.json (aún no existe).
- Si tu docker compose es v1 (docker-compose), cambia los docker compose por docker-compose o usa docker compose v2.

agregar esta documentacion a agentic-rag/README.md

---

## Quick start

### Prerrequisitos


- WSL2 Ubuntu con Docker nativo + Node 22 + Yarn (ver README padre).
- `make`: `sudo apt install make`.

### Levantar todo

```bash
cd ~/floci-aws-local/agentic-rag
make bootstrap


```

`make bootstrap` ejecuta en orden: `docker compose up -d --build` → descarga
de modelos Ollama → migración Drizzle → seed con embeddings. Tarda ~3 min
la primera vez (pull de imágenes + modelos).

Abre la UI en <http://localhost:3002>. Verás una interfaz estilo ChatGPT;
escribe una pregunta y observa el streaming de tokens + tool calls en
tiempo real.


---

## Comandos make

| Target | Qué hace |
|---|---|
| `make help` | Lista todos los targets |
| `make bootstrap` | Primera instalación completa (up + modelos + migrate + seed) |
| `make up` | Levanta los 5 servicios |
| `make down` | Para los contenedores (conserva volúmenes) |
| `make restart` | Reinicia los contenedores |
| `make ps` | Estado de los servicios |
| `make logs` | Follow de todos los logs (Ctrl+C para salir) |
| `make logs-<svc>` | Logs de un servicio (ej: `make logs-agent-api`) |
| `make pull-models` | Descarga modelos Ollama (nomic-embed-text, qwen2.5:3b) |
| `make migrate` | Aplica migraciones Drizzle |
| `make seed` | Regenera el seed de embeddings |
| `make dev-infra` | Solo infra (floci + postgres + ollama) |
| `make dev-mcp` | MCP server con hot-reload (`tsx watch`) |
| `make dev-agent` | agent-api con hot-reload (`tsx watch`) |
| `make install` | `yarn install` en ambos paquetes |
| `make typecheck` | `tsc --noEmit` en ambos paquetes |
| `make test` | Vitest en ambos paquetes (cuando se añada) |
| `make status` | ps + healthchecks HTTP de los 4 endpoints |
| `make reset` | ⚠ `down -v` (BORRA volúmenes: postgres, ollama, floci) |
| `make clean` | Borra `dist/` y `node_modules/` |

### Modo dev con hot-reload

Útil cuando editas `mcp-server/src/` o `agent/src/` y no quieres rebuild
de Docker:


```bash

# Terminal 1: solo infra
make dev-infra

# Terminal 2: MCP server (tsx watch)
make dev-mcp

# Terminal 3: agent-api (tsx watch)
make dev-agent
```

---

## Uso de la API directamente



//////////
sugerencias a considerar:

Respuesta corta: Make es excelente para dev local y como punto de entrada único para CI/CD, pero no es IaC. Para producción en la nube, Make debe ser un dispatcher delgado que llama a las herramientas correctas (Terraform, Helm, kubectl, ECR push). No intenta reemplazarlas.
Por qué Make sí funciona para dev- Una sola interfaz (make X) en lugar de memorizar 20 comandos.
- Funciona idéntico en WSL, macOS, Linux y runners de CI.
- Compone bien: make dev-infra puede llamar a docker compose y mañana a kubectl --context=dev.
Por qué Make NO debe orquestar producción
Necesidad en prod	Herramienta real	Por qué Make no
Estado de infra reproducible (drift detection)	Terraform / Pulumi	Make no tiene state
Rollback atómico	Helm / kubectl rollout undo / ECS deploy	Make no modela versiones
Despliegues progresivos (canary, blue/green)	Argo Rollouts, Spinnaker, CodeDeploy	Make es imperativo, no declarativo
Audit trail de quién cambió qué	IaC + Git	make deploy deja poca trazabilidad
Multi-cuenta / multi-región	Terraform workspaces / Spinnaker	Make escala mal
Cómo migrar sin fricción
Make se queda como fachada local. Añades targets que dispatchan:
# Cloud / prod (nuevos targets)
tf-plan:     ## terraform plan en devcd terraform && terraform plan -var-file=dev.tfvars

tf-apply:    ## terraform apply (con confirmación)
	cd terraform && terraform apply -var-file=prod.tfvars

build-image: ## build + push a ECR
	docker build -t $(ECR)/mcp-server:$(SHA) ./mcp-server
	docker push    $(ECR)/mcp-server:$(SHA)

deploy: tf-apply build-image ## pipeline completohelm upgrade --install mcp ./charts/mcp \
 --set image.tag=$(SHA) \
 --wait --atomic```

Y en CI (GitHub Actions):

```yaml
- run: make ci   # = install + typecheck + test + lint
- run: make build-image
- run: make deploy-prod   # solo en main, con aprobación manual
make ci se vuelve la fuente única de verdad de "qué significa shippear este repo". Cambias el Makefile una vez y CI + devs locales usan lo mismo.
Lo que NO debes hacer
- ❌ make deploy-prod que hace SSH al servidor y reinicia systemd.
- ❌ Mezclar configuración de dev y prod en el mismo docker-compose.yml.
- ❌ Targets que muten estado sin confirm (rollback manual cuando falla).
Recomendación concreta para tu proyecto
Hoy tienes local con docker compose y target producción = AWS real. El gap es grande. Plan de transición:
1. Corto plazo (1 semana): añade make ci (lint + typecheck + test) y úsalo en GitHub Actions. El Makefile actual + Vitest te da esto casi gratis.
2. Medio plazo (v2.0.0 según tu roadmap): crea terraform/ con módulos para Bedrock, ECS, RDS pgvector, VPC, VPN. Añade make tf-plan/apply/destroy.
3. Largo plazo: cuando estés en k8s/ECS, el Makefile queda como wrapper sobre helm/kubectl/aws ecs update-service. La interfaz no cambia para ti, solo cambia qué hay debajo.
TL;DR
Make = interfaz humana y de CI. Terraform/Helm/kubectl = motor de producción. Make llama al motor, no lo reemplaza. Si respetas esa separación, la migración a AWS real será cambiar el contenido de unos cuantos targets, no reescribir tu flujo de trabajo.



