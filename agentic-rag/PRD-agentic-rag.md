# PRD — Agentic RAG Corporativo sobre AWS

| Campo | Valor |
|---|---|
| **Producto** | Agentic RAG — Asistente corporativo sobre base de conocimiento interna |
| **Versión del documento** | 1.0 |
| **Fecha** | 24 de agosto de 2026 |
| **Autor** | Análisis de arquitectura y ciberseguridad |
| **Base analizada** | `agentic-rag` v1.1.0 (commit local, `C:\Users\Usuario\Desktop\agentic-rag`) |
| **Estado** | Borrador para revisión de Arquitectura, Seguridad y Producto |
| **Marco de referencia** | AWS Well-Architected Framework (6 pilares) + Generative AI Lens + Responsible AI Lens + OWASP Top 10 for LLM Applications 2025 |

---

## 1. Resumen ejecutivo

El repositorio `agentic-rag` contiene una **simulación local funcional** de una arquitectura RAG agéntica híbrida AWS ↔ On-Premises. Es un MVP técnicamente sólido en su diseño de aislamiento: el agente nunca habla directamente con la base vectorial, siempre pasa por un gateway MCP (Model Context Protocol) que emula el único servicio expuesto a través de la VPN. Ese patrón es correcto y debe conservarse.

Sin embargo, **el sistema no es apto para producción en su estado actual**. El análisis identificó **6 hallazgos críticos o altos** que invalidan el modelo de autenticación implementado, más brechas estructurales en gobierno de datos, defensa contra prompt injection y control de costes de inferencia.

El hallazgo de mayor severidad es que el endpoint `GET /api/auth/config` **entrega el secreto HMAC en claro a cualquier cliente HTTP**, sin autenticación previa y con CORS abierto a cualquier origen. Esto convierte la firma HMAC en un control decorativo: cualquiera que pueda alcanzar el puerto 3002 puede obtener el secreto y firmar peticiones válidas. El propio `docs/hmac-auth.md` lo reconoce como deuda planificada para v1.3.x; este PRD la eleva a bloqueante de release.

Este documento define **qué debe construirse** para llevar el prototipo a un servicio de producción en AWS: alcance funcional, personas, historias de usuario con criterios de aceptación, requisitos no funcionales, un conjunto de requisitos de seguridad trazables a los hallazgos, la arquitectura objetivo y un roadmap en cuatro releases.

### Recomendación

Congelar nuevas funcionalidades hasta cerrar los hallazgos H-01 a H-06. El esfuerzo estimado del release de seguridad (v2.0) es de 4-6 semanas de un equipo de 2 personas, y es prerrequisito para exponer el servicio a cualquier usuario real, incluso en piloto interno.

---

## 2. Contexto y planteamiento del problema

### 2.1 El problema de negocio

El conocimiento corporativo (políticas de RR.HH., seguridad, finanzas, ingeniería, legal) vive disperso en portales, wikis y documentos. Los empleados no encuentran respuestas, o encuentran versiones desactualizadas, y el coste recae sobre los equipos dueños de cada política, que responden las mismas preguntas repetidamente.

Un buscador léxico no resuelve el problema: los empleados preguntan en lenguaje natural ("¿me puedo tomar los días de vacaciones del año pasado en marzo?") y la respuesta requiere localizar el fragmento relevante, interpretarlo y citarlo.

### 2.2 Por qué agéntico y no RAG clásico

La implementación actual ya toma esta decisión: el LLM decide **si** consultar la base de conocimiento y **con qué consulta**, en lugar de recuperar siempre con el texto literal del usuario. Esto permite reformular la pregunta, encadenar búsquedas y responder sin búsqueda cuando no hace falta. El bucle está acotado a 5 iteraciones (`MAX_ITERATIONS` en `agent/src/agent/llm.ts`).

El coste de esa decisión es un aumento de la superficie de ataque: cada iteración reintroduce contenido recuperado en el contexto del modelo, y ese contenido puede contener instrucciones (OWASP LLM01 — Prompt Injection indirecta). El diseño de seguridad debe partir de ahí.

### 2.3 La restricción de residencia de datos

El diseño híbrido no es accidental. La base vectorial y los documentos fuente permanecen on-premises; solo el servicio MCP se expone hacia AWS a través del túnel. Este PRD asume que esa restricción es un requisito de negocio no negociable y la trata como tal.

---

## 3. Análisis del sistema actual

### 3.1 Inventario de componentes

| Componente | Tecnología | Puerto | Red | Equivalente objetivo en AWS |
|---|---|---|---|---|
| `agent-api` | Fastify 5, Node 22, TypeScript | 3002 | ambas | ECS Fargate / Lambda |
| `mcp-server` | Express 4 + MCP SDK (SSE) | 3001 | ambas (gateway) | ECS Fargate on-prem o en VPC |
| `rag-postgres` | PostgreSQL 16 + pgvector 0.8.6 | 5432 | on-prem | RDS PostgreSQL / on-prem |
| `rag-ollama` | Ollama (`qwen2.5:3b`, `nomic-embed-text`) | 11434 | on-prem | Amazon Bedrock |
| `floci` | Emulador de APIs AWS (DynamoDB) | 4566 | aws-sim | Amazon DynamoDB |

Redes Docker: `net-aws-sim` y `net-onprem-sim`. `mcp-server` y `agent-api` viven en ambas; `postgres` y `ollama` solo en la red on-prem. El aislamiento está verificado en el README mediante una matriz de alcanzabilidad.

### 3.2 Flujo de una consulta

```
Browser  ──GET /api/auth/config──────────────►  agent-api      [1] obtiene keyId + SECRETO
Browser  ──GET /api/chat/stream (HMAC, SSE)──►  agent-api      [2] firma y abre stream
agent-api ──chat + tools────────────────────►  Ollama          [3] tool-calling loop (máx. 5 iter)
agent-api ──tools/call search_documents─────►  mcp-server      [4] MCP sobre SSE
mcp-server ──POST /api/embeddings───────────►  Ollama          [5] embedding de la consulta
mcp-server ──SELECT ... <=> vector──────────►  pgvector        [6] top-K por distancia coseno
mcp-server ──resultado JSON─────────────────►  agent-api       [7] se reinyecta en el contexto
agent-api ──PutItem agent_sessions──────────►  DynamoDB/Floci  [8] persiste query + respuesta
Browser  ◄──eventos SSE (token/tool_*/done)──  agent-api
```

### 3.3 Superficie HTTP expuesta

| Método | Ruta | Autenticación | Observación |
|---|---|---|---|
| `GET` | `/health` | **ninguna** | Expone versión del servicio |
| `GET` | `/api/auth/config` | **ninguna** | **Devuelve el secreto HMAC en claro** |
| `POST` | `/api/chat` | **ninguna** | Ejecuta el bucle completo del agente |
| `GET` | `/api/chat/stream` | HMAC | Único endpoint protegido |
| `POST` | `/api/sessions` | **ninguna** | Crea sesión |
| `GET` | `/api/sessions/:id` | **ninguna** | Devuelve consulta y respuesta completas |
| `GET` | `/*` | ninguna | UI estática (`@fastify/static`) |
| `GET` | `/sse` (mcp-server) | **ninguna** | Publicado en `0.0.0.0:3001` |
| `POST` | `/messages` (mcp-server) | **ninguna** | Publicado en `0.0.0.0:3001` |

### 3.4 Modelo de datos actual

**pgvector — tabla `documents`**

```sql
id        serial PRIMARY KEY
source    text NOT NULL          -- ej. "hr/politica-vacaciones.md"
content   text NOT NULL          -- documento COMPLETO, sin chunking
embedding vector(768) NOT NULL   -- nomic-embed-text, sin índice
```

No hay índice `hnsw` ni `ivfflat`, ni columnas de tenant, clasificación, versión o fecha de vigencia. El seed carga 10 documentos completos como un vector cada uno.

**DynamoDB — tabla `agent_sessions`**

```
PK: session_id (S)
   created_at, last_query, last_response, iterations
```

Solo guarda el último turno. No hay TTL, ni cifrado gestionado por el cliente, ni identidad de usuario asociada.

### 3.5 Cobertura de pruebas

22 pruebas unitarias, todas sobre el módulo HMAC (`agent/test/auth/hmac.test.ts`): camino feliz, expiración de ventana, mutación de cuerpo/ruta/método, key-id incorrecto, firmas mal formadas, insensibilidad a mayúsculas en cabeceras. **No existen pruebas** del bucle del agente, de la calidad del retrieval, ni de seguridad de extremo a extremo.

---

## 4. Evaluación de seguridad

### 4.1 Hallazgos priorizados

---

#### H-01 — CRÍTICO — El secreto HMAC se sirve al navegador sin autenticación

**Ubicación:** `agent/src/routes/auth-bootstrap.ts`

```typescript
cached = {
  keyId: cfg.keyId,
  secret: cfg.secret,        // ← el secreto compartido, en claro
  windowSeconds: cfg.windowSeconds ?? 300,
  enabled: true,
};
```

`GET /api/auth/config` no exige credencial alguna. Cualquier cliente que alcance el puerto 3002 obtiene el secreto y puede firmar peticiones indefinidamente. El control HMAC queda anulado en su totalidad.

**Agravante:** `server.ts` registra CORS con `{ origin: true }`, que refleja el `Origin` de la petición. Cualquier página web que la víctima visite puede hacer `fetch('http://.../api/auth/config')` y exfiltrar el secreto.

**Impacto:** Bypass completo de autenticación. Acceso no autorizado a la base de conocimiento corporativa y a las sesiones de otros usuarios.

**OWASP:** LLM02 (Sensitive Information Disclosure). **CWE-522** (Insufficiently Protected Credentials).

---

#### H-02 — CRÍTICO — La autenticación cubre un solo endpoint de seis

**Ubicación:** `agent/src/routes/chat.ts` — el hook `buildHmacHook()` se aplica únicamente a `GET /chat/stream`.

`POST /api/chat` ejecuta exactamente el mismo bucle del agente (`ask()`), con acceso completo al RAG, y no requiere firma. El control se elude sin necesidad de conocer el secreto.

`GET /api/sessions/:id` devuelve `last_query` y `last_response` completos sin autenticación (ver H-03).

**Impacto:** El control implementado es irrelevante mientras exista una ruta equivalente sin protección.

**OWASP:** LLM10 (Unbounded Consumption) por la vía de `/api/chat`.

---

#### H-03 — ALTO — Referencia directa a objeto insegura en las sesiones

**Ubicación:** `agent/src/routes/sessions.ts`

```typescript
app.get("/sessions/:id", async (req, reply) => {
  const session = await getSession(id);   // sin authn ni authz
  return session;
});
```

No existe concepto de usuario ni de propiedad de la sesión. El `session_id` es un UUIDv4 (imposible de adivinar por fuerza bruta), pero se filtra de forma rutinaria: aparece en la URL del cliente, en los logs (`req.log.info({ sessionId, question })`) y en el evento SSE `done`. Quien lo obtenga lee la pregunta y la respuesta íntegras.

**Impacto:** Divulgación de consultas de otros empleados, que pueden contener datos personales o información sensible de negocio.

**OWASP:** LLM02. **CWE-639** (Authorization Bypass Through User-Controlled Key).

---

#### H-04 — ALTO — La cadena canónica no incluye la query string

**Ubicación:** `agent/src/auth/middleware.ts`

```typescript
const decodedPath = req.routeOptions?.url ?? req.url;
```

En Fastify v5, `req.routeOptions.url` devuelve la **plantilla** de la ruta (`/api/chat/stream`), no la URL solicitada. El parámetro `q` — que es el prompt completo del usuario — queda fuera de la firma. El ejemplo de `curl` en `docs/hmac-auth.md` confirma el comportamiento: firma `PATH_='/api/chat/stream'` y envía `QUERY` por separado.

**Consecuencia:** una firma capturada es válida para **cualquier** pregunta durante toda la ventana temporal. Un proxy o intermediario puede sustituir el prompt sin invalidar la firma.

**Impacto:** La propiedad de integridad que justifica elegir HMAC sobre un bearer token no se cumple para el único endpoint protegido.

**CWE-345** (Insufficient Verification of Data Authenticity).

---

#### H-05 — ALTO — Sin protección real contra replay

**Ubicación:** `agent/src/auth/hmac.ts` — validación por ventana temporal de ±300 s, sin almacén de nonces.

Una firma capturada se puede reutilizar un número ilimitado de veces durante 5 minutos. Combinado con H-04, se puede reutilizar además con cualquier pregunta. El documento presenta la ventana temporal como equivalente funcional a un nonce store; no lo es — acota la duración del ataque, no lo impide.

**Impacto:** Reproducción de peticiones autenticadas. Amplificación de coste de inferencia.

---

#### H-06 — ALTO — Sin defensa contra prompt injection indirecta

**Ubicación:** `mcp-server/src/tools/searchDocuments.ts` → `agent/src/agent/llm.ts`

El resultado de `search_documents` se reinyecta en el contexto del modelo como `{ role: "tool", content: result }`, con el `excerpt` del documento en crudo. No hay:

- delimitación ni marcado del contenido recuperado como datos no confiables,
- validación de la salida del modelo antes de devolverla al navegador,
- guardrails de entrada o salida (Bedrock Guardrails o equivalente),
- verificación de que la respuesta esté fundamentada en las fuentes recuperadas.

El *system prompt* instruye "cita SIEMPRE la fuente", pero nada comprueba que lo haga. Un documento envenenado en la ingesta — el pipeline futuro leerá de S3 y Confluence según el README — controla el comportamiento del agente para todos los usuarios.

**Impacto:** Manipulación del asistente, exfiltración de contexto, difusión de desinformación con apariencia corporativa.

**OWASP:** LLM01 (Prompt Injection), LLM04 (Data and Model Poisoning), LLM05 (Improper Output Handling), LLM09 (Misinformation).

---

#### H-07 — MEDIO-ALTO — Credenciales embebidas en el código y en la configuración

| Ubicación | Credencial |
|---|---|
| `agent/src/session/store.ts` | `{ accessKeyId: "floci", secretAccessKey: "floci" }` — literal en el código |
| `compose/docker-compose.yml` | `POSTGRES_PASSWORD=rag`, `DATABASE_URL=postgres://rag:rag@postgres:5432/rag` |
| `compose/.env` | `HMAC_SECRET` en texto plano en el sistema de ficheros |

No hay integración con AWS Secrets Manager ni SSM Parameter Store, ni uso de roles IAM. La rotación multi-clave está documentada como pendiente para v2.x.

**OWASP:** LLM03 (Supply Chain). **CWE-798** (Use of Hard-coded Credentials).

---

#### H-08 — MEDIO-ALTO — El servidor MCP mantiene un único transport global

**Ubicación:** `mcp-server/src/index.ts`

```typescript
let transport: SSEServerTransport | null = null;

app.get("/sse", async (_req, res) => {
  transport = new SSEServerTransport("/messages", res);   // sobrescribe el anterior
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  await transport.handlePostMessage(req, res, req.body);  // enruta al último cliente
});
```

Con dos clientes concurrentes, el segundo desplaza al primero. Los mensajes de cualquier cliente se enrutan al transport del último conectado. Es simultáneamente un fallo de aislamiento entre sesiones y un vector de denegación de servicio: una conexión maliciosa a `/sse` desconecta al agente legítimo.

Además, ni `/sse` ni `/messages` exigen autenticación, y el puerto 3001 está publicado en el host (`ports: - "3001:3001"`), lo que rompe el propio principio de aislamiento que el diseño defiende.

**OWASP:** LLM06 (Excessive Agency).

---

#### H-09 — MEDIO — Sin TLS en ningún tramo

Todas las comunicaciones son HTTP en claro: navegador ↔ agent-api, agent-api ↔ mcp-server, mcp-server ↔ postgres y ↔ ollama. El secreto HMAC de H-01 viaja sin cifrar. En el diagrama de arquitectura el tramo del navegador se etiqueta "HTTPS", pero el código escucha en HTTP plano.

---

#### H-10 — MEDIO — Sin límites de consumo

No hay rate limiting, ni cuotas por usuario, ni límite de longitud del prompt (`q` solo se valida con `q.length >= 1`), ni presupuesto de tokens. `MAX_ITERATIONS = 5` limita una petición individual, no el volumen agregado.

En el destino de producción el LLM es Amazon Bedrock, facturado por token. Un bucle de peticiones sin control se traduce directamente en coste.

**OWASP:** LLM10 (Unbounded Consumption).

---

#### H-11 — MEDIO — Prompts y respuestas registrados y persistidos sin gobierno

`req.log.info({ sessionId, question })` escribe la pregunta completa en el log. `saveSession()` persiste `last_query` y `last_response` en DynamoDB sin TTL, sin clasificación de sensibilidad, sin detección de PII y sin cifrado con clave gestionada por el cliente.

Un empleado que pregunte "¿la baja por el tratamiento de mi hija cuenta como días de asuntos propios?" deja datos de categoría especial (RGPD art. 9) en logs y en una tabla sin política de retención.

**OWASP:** LLM02.

---

#### H-12 — MEDIO — Endurecimiento de contenedores ausente

Ninguno de los dos `Dockerfile` declara `USER`; ambos procesos corren como root. No hay `read_only`, `cap_drop`, `no-new-privileges` ni límites de recursos en `docker-compose.yml`.

**Agravante independiente:** el servicio `floci` monta `/var/run/docker.sock` en el contenedor. Un compromiso de ese contenedor equivale a control total del host Docker. Aceptable para un emulador local, inaceptable si el patrón se replica en cualquier entorno compartido.

---

#### H-13 — BAJO — El adaptador de esquema descarta las restricciones de validación

**Ubicación:** `agent/src/agent/tools.ts` — `sanitizeSchema()` conserva únicamente `type`, `description` y `enum`. Las restricciones `min(1).max(10)` de `top_k` y `min(3)` de `query` se pierden al traducir el esquema MCP al formato de Ollama.

La validación Zod real sigue ocurriendo en el servidor MCP, por lo que no hay un hueco explotable directo. Pero la defensa en profundidad se reduce: el modelo puede emitir llamadas con argumentos fuera de rango y el error se descubre en el servidor en lugar de prevenirse.

---

#### H-14 — BAJO — Detalles menores de implementación

- `agent/src/auth/middleware.ts` responde a los fallos con `reply.header(HMAC_TIMESTAMP_HEADER, HMAC_TIMESTAMP_HEADER)` — asigna el **nombre** de la cabecera como su valor. Sin impacto de seguridad, pero indica que la ruta de error no está cubierta por pruebas de integración.
- El `Key-Id` no forma parte de la cadena canónica. Documentado y correcto en el modelo de secreto único; debe corregirse antes de introducir el mapa multi-clave previsto para v2.x, o se abre riesgo de confusión de clave.
- `HMAC_AUTH_ENABLED=false` es un interruptor de desactivación en la misma ruta de código que producción. Debe eliminarse del artefacto de producción, no solo documentarse.

---

### 4.2 Cobertura frente a OWASP Top 10 for LLM Applications 2025

| Riesgo | Estado actual | Hallazgos |
|---|---|---|
| LLM01 — Prompt Injection | ❌ Sin mitigación | H-06 |
| LLM02 — Sensitive Information Disclosure | ❌ Sin mitigación | H-01, H-03, H-11 |
| LLM03 — Supply Chain | ⚠️ Parcial (lockfiles presentes; sin SBOM ni escaneo) | H-07 |
| LLM04 — Data and Model Poisoning | ❌ Sin mitigación (ingesta futura sin controles) | H-06 |
| LLM05 — Improper Output Handling | ⚠️ Parcial (`textContent` en la UI evita XSS; sin validación semántica) | H-06 |
| LLM06 — Excessive Agency | ⚠️ Parcial (1 sola tool, de lectura; MCP sin authn) | H-08 |
| LLM07 — System Prompt Leakage | ⚠️ Prompt estático sin secretos; sin protección explícita | — |
| LLM08 — Vector and Embedding Weaknesses | ❌ Sin control de acceso a nivel de documento | H-06, RF-09 |
| LLM09 — Misinformation | ❌ Sin verificación de fundamentación | H-06 |
| LLM10 — Unbounded Consumption | ❌ Sin límites | H-02, H-10 |

**Nota positiva:** la UI usa `textContent` en lugar de `innerHTML` para renderizar la respuesta del modelo, lo que evita XSS por salida del LLM. Es la mitigación de LLM05 mejor resuelta del sistema y debe preservarse explícitamente en cualquier refactor de la UI.

### 4.3 Matriz de riesgos

| ID | Riesgo | Probabilidad | Impacto | Nivel | Bloquea release |
|---|---|---|---|---|---|
| H-01 | Fuga del secreto HMAC | Alta | Crítico | **Crítico** | Sí |
| H-02 | Bypass por endpoints sin protección | Alta | Crítico | **Crítico** | Sí |
| H-03 | Lectura de sesiones ajenas | Media | Alto | **Alto** | Sí |
| H-04 | Prompt alterable con firma válida | Media | Alto | **Alto** | Sí |
| H-05 | Replay de peticiones firmadas | Media | Medio | **Alto** | Sí |
| H-06 | Prompt injection indirecta | Alta | Alto | **Alto** | Sí |
| H-07 | Credenciales embebidas | Alta | Medio | Medio-Alto | Sí |
| H-08 | Transport MCP global compartido | Media | Medio | Medio-Alto | Sí |
| H-09 | Tráfico sin cifrar | Alta | Medio | Medio | Sí |
| H-10 | Consumo ilimitado | Media | Medio | Medio | Sí |
| H-11 | Prompts sin gobierno de datos | Alta | Medio | Medio | Sí |
| H-12 | Contenedores sin endurecer | Baja | Medio | Medio | No |
| H-13 | Restricciones de esquema perdidas | Baja | Bajo | Bajo | No |
| H-14 | Detalles menores | Baja | Bajo | Bajo | No |

---

## 5. Evaluación Well-Architected

Evaluación contra los seis pilares del AWS Well-Architected Framework, complementada con la Generative AI Lens y la Responsible AI Lens.

### 5.1 Seguridad — ⚠️ Insuficiente

| Aspecto | Estado |
|---|---|
| Identity & Access Management | Sin identidad de usuario; secreto único compartido; credenciales embebidas |
| Detective controls | Logs de aplicación sin agregación, sin CloudTrail, sin alertas |
| Infrastructure protection | Aislamiento de red correcto (fortaleza); sin WAF, sin TLS |
| Data protection | Sin cifrado en tránsito; sin KMS; sin clasificación |
| Incident response | Sin runbooks, sin trazabilidad de sesión a usuario |

**Fortaleza a preservar:** la segmentación en dos redes con el MCP como único punto de cruce es un diseño correcto de defensa en profundidad, y es exactamente lo que debe replicarse con PrivateLink o Site-to-Site VPN en producción.

### 5.2 Fiabilidad — ⚠️ Insuficiente

- Punto único de fallo en `mcp-server` (además del bug de transport global, H-08).
- Sin reintentos, backoff ni circuit breaker en las llamadas a Ollama, MCP o DynamoDB.
- `ensureTable()` incluye un `setTimeout(1500)` como sincronización — frágil.
- Healthchecks solo en `postgres`; `agent-api` y `mcp-server` exponen `/health` pero Compose no los usa.
- Sin estrategia de backup ni recuperación para pgvector.

### 5.3 Rendimiento — ⚠️ Insuficiente

- **Sin índice vectorial.** La tabla `documents` solo tiene la columna `vector(768)`; toda consulta hace un escaneo secuencial completo. Con 10 documentos es imperceptible; con 100.000 chunks es inviable. Requiere `hnsw` o `ivfflat`.
- **Sin chunking.** El documento completo se embebe como un vector único, lo que degrada la precisión del retrieval y limita el tamaño de documento admisible.
- Latencia observada en el README: 94 s para 2 iteraciones en CPU. Sin GPU ni Bedrock, la experiencia de usuario no es viable.
- Sin caché de embeddings de consultas frecuentes.

### 5.4 Costes — ⚠️ Insuficiente

- Sin límites de consumo (H-10), en un destino facturado por token.
- Sin tagging de recursos, sin presupuestos, sin métricas de coste por consulta o por equipo.
- Sin política de selección de modelo por complejidad de consulta.

### 5.5 Excelencia operacional — ⚠️ Insuficiente

- Sin infraestructura como código para AWS (solo Docker Compose para local).
- Sin CI/CD (declarado como pendiente en el README).
- Sin observabilidad distribuida: no hay OpenTelemetry, ni correlation ID, ni trazas del bucle del agente.
- Sin auditoría de llamadas a herramientas.
- **Fortaleza:** documentación excelente. README y `docs/hmac-auth.md` son claros, honestos sobre las limitaciones y directamente utilizables. El Makefile cubre el ciclo de vida completo.

### 5.6 Sostenibilidad — ⚠️ No evaluado

Sin métricas de eficiencia. `qwen2.5:3b` es un modelo pequeño, lo cual es favorable. La ausencia de caché e índice implica trabajo computacional redundante en cada consulta.

### 5.7 Generative AI Lens y Responsible AI Lens

| Dimensión | Estado |
|---|---|
| Guardrails de entrada/salida | ❌ Ausentes |
| Evaluación de calidad del modelo | ❌ Sin conjunto dorado ni métricas de fundamentación |
| Trazabilidad de decisiones del agente | ⚠️ Eventos SSE en tiempo real; sin persistencia auditable |
| Human-in-the-loop | ❌ Sin mecanismo de escalado ni de feedback |
| Transparencia hacia el usuario | ⚠️ Se pide citar fuentes; no se verifica |
| Gestión del ciclo de vida del prompt | ❌ Prompt embebido en el código, sin versionado |
| Equidad y sesgo | ❌ No evaluado |

---

## 6. Objetivos del producto y métricas de éxito

### 6.1 Objetivos

| # | Objetivo | Descripción |
|---|---|---|
| O-1 | Respuestas fiables y citadas | Que un empleado obtenga una respuesta correcta, con la fuente enlazada, en menos de 10 segundos |
| O-2 | Seguridad de nivel producción | Que el servicio resista una revisión de seguridad y una auditoría de cumplimiento |
| O-3 | Residencia de datos garantizada | Que ningún documento fuente ni embedding salga del perímetro on-premises |
| O-4 | Coste predecible | Que el coste por consulta sea medible y esté acotado por cuotas |
| O-5 | Operación sostenible | Que un incidente se diagnostique con las trazas disponibles, sin reproducirlo |

### 6.2 Métricas

| Métrica | Línea base | Objetivo v2.0 | Objetivo v3.0 |
|---|---|---|---|
| Latencia p95 de primera respuesta | ~50 s (CPU) | < 3 s | < 2 s |
| Latencia p95 de respuesta completa | ~95 s | < 15 s | < 10 s |
| Precisión de fundamentación (*groundedness*) | no medida | > 85 % | > 92 % |
| Tasa de citación correcta de la fuente | no medida | > 90 % | > 95 % |
| Tasa de "no lo sé" ante consultas fuera de dominio | no medida | > 80 % | > 90 % |
| Hallazgos críticos o altos abiertos | 6 | 0 | 0 |
| Cobertura de pruebas (rutas de seguridad) | ~100 % del módulo HMAC | > 80 % global | > 85 % global |
| Coste por consulta | no medido | medido y con cuota | < objetivo definido |
| Disponibilidad mensual | no medida | 99,0 % | 99,5 % |

---

## 7. Personas y casos de uso

### 7.1 Personas

**Elena — Empleada (usuaria principal).** Trabaja en marketing, no es técnica. Necesita respuestas sobre políticas de RR.HH. y gastos. No sabe qué documento buscar ni dónde vive. Espera una respuesta directa con un enlace que pueda enseñar a su manager. Si la respuesta parece dudosa, deja de usar la herramienta.

**Marc — Responsable de una política (dueño del contenido).** Del equipo de SecOps. Es dueño de las políticas de seguridad y necesita que el asistente refleje la versión vigente en el momento en que se publica. Quiere saber qué se pregunta sobre sus políticas para mejorarlas.

**Sofía — Ingeniera de plataforma (operadora).** Opera el servicio. Necesita saber por qué una consulta falló o tardó, sin reproducirla, y necesita desplegar sin ventana de mantenimiento.

**Diego — Responsable de seguridad (aprobador).** Debe aprobar la salida a producción. Necesita evidencia de controles: autenticación, cifrado, registro de auditoría, retención de datos y capacidad de responder a una solicitud de supresión bajo RGPD.

### 7.2 Casos de uso

| ID | Caso de uso | Persona | Prioridad |
|---|---|---|---|
| CU-1 | Consultar una política en lenguaje natural y recibir respuesta citada | Elena | P0 |
| CU-2 | Continuar una conversación con contexto de los turnos anteriores | Elena | P0 |
| CU-3 | Consultar el historial de las propias conversaciones | Elena | P1 |
| CU-4 | Recibir "no dispongo de esa información" cuando no hay fuente | Elena | P0 |
| CU-5 | Valorar una respuesta como útil o incorrecta | Elena | P1 |
| CU-6 | Publicar o actualizar un documento y verlo reflejado en el asistente | Marc | P0 |
| CU-7 | Consultar qué se pregunta sobre las políticas propias | Marc | P2 |
| CU-8 | Diagnosticar una consulta lenta o fallida mediante trazas | Sofía | P1 |
| CU-9 | Rotar el secreto de autenticación sin interrumpir el servicio | Sofía | P1 |
| CU-10 | Auditar quién consultó qué y cuándo | Diego | P0 |
| CU-11 | Ejecutar una supresión de datos de un usuario bajo RGPD | Diego | P1 |
| CU-12 | Restringir documentos a los grupos autorizados | Diego, Marc | P0 |

---

## 8. Alcance

### 8.1 Dentro del alcance (v2.0 — "Production Ready")

- Autenticación de usuario final e identidad propagada extremo a extremo.
- Autorización sobre documentos por pertenencia a grupo del directorio corporativo.
- Cierre de los hallazgos H-01 a H-11.
- Sustitución de Ollama por Amazon Bedrock, manteniendo la abstracción del proveedor.
- Guardrails de entrada y salida.
- Pipeline de ingesta con chunking, versionado y control de acceso a nivel de documento.
- Conversación multi-turno con contexto persistente.
- Observabilidad distribuida y registro de auditoría.
- Infraestructura como código y CI/CD.
- Conjunto dorado de evaluación y métricas de calidad automatizadas.

### 8.2 Fuera del alcance (v2.0)

- Herramientas de escritura (crear tickets, enviar correos, modificar registros). El agente permanece **de solo lectura** — es la mitigación principal de LLM06.
- Multi-tenencia entre organizaciones distintas.
- Ajuste fino (*fine-tuning*) de modelos.
- Interfaces distintas de la web (Slack, Teams, móvil) — previstas para v3.0.
- Idiomas más allá de español e inglés.
- Ingesta de documentos por parte del usuario final.

### 8.3 Supuestos

- Existe un proveedor de identidad corporativo (SAML u OIDC) integrable con Amazon Cognito o IAM Identity Center.
- La conectividad Site-to-Site VPN o AWS Direct Connect hacia el centro de datos on-premises está disponible o es aprovisionable.
- Los documentos fuente tienen un dueño identificable y un ciclo de vida de publicación.
- Amazon Bedrock está disponible en la región elegida con los modelos requeridos.

---

## 9. Requisitos funcionales

Los criterios de aceptación se expresan en formato Dado/Cuando/Entonces.

### 9.1 Consulta y conversación

---

**RF-01 — Consulta en lenguaje natural con respuesta citada** · P0 · CU-1

> Como Elena, quiero preguntar sobre una política con mis propias palabras y recibir una respuesta con la fuente, para poder verificarla y compartirla.

**Criterios de aceptación**

1. Dado un usuario autenticado, cuando envía una consulta con contenido en la base de conocimiento, entonces recibe una respuesta que incluye al menos una referencia a un documento fuente con enlace navegable.
2. Dado que la respuesta se genera, cuando el sistema la devuelve, entonces cada afirmación factual es verificable en los fragmentos recuperados (comprobado por el evaluador de fundamentación).
3. Dado un fallo del proveedor de LLM, cuando la generación no completa, entonces el usuario ve un mensaje de error accionable y la petición no se cobra al presupuesto.
4. El primer token se emite en menos de 3 segundos en el p95.

---

**RF-02 — Respuesta honesta ante ausencia de fuente** · P0 · CU-4

> Como Elena, quiero que el asistente admita cuando no sabe algo, para no tomar decisiones sobre información inventada.

**Criterios de aceptación**

1. Dado que la búsqueda no devuelve resultados por encima del umbral de similitud configurado, cuando el agente responde, entonces indica explícitamente que no dispone de información y no genera contenido especulativo.
2. Dada una consulta fuera del dominio corporativo, cuando el agente responde, entonces redirige al usuario sin intentar responderla.
3. El umbral de similitud es configurable sin desplegar código.

---

**RF-03 — Conversación multi-turno** · P0 · CU-2

> Como Elena, quiero hacer preguntas de seguimiento sin repetir el contexto.

**Criterios de aceptación**

1. Dada una sesión activa, cuando el usuario envía un turno de seguimiento, entonces el agente dispone de los turnos anteriores de esa sesión.
2. El historial se acota por una ventana configurable de turnos o de tokens.
3. Dado un cambio de tema detectado, cuando el agente busca, entonces reformula la consulta de forma independiente del contexto anterior.

> **Brecha respecto al estado actual:** hoy `SessionRecord` solo almacena `last_query` y `last_response`. Requiere rediseño del modelo de datos.

---

**RF-04 — Trazabilidad del razonamiento** · P1 · CU-1, CU-8

> Como Elena, quiero ver qué buscó el asistente antes de responder, para entender de dónde sale la respuesta.

**Criterios de aceptación**

1. Durante la generación, la UI muestra cada llamada a herramienta con su nombre y la consulta empleada.
2. Al finalizar, el usuario puede desplegar los fragmentos recuperados con su puntuación de similitud.
3. La UI **no** renderiza contenido del modelo como HTML (preservar el uso de `textContent`).

---

**RF-05 — Historial de conversaciones propias** · P1 · CU-3

**Criterios de aceptación**

1. Un usuario autenticado lista únicamente sus propias sesiones.
2. Dado un intento de acceder a una sesión ajena, cuando se solicita, entonces el sistema responde 404 (no 403, para no confirmar la existencia del recurso).
3. El usuario puede eliminar una sesión, y la eliminación se propaga al almacén en menos de 24 horas.

---

**RF-06 — Valoración de la respuesta** · P1 · CU-5

**Criterios de aceptación**

1. Cada respuesta ofrece valoración positiva o negativa, y un campo opcional de comentario.
2. La valoración negativa registra la consulta, los fragmentos recuperados y la respuesta, para su análisis.
3. Las valoraciones alimentan el panel de calidad y el conjunto de regresión.

---

### 9.2 Conocimiento e ingesta

---

**RF-07 — Pipeline de ingesta con chunking** · P0 · CU-6

> Como Marc, quiero que al publicar una política actualizada el asistente la refleje sin intervención manual.

**Criterios de aceptación**

1. Dado un documento nuevo o modificado en el origen, cuando se ejecuta la ingesta, entonces queda disponible para búsqueda en menos de 15 minutos.
2. Los documentos se segmentan en fragmentos con solapamiento configurable, preservando los límites semánticos (secciones, párrafos).
3. Cada fragmento almacena: `document_id`, `chunk_index`, `source_uri`, `version`, `effective_date`, `owner`, `classification`, `acl_groups`.
4. Dado un documento retirado, cuando se ingesta, entonces sus fragmentos dejan de aparecer en las búsquedas en el mismo ciclo.
5. La ingesta es idempotente: reprocesar un documento sin cambios no genera duplicados.

> **Brecha:** hoy `seed.ts` embebe el documento completo en un único vector, sin metadatos ni versionado.

---

**RF-08 — Índice vectorial escalable** · P0

**Criterios de aceptación**

1. La tabla `documents` dispone de un índice `hnsw` o `ivfflat` sobre la columna de embedding.
2. Con 100.000 fragmentos, la latencia p95 de búsqueda es inferior a 200 ms.
3. El recall a K=5 frente a búsqueda exacta es superior al 95 % en el conjunto dorado.

---

**RF-09 — Control de acceso a nivel de documento** · P0 · CU-12 · mitiga LLM08

> Como Diego, quiero que un empleado solo recupere documentos que su grupo tiene autorizados.

**Criterios de aceptación**

1. Dada una consulta de un usuario, cuando se ejecuta la búsqueda vectorial, entonces el filtro por `acl_groups` se aplica **en la cláusula SQL**, no como post-filtrado en la aplicación.
2. Dado un usuario sin permisos sobre ningún documento relevante, cuando consulta, entonces recibe la respuesta de RF-02 y **no** una indicación de que existen documentos restringidos.
3. La identidad y los grupos del usuario se propagan desde el agente hasta el servidor MCP en cada llamada a herramienta.
4. Existe una prueba automatizada que verifica que un usuario del grupo A no puede recuperar contenido exclusivo del grupo B.

---

**RF-10 — Validación de contenido en la ingesta** · P0 · mitiga LLM04

**Criterios de aceptación**

1. Todo documento ingestado pasa por un detector de patrones de inyección de instrucciones antes de indexarse.
2. Un documento marcado como sospechoso se pone en cuarentena y se notifica a su dueño; no se indexa automáticamente.
3. Solo se admiten documentos de orígenes en lista blanca.
4. Cada ingesta deja un registro de auditoría: origen, hash del documento, resultado de la validación, marca temporal.

---

### 9.3 Agente y modelo

---

**RF-11 — Abstracción del proveedor de LLM** · P0

**Criterios de aceptación**

1. Cambiar entre Amazon Bedrock y Ollama se realiza mediante configuración, sin modificar la lógica del agente.
2. La interfaz cubre: chat con streaming, tool calling y embeddings.
3. Existen pruebas de contrato que ambas implementaciones superan.

> El código actual acopla `agent/src/agent/llm.ts` directamente al cliente de Ollama. Es la refactorización con mejor relación valor/esfuerzo del release.

---

**RF-12 — Guardrails de entrada y salida** · P0 · mitiga LLM01, LLM05, LLM09

**Criterios de aceptación**

1. Toda entrada de usuario pasa por un guardrail antes de llegar al modelo; el contenido bloqueado se rechaza con un mensaje neutro y se registra.
2. Todo contenido recuperado se delimita explícitamente en el contexto como datos no confiables, con una instrucción de sistema que prohíbe seguir instrucciones contenidas en él.
3. Toda salida del modelo pasa por un guardrail antes de enviarse al usuario.
4. Existe un banco de pruebas de inyección; la tasa de bloqueo es superior al 95 % antes de cada release.

---

**RF-13 — Presupuesto acotado del bucle del agente** · P0 · mitiga LLM10

**Criterios de aceptación**

1. Cada petición está limitada por: número de iteraciones (por defecto 5, configurable), tokens totales y tiempo de pared.
2. Al agotarse cualquiera de los límites, el agente devuelve una respuesta parcial identificada como tal, no un error opaco.
3. El consumo de cada petición se registra como métrica dimensionada por usuario, sesión y modelo.

---

**RF-14 — Gestión del ciclo de vida del prompt** · P1

**Criterios de aceptación**

1. Los prompts de sistema se almacenan versionados fuera del código de aplicación.
2. Un cambio de prompt se despliega sin reconstruir la imagen del servicio.
3. Cada respuesta registra la versión de prompt empleada.
4. Todo cambio de prompt se evalúa contra el conjunto dorado antes de promocionarse.

---

**RF-15 — Registro de herramientas y agencia mínima** · P0 · mitiga LLM06

**Criterios de aceptación**

1. El agente solo puede invocar herramientas de una lista blanca explícita; una herramienta desconocida devuelta por el modelo se rechaza y se registra.
2. Todas las herramientas de v2.0 son de solo lectura. Cualquier herramienta de escritura requiere aprobación de seguridad y confirmación humana explícita.
3. Cada invocación de herramienta se registra con: identidad del usuario, nombre, argumentos, duración y resultado resumido.

---

### 9.4 Operación

---

**RF-16 — Observabilidad distribuida** · P1 · CU-8

**Criterios de aceptación**

1. Cada petición lleva un identificador de correlación propagado por navegador, agente, MCP y base de datos.
2. Existe una traza por petición con tramos para: guardrail, cada iteración del LLM, cada llamada a herramienta, embedding y búsqueda vectorial.
3. El panel operativo muestra latencia por tramo, tasa de error, iteraciones por consulta y coste por consulta.
4. Hay alertas sobre latencia p95, tasa de error, rechazos de autenticación y desviación del presupuesto.

---

**RF-17 — Registro de auditoría** · P0 · CU-10

**Criterios de aceptación**

1. Todo acceso a la base de conocimiento se registra con: identidad, marca temporal, consulta, documentos recuperados y decisión de autorización.
2. El registro es de solo anexado y su retención es independiente de la retención de las sesiones.
3. El registro es consultable por identidad y por rango de fechas para responder a una solicitud de auditoría.
4. El registro de auditoría **no** incluye el texto completo de las respuestas, salvo que la política lo exija de forma explícita.

---

**RF-18 — Rotación de secretos sin interrupción** · P1 · CU-9

**Criterios de aceptación**

1. El sistema acepta simultáneamente la credencial anterior y la nueva durante una ventana de solapamiento configurable.
2. La rotación no requiere reinicio de servicio ni redespliegue de clientes.
3. La rotación se registra en el log de auditoría.

---

**RF-19 — Evaluación continua de la calidad** · P1

**Criterios de aceptación**

1. Existe un conjunto dorado de al menos 100 pares consulta/respuesta esperada, con la fuente correcta anotada.
2. El pipeline de CI ejecuta la evaluación en cada cambio de prompt, modelo o estrategia de recuperación.
3. Se calculan y publican: fundamentación, precisión de citación, recall del retrieval y tasa de abstención correcta.
4. Una regresión superior al umbral definido bloquea el despliegue.

---

## 10. Requisitos no funcionales

### 10.1 Rendimiento

| ID | Requisito |
|---|---|
| RNF-01 | Primer token en menos de 3 s (p95) y menos de 5 s (p99) |
| RNF-02 | Respuesta completa en menos de 15 s (p95) |
| RNF-03 | Búsqueda vectorial en menos de 200 ms (p95) con 100.000 fragmentos |
| RNF-04 | 50 consultas concurrentes sin degradación superior al 20 % de la latencia p95 |
| RNF-05 | La ingesta procesa 1.000 documentos en menos de 30 minutos |

### 10.2 Fiabilidad

| ID | Requisito |
|---|---|
| RNF-06 | Disponibilidad mensual del 99,5 % (objetivo v3.0; 99,0 % en v2.0) |
| RNF-07 | Sin punto único de fallo en el plano de AWS; mínimo dos zonas de disponibilidad |
| RNF-08 | Degradación elegante: si el LLM no está disponible, el sistema ofrece los resultados de búsqueda sin generación |
| RNF-09 | Reintentos con backoff exponencial y jitter en toda llamada de red saliente |
| RNF-10 | RPO de 24 h y RTO de 4 h para la base de conocimiento |
| RNF-11 | Aislamiento de sesión por conexión en el servidor MCP (cierra H-08) |

### 10.3 Escalabilidad

| ID | Requisito |
|---|---|
| RNF-12 | Escalado horizontal del agente y del MCP sin estado compartido en memoria |
| RNF-13 | Soporte de 5.000 usuarios registrados y 500 activos diarios |
| RNF-14 | Base de conocimiento de hasta 500.000 fragmentos sin cambio de arquitectura |

### 10.4 Mantenibilidad

| ID | Requisito |
|---|---|
| RNF-15 | Cobertura de pruebas superior al 80 %; 100 % en rutas de autenticación y autorización |
| RNF-16 | Toda la infraestructura AWS definida como código (CDK o Terraform) |
| RNF-17 | Despliegue automatizado con reversión en menos de 5 minutos |
| RNF-18 | Sin dependencias con vulnerabilidades críticas o altas conocidas en el momento del despliegue |

### 10.5 Usabilidad y accesibilidad

| ID | Requisito |
|---|---|
| RNF-19 | Interfaz conforme a WCAG 2.1 nivel AA |
| RNF-20 | Interfaz en español e inglés; el agente responde en el idioma de la consulta |
| RNF-21 | Compatible con los navegadores en soporte activo de las dos últimas versiones mayores |

### 10.6 Cumplimiento

| ID | Requisito |
|---|---|
| RNF-22 | Conformidad con el RGPD: base legal, minimización, derecho de supresión y de acceso |
| RNF-23 | Retención de sesiones configurable, por defecto 90 días, con eliminación automática |
| RNF-24 | Registro de auditoría con retención de 12 meses |
| RNF-25 | Evidencia de controles alineada con ISO 27001 Anexo A y SOC 2 (criterios Security y Confidentiality) |
| RNF-26 | Evaluación de impacto conforme al NIST AI Risk Management Framework antes de la salida a producción |

---

## 11. Requisitos de seguridad

Cada requisito indica el hallazgo que cierra.

### 11.1 Identidad y acceso

| ID | Requisito | Cierra |
|---|---|---|
| SEC-01 | **Eliminar `GET /api/auth/config`.** Ningún endpoint devolverá material criptográfico al cliente. La autenticación del navegador se realizará mediante OIDC contra el proveedor de identidad corporativo. | H-01 |
| SEC-02 | **Autenticación obligatoria en todos los endpoints** salvo `/health` y los activos estáticos. Aplicar como hook global, no ruta por ruta, de forma que una ruta nueva quede protegida por defecto. | H-02 |
| SEC-03 | **Autorización a nivel de recurso.** Toda sesión pertenece a un `user_id`. Acceder a una sesión ajena devuelve 404. | H-03 |
| SEC-04 | **CORS restringido** a una lista blanca explícita de orígenes. Prohibido `origin: true`. | H-01 |
| SEC-05 | **Identidad propagada extremo a extremo** hasta el servidor MCP, incluida en cada llamada a herramienta y usada en el filtro de autorización de la consulta SQL. | H-06, RF-09 |
| SEC-06 | **Autenticación en el servidor MCP.** El endpoint MCP no acepta conexiones anónimas y no se publica fuera de la red privada. | H-08 |

### 11.2 Integridad de las peticiones

Si se conserva HMAC para la integración máquina a máquina:

| ID | Requisito | Cierra |
|---|---|---|
| SEC-07 | **La cadena canónica incluye la URI completa con la query string ordenada** y el `Key-Id`. | H-04, H-14 |
| SEC-08 | **Anti-replay con almacén de nonces.** Cada petición incluye un nonce único; el servidor lo rechaza si ya fue usado dentro de la ventana. Almacén con TTL (DynamoDB o ElastiCache). | H-05 |
| SEC-09 | **Ventana temporal reducida a 60 segundos**, con NTP obligatorio en todos los nodos. | H-05 |
| SEC-10 | **Mapa multi-clave con rotación**, respaldado por AWS Secrets Manager y rotación automática. | H-07, RF-18 |
| SEC-11 | **Eliminar `HMAC_AUTH_ENABLED`** del artefacto de producción. El modo permisivo no debe existir en el binario desplegado. | H-14 |

### 11.3 Protección de datos

| ID | Requisito | Cierra |
|---|---|---|
| SEC-12 | **TLS 1.2 o superior en todos los tramos**, incluidos los internos entre servicios. | H-09 |
| SEC-13 | **Cifrado en reposo con AWS KMS y claves gestionadas por el cliente** en DynamoDB, S3 y RDS. | H-11 |
| SEC-14 | **Cero credenciales en código o en imágenes.** Roles IAM para el acceso a servicios AWS; Secrets Manager para el resto. Escaneo de secretos en CI como puerta bloqueante. | H-07 |
| SEC-15 | **Detección y redacción de PII** en los prompts antes de persistirlos y antes de escribirlos en el log. | H-11 |
| SEC-16 | **Los logs no contienen prompts ni respuestas completas.** Solo identificadores, métricas y metadatos. | H-11 |
| SEC-17 | **TTL en las sesiones** con la retención de RNF-23, y soporte de supresión bajo demanda. | H-11, RNF-22 |

### 11.4 Seguridad específica de IA

| ID | Requisito | Cierra |
|---|---|---|
| SEC-18 | **Guardrails de entrada y salida** en todas las rutas de generación. | H-06 |
| SEC-19 | **Separación explícita de datos e instrucciones.** El contenido recuperado se delimita con marcadores y se acompaña de una instrucción que prohíbe obedecer instrucciones contenidas en él. | H-06 |
| SEC-20 | **Verificación de fundamentación** antes de devolver la respuesta; una respuesta no fundamentada se marca o se sustituye por la abstención de RF-02. | H-06 |
| SEC-21 | **Validación de contenido en la ingesta** con cuarentena de documentos sospechosos. | H-06, RF-10 |
| SEC-22 | **Lista blanca de herramientas** y rechazo registrado de cualquier invocación fuera de ella. | H-08 |
| SEC-23 | **Restricciones de esquema preservadas** en la traducción MCP → proveedor de LLM. | H-13 |
| SEC-24 | **Banco de pruebas adversarias** ejecutado en CI: inyección directa e indirecta, extracción de prompt de sistema, elusión de autorización, exfiltración de datos. | H-06 |

### 11.5 Infraestructura

| ID | Requisito | Cierra |
|---|---|---|
| SEC-25 | **Contenedores sin privilegios:** `USER` no root, sistema de ficheros de solo lectura, `cap_drop: ALL`, `no-new-privileges`, límites de recursos. | H-12 |
| SEC-26 | **Prohibido montar `/var/run/docker.sock`** en cualquier contenedor de entornos compartidos o productivos. | H-12 |
| SEC-27 | **Rate limiting y cuotas** por usuario y global, en la capa de borde y en la aplicación. | H-10 |
| SEC-28 | **AWS WAF** delante del punto de entrada público, con reglas gestionadas y limitación por IP. | H-10 |
| SEC-29 | **Sin puertos innecesarios publicados.** El servidor MCP y la base de datos no se exponen fuera de la subred privada. | H-08 |
| SEC-30 | **Escaneo de imágenes y SBOM** en CI; los hallazgos críticos bloquean el despliegue. | LLM03 |
| SEC-31 | **Grupos de seguridad y NACLs de denegación por defecto**; el tráfico hacia on-premises solo por el túnel VPN, restringido al puerto del servicio MCP. | — |

---

## 12. Arquitectura objetivo

### 12.1 Vista lógica

```
┌──────────────────────── AWS ─────────────────────────────────┐
│                                                              │
│  Route 53 → CloudFront → AWS WAF                             │
│                    │                                         │
│                    ▼                                         │
│              ALB (TLS 1.3)                                   │
│                    │                                         │
│         ┌──────────┴──────────┐                              │
│         ▼                     ▼                              │
│   Amazon Cognito         ECS Fargate: agent-api              │
│   (OIDC ↔ IdP corp.)     ├─ Guardrails (entrada/salida)      │
│                          ├─ Bucle del agente (acotado)       │
│                          ├─ Cliente MCP (mTLS)               │
│                          └─ Rate limiter                     │
│                               │        │         │           │
│              ┌────────────────┘        │         └──────┐    │
│              ▼                         ▼                ▼    │
│      Amazon Bedrock            DynamoDB           CloudWatch │
│      + Guardrails              (sesiones,         X-Ray      │
│      (LLM + embeddings)         nonces, KMS)      OpenSearch │
│                                                   (auditoría)│
│  Secrets Manager · KMS · ECR · CodePipeline                  │
└──────────────────────────────┬───────────────────────────────┘
                               │ Site-to-Site VPN / Direct Connect
                               │ (solo puerto MCP, mTLS)
┌──────────────────────────────┴───────────────────────────────┐
│                      On-Premises                             │
│                                                              │
│   mcp-server (gateway)                                       │
│   ├─ Autenticación + autorización por grupos                 │
│   ├─ tool: search_documents (filtrado por ACL en SQL)        │
│   └─ Aislamiento de sesión por conexión                      │
│              │                          │                    │
│              ▼                          ▼                    │
│      PostgreSQL + pgvector      Pipeline de ingesta          │
│      (índice HNSW, ACL,         (chunking, validación,       │
│       versionado)                versionado, cuarentena)     │
│                                          ▲                   │
│                                          │                   │
│                              Orígenes documentales           │
│                              (Confluence, SharePoint, Git)   │
└──────────────────────────────────────────────────────────────┘
```

### 12.2 Decisiones de arquitectura

| Decisión | Justificación |
|---|---|
| **Conservar MCP como único punto de cruce del perímetro** | Es la mayor fortaleza del diseño actual. Un único protocolo, un único punto de control, una única superficie que auditar. |
| **Amazon Bedrock en lugar de modelos autogestionados** | Elimina la gestión de infraestructura de inferencia, aporta Guardrails nativos y facturación por uso medible. |
| **Embeddings generados on-premises** | Preserva la residencia: los documentos fuente nunca salen del perímetro. Solo el vector de la consulta del usuario cruza, y únicamente si se decide generar el embedding en AWS. |
| **Filtrado por ACL en la cláusula SQL** | El post-filtrado en la aplicación deja los documentos no autorizados en memoria del proceso y es propenso a errores. |
| **Agente de solo lectura en v2.0** | Reduce drásticamente el impacto de una inyección de prompt exitosa. Es la mitigación más eficaz de LLM06. |
| **DynamoDB para sesiones y nonces** | Ya está en uso, escala sin gestión y soporta TTL nativo — exactamente lo que requieren SEC-08 y SEC-17. |
| **OIDC en lugar de HMAC para el navegador** | HMAC exige un secreto compartido, que un navegador no puede custodiar. HMAC se conserva únicamente para integración máquina a máquina. |

### 12.3 Modelo de datos objetivo

**pgvector — `document_chunks`**

```sql
id              uuid PRIMARY KEY
document_id     uuid NOT NULL
chunk_index     int NOT NULL
source_uri      text NOT NULL
title           text
content         text NOT NULL
embedding       vector(1024) NOT NULL
version         int NOT NULL
effective_from  timestamptz NOT NULL
effective_to    timestamptz
owner_group     text NOT NULL
acl_groups      text[] NOT NULL
classification  text NOT NULL   -- public | internal | confidential | restricted
content_hash    text NOT NULL
ingested_at     timestamptz NOT NULL

CREATE INDEX ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON document_chunks USING gin (acl_groups);
CREATE INDEX ON document_chunks (document_id, chunk_index);
```

**DynamoDB — `agent_sessions`**

```
PK: user_id        -- habilita la consulta "mis sesiones" y hace cumplir SEC-03
SK: session_id
    created_at, updated_at, title, turn_count, ttl (número, epoch)
```

**DynamoDB — `agent_turns`**

```
PK: session_id
SK: turn_index
    role, content_ref, tool_calls, prompt_version, model_id,
    token_usage, latency_ms, ttl
```

**DynamoDB — `hmac_nonces`** (SEC-08)

```
PK: nonce
    key_id, used_at, ttl
```

---

## 13. Roadmap

### v1.2 — Contención inmediata · 1 semana

Mitigaciones de bajo esfuerzo aplicables al prototipo actual antes de que lo vea cualquier usuario ajeno al equipo.

- Suprimir `GET /api/auth/config` o restringirlo a `NODE_ENV !== 'production'` con enlace a localhost.
- Restringir CORS a una lista blanca explícita.
- Aplicar el hook HMAC a **todos** los endpoints de `/api`.
- Incluir la query string en la cadena canónica.
- Reducir la ventana temporal a 60 s.
- Añadir `USER node` a ambos `Dockerfile`.
- Dejar de publicar el puerto 3001 en el host.
- Retirar el prompt del log de aplicación.

### v2.0 — Production Ready · 6 semanas

Cierra todos los hallazgos bloqueantes y habilita el piloto interno.

| Bloque | Contenido |
|---|---|
| Identidad | SEC-01 a SEC-06 · RF-05 |
| Datos | SEC-12 a SEC-17 · RF-09 |
| Seguridad de IA | SEC-18 a SEC-24 · RF-10, RF-12, RF-15 |
| Plataforma | SEC-25 a SEC-31 · RNF-11, RNF-16 |
| Conocimiento | RF-07, RF-08 |
| Modelo | RF-11 (Bedrock), RF-13 |
| Operación | RF-16, RF-17, RF-19 |

**Criterio de salida:** cero hallazgos críticos o altos abiertos; banco de pruebas adversarias por encima del 95 % de bloqueo; conjunto dorado establecido.

### v2.1 — Experiencia y calidad · 4 semanas

RF-03 (multi-turno), RF-04, RF-06, RF-14, RF-18. Panel de calidad para los dueños de contenido (CU-7).

### v3.0 — Escala · 8 semanas

Multi-región, canales adicionales (Slack, Teams), enrutado de modelo por complejidad de consulta, recuperación híbrida (denso + BM25) con reranking, caché semántica.

---

## 14. Riesgos del proyecto

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| La latencia de Bedrock a través de la VPN degrada la experiencia | Media | Alto | Prototipar el tramo VPN en la semana 1 de v2.0; evaluar Direct Connect |
| Los guardrails generan demasiados falsos positivos y frustran a los usuarios | Media | Medio | Fase de umbral en modo observación antes de bloquear; panel de falsos positivos |
| Los grupos del directorio corporativo no mapean limpiamente a las ACL de documentos | Alta | Medio | Taller con los dueños de contenido en la fase de descubrimiento; ACL por defecto restrictiva |
| El coste de Bedrock supera el presupuesto en el piloto | Media | Medio | Cuotas duras desde el primer día (RF-13); alertas de presupuesto |
| El equipo on-premises no puede operar el pipeline de ingesta | Media | Alto | Automatizar completamente; runbooks; formación antes del traspaso |
| El reprocesado de embeddings al cambiar de modelo bloquea el servicio | Baja | Alto | Indexación con doble escritura y conmutación por versión de modelo |
| El alcance de v2.0 se expande con funcionalidad no de seguridad | Alta | Alto | Congelación de funcionalidad; los hallazgos son criterio de salida no negociable |

---

## 15. Preguntas abiertas

1. ¿Cuál es el proveedor de identidad corporativo y admite OIDC directamente, o se requiere federación vía Cognito?
2. ¿Existe ya conectividad Site-to-Site VPN hacia el centro de datos, o hay que aprovisionarla dentro del alcance del proyecto?
3. ¿Cuáles son los orígenes documentales reales y con qué volumen? Los 10 documentos del seed son ilustrativos.
4. ¿Qué modelo de clasificación de documentos existe hoy, y quién es el dueño de las ACL?
5. ¿La restricción de residencia aplica también a la **consulta del usuario**, o solo a los documentos fuente? La respuesta determina si el embedding de la consulta puede generarse en Bedrock.
6. ¿Cuál es el presupuesto mensual aprobado para inferencia, y a partir de qué umbral se degrada el servicio?
7. ¿Hay compromiso de retención legal sobre las conversaciones que anule la retención por defecto de 90 días?
8. ¿Debe el asistente registrar la identidad del usuario en el log de auditoría, o basta un seudónimo? Afecta al diseño de SEC-15 y RNF-22.

---

## Anexo A — Trazabilidad hallazgo → requisito

| Hallazgo | Severidad | Requisitos que lo cierran |
|---|---|---|
| H-01 Secreto HMAC expuesto | Crítico | SEC-01, SEC-04 |
| H-02 Endpoints sin protección | Crítico | SEC-02 |
| H-03 IDOR en sesiones | Alto | SEC-03, RF-05 |
| H-04 Query string sin firmar | Alto | SEC-07 |
| H-05 Sin anti-replay | Alto | SEC-08, SEC-09 |
| H-06 Sin defensa contra inyección | Alto | SEC-18, SEC-19, SEC-20, SEC-21, RF-10, RF-12 |
| H-07 Credenciales embebidas | Medio-Alto | SEC-10, SEC-14 |
| H-08 Transport MCP global | Medio-Alto | RNF-11, SEC-06, SEC-22, SEC-29 |
| H-09 Sin TLS | Medio | SEC-12 |
| H-10 Consumo ilimitado | Medio | SEC-27, SEC-28, RF-13 |
| H-11 Prompts sin gobierno | Medio | SEC-13, SEC-15, SEC-16, SEC-17 |
| H-12 Contenedores sin endurecer | Medio | SEC-25, SEC-26 |
| H-13 Restricciones de esquema perdidas | Bajo | SEC-23 |
| H-14 Detalles menores | Bajo | SEC-07, SEC-11 |

## Anexo B — Fortalezas del diseño actual a preservar

Este análisis se centra en las brechas por su propósito, pero varias decisiones del prototipo son acertadas y deben conservarse explícitamente en el rediseño:

1. **El agente nunca accede a la base vectorial directamente.** Todo pasa por MCP. Es un diseño de defensa en profundidad correcto y poco común en prototipos de RAG.
2. **La segmentación de redes está verificada**, no solo afirmada — el README incluye una matriz de alcanzabilidad probada.
3. **La UI usa `textContent`, no `innerHTML`**, para renderizar la salida del modelo. Previene XSS por LLM05 de la manera más simple y robusta posible.
4. **La comparación de firmas es en tiempo constante** (`crypto.timingSafeEqual`), con verificación previa de longitud.
5. **La documentación es honesta sobre sus propias limitaciones.** `docs/hmac-auth.md` señala explícitamente que servir el secreto al navegador solo es aceptable en desarrollo. Esa honestidad es la que hace posible este PRD.
6. **El Makefile genera el secreto HMAC automáticamente** con `openssl rand -hex 32` y no sobrescribe uno existente — buena higiene de secretos para desarrollo local.
7. **Una única herramienta, de solo lectura.** La agencia mínima es la mitigación más eficaz de LLM06, y el prototipo la aplica por defecto.

---

## Referencias

- [OWASP Top 10 for LLM Applications 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf)
- [AWS Well-Architected Framework — Generative AI Lens](https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/generative-ai-lens.html)
- [Architecting for AI excellence: AWS launches three Well-Architected Lenses at re:Invent 2025](https://aws.amazon.com/blogs/architecture/architecting-for-ai-excellence-aws-launches-three-well-architected-lenses-at-reinvent-2025)
- [Introducing the Well-Architected Generative AI Lens](https://aws.amazon.com/about-aws/whats-new/2025/04/well-architected-generative-ai-lens)
- Código fuente analizado: `agentic-rag` v1.1.0 — `README.md`, `docs/hmac-auth.md`, `docs/architecture.drawio`, `agent/src/**`, `mcp-server/src/**`, `compose/docker-compose.yml`, `Makefile`
