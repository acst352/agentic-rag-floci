# HMAC Auth (v1.3.0)

Lightweight request signing for `agent-api`. Inspired by AWS SigV4 — same
primitives (HMAC-SHA256 over a canonical string) but without region/service
key derivation, since we have a single trust domain.

## Status

| Version | Scope | Cierra |
|---|---|---|
| **v1.3.0** (this) | v1.2 + **`X-Floci-Subject`** firmado en la cadena canónica; `SessionRecord.user_id`; 404 indistinguible cuando una sesión pertenece a otro subject; defensa contra IDOR en `/api/sessions/:id` | **H-03** (sobre v1.2) |
| v1.2.0 | **Global onRequest hook** sobre todos los endpoints `/api` (allowlist: `/health`, `/api/auth/config` en dev, `/`); CORS allowlist; canonical path incluye query string ordenada; nonce único por request; ventana 60s | H-01, H-02, H-04, H-05 |
| v1.1.0 | Solo `GET /api/chat/stream`, ventana 300s, sin nonce | (superseded) |
| Planned v1.4.x | Sustituir `/api/auth/config` por `POST /api/auth/token` con firma server-side; el secreto deja de salir del servidor | — |
| Planned v2.x | Multi-`Key-Id` map → AWS Secrets Manager + rotación; `NonceStore` sobre DynamoDB con TTL para despliegues multi-instancia; subject = `sub` de OIDC (SEC-01) | — |

## How it works (v1.3)

El cliente computa una firma sobre una cadena canónica y la envía en cinco
cabeceras. El servidor recomputa la firma y compara en tiempo constante.

```
canonical  = {timestamp}\n{METHOD}\n{path-with-sorted-query}\n{sha256(body or "")}\n{subject}
signature  = hex(HMAC_SHA256(secret, canonical))
```

`path-with-sorted-query` es la URL solicitada con los parámetros de query
ordenados alfabéticamente por clave. Esto cierra **H-04**: el prompt del
usuario (`?q=...`) entra en la firma, no puede ser alterado sin invalidarla.

`{subject}` es el valor de la cabecera `X-Floci-Subject` (H-03, **v1.3**).
Plegar la identidad lógica del llamante en la firma impide que un atacante
con una firma capturada suplante a otro usuario al cambiar solo el subject
en tránsito. Sin este campo, cualquier persona con un `session_id` filtrado
podría leer la conversación de otro empleado.

### Required request headers

| Header | Value |
|---|---|
| `X-Floci-Timestamp` | Epoch seconds at sign time |
| `X-Floci-Key-Id` | Identifier of the secret to use |
| `X-Floci-Nonce` | UUID único por request. El servidor rechaza repeticiones dentro de la ventana (H-05 anti-replay). |
| `X-Floci-Subject` | **NEW v1.3.** Identidad lógica del llamante. En dev = `HMAC_KEY_ID`; en producción será el `sub` del OIDC. Se incluye en la cadena canónica. |
| `X-Floci-Signature` | Hex HMAC-SHA256 of the canonical string |

### Server validation order

1. Las cuatro cabeceras primarias presentes (timestamp, key-id, nonce,
   subject). Si falta subject y no hay `defaultSubject` configurado →
   `401 missing_subject` (**v1.3**).
2. **Nonce presente**. Si falta → `401 missing_nonce`.
3. Timestamp es entero y dentro de `HMAC_WINDOW_SECONDS` (±60s)
   del reloj del servidor. Fuera → `401 timestamp_out_of_window`.
4. `Key-Id` coincide con el configurado. Si no → `401 unknown_key_id`.
5. Subject leído del header (o `defaultSubject`). Firma recomputada en
   tiempo constante (`crypto.timingSafeEqual`) sobre la cadena canónica
   con subject incluido (**v1.3**). Si no → `401 signature_mismatch`.
6. **Nonce consumido por primera vez**. Si ya fue visto → `401 nonce_replay`.

## Scope: global hook + allowlist (v1.2)

El hook HMAC se aplica como `addHook('onRequest')` global en
`agent/src/server.ts`. **Por defecto toda ruta requiere firma**. La
allowlist exceptúa explícitamente:

| Ruta | Método | Razón |
|---|---|---|
| `/health` | GET | Probe de liveness; sin información sensible |
| `/api/auth/config` | GET | Solo en `NODE_ENV !== 'production'` (ver H-01) |
| `/*` | GET | UI estática servida por `@fastify/static` |

Cualquier ruta nueva queda protegida automáticamente. Esto cierra **H-02**.

## Configuration

El servidor lee las siguientes variables de entorno (ver `agent/.env.example`):

```bash
HMAC_SECRET=...            # openssl rand -hex 32
HMAC_KEY_ID=default        # stable identifier, allows rotation later
HMAC_WINDOW_SECONDS=60     # default 60 (v1.2; antes era 300)
HMAC_AUTH_ENABLED=true     # set to false ONLY for local dev

CORS_ALLOWED_ORIGINS=http://localhost:3002,http://localhost:5173
                           # CSV de orígenes permitidos (v1.2 H-01)
```

Cuando `HMAC_AUTH_ENABLED=false`, el hook cortocircuita y las peticiones
pasan sin validar (log WARN al arrancar). **No usar en producción**.

Adicionalmente, desde **v1.3** el servidor acepta `HMAC_SUBJECT` como
identidad lógica por defecto cuando el cliente no envía `X-Floci-Subject`.
Útil durante la migración desde clientes v1.2.x. En v2.0 este fallback
caerá y el header será obligatorio.

## Session authorization (H-03, v1.3)

`POST /api/sessions` y `GET /api/sessions/:id` aplican **autorización a
nivel de recurso** sobre el subject verificado por el hook HMAC:

- Al crear una sesión, se almacena `user_id = req.hmac.subject`.
- Al leer, `getSession(id, req.hmac.subject)` devuelve `null` si la sesión
  pertenece a otro subject o si no existe. La ruta traduce ambos casos a
  `404 Not Found` **idéntico**, sin distinción, para evitar que un atacante
  pueda enumerar `session_id` ajenos diferenciando "no existe" de "no es
  tuyo".
- `getSession(id, "")` también devuelve `null` sin llegar a DynamoDB, como
  defensa frente a cualquier ruta que olvide propagar el subject del hook.

El CLI (`npm run start -- ...`) usa `HMAC_KEY_ID` como subject por defecto
para mantener la consistencia con la UI en dev single-tenant.

Esquema DynamoDB actual: el `user_id` se almacena como atributo escalar
junto al `session_id` (que sigue siendo la PK). En v2.0 lo promoveremos a
parte de la clave compuesta (PK + SK) o añadiremos un GSI por user_id
cuando el listado por usuario sea una necesidad real.

## Quick start

### 1. Generate a secret

```bash
openssl rand -hex 32
# e.g. 9b3d... (64 hex chars)
```

### 2. Put it in `compose/.env` (read by docker-compose)

```bash
HMAC_SECRET=9b3d...
HMAC_KEY_ID=local-dev
HMAC_WINDOW_SECONDS=60
CORS_ALLOWED_ORIGINS=http://localhost:3002
```

### 3. `make up` and verify

```bash
make up
make logs-agent-api    # look for "hmac auth rejected" warnings
```

### 4. Open the UI

El navegador hace `GET /api/auth/config` al cargar, firma cada request de
streaming automáticamente, y deberías ver los tokens llegando. En
producción, ese endpoint devuelve `404` (H-01); la demo local funciona
porque el servidor se arranca con `NODE_ENV !== 'production'` por defecto.

## Calling the API from outside the UI

### curl

```bash
HMAC_SECRET='9b3d...'
KEY_ID='local-dev'
SUBJECT='alice'                  # v1.3: identidad lógica del llamante
PATH_='/api/chat/stream'
QUERY='q=hola&session_id=abc'    # order no importa: el servidor ordena
NONCE=$(uuidgen)
TS=$(date +%s)
BODY_HASH=$(printf '' | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf '%s\nGET\n%s?%s\n%s\n%s' "$TS" "$PATH_" "$QUERY" "$BODY_HASH" "$SUBJECT")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $2}')

curl -N "http://localhost:3002${PATH_}?${QUERY}" \
  -H "X-Floci-Timestamp: $TS" \
  -H "X-Floci-Key-Id: $KEY_ID" \
  -H "X-Floci-Nonce: $NONCE" \
  -H "X-Floci-Subject: $SUBJECT" \
  -H "X-Floci-Signature: $SIG" \
  -H "Accept: text/event-stream"
```

### Python helper

```python
import hashlib, hmac, time, uuid, requests

SECRET = bytes.fromhex("9b3d...")  # o b"..." si no es hex
KEY_ID = "local-dev"
SUBJECT = "alice"                 # v1.3 H-03: identidad lógica
BASE = "http://localhost:3002"

def sorted_query(params: dict) -> str:
    """Ordena los parámetros alfabéticamente por clave (H-04)."""
    return "&".join(
        f"{k}={v}" for k, v in sorted(params.items())
    )

def signed_headers(method: str, path: str, query: dict, body: bytes = b"") -> dict:
    ts = str(int(time.time()))
    nonce = str(uuid.uuid4())
    body_hash = hashlib.sha256(body).hexdigest()
    # El path canónico incluye la query ordenada
    canonical_path = f"{path}?{sorted_query(query)}" if query else path
    canonical = (
        f"{ts}\n{method.upper()}\n{canonical_path}\n{body_hash}\n{SUBJECT}"
    ).encode()
    sig = hmac.new(SECRET, canonical, hashlib.sha256).hexdigest()
    return {
        "X-Floci-Timestamp": ts,
        "X-Floci-Key-Id": KEY_ID,
        "X-Floci-Nonce": nonce,
        "X-Floci-Subject": SUBJECT,
        "X-Floci-Signature": sig,
    }

def stream_chat(question: str, session_id: str):
    path = "/api/chat/stream"
    query = {"q": question, "session_id": session_id}
    headers = signed_headers("GET", path, query)
    headers["Accept"] = "text/event-stream"
    with requests.get(BASE + path, params=query, headers=headers, stream=True) as r:
        r.raise_for_status()
        for line in r.iter_lines(decode_unicode=True):
            if line:
                print(line)
```

### Browser / Web Crypto

`public/script.js` ya implementa todo esto. Ver `signRequest()`,
`sha256Hex()`, `hmacSha256Hex()`, `canonicalizePath()` y `generateNonce()`
cerca del inicio del archivo.

## Tests

58 unit tests cubren camino feliz, expiración de ventana, mutación de
cuerpo/path/método, key-id incorrecto, firmas mal formadas, insensibilidad
a mayúsculas en cabeceras, edge cases de `loadHmacConfigFromEnv`,
canonicalización de query string (H-04), anti-replay con nonces (H-05),
allowlist de rutas (H-02), NonceStore como entidad independiente,
**subject en la cadena canónica y en el header (H-03 v1.3)**, y la
autorización a nivel de recurso en `getSession` (H-03 v1.3, mockeando
DynamoDB).

```bash
cd agent
yarn test
```

## Rotation

Cuando haya que rotar el secreto:

1. Añadir un nuevo `Key-Id` a un mapa multi-secreto (futuro v2.x).
2. El servidor acepta el viejo y el nuevo durante la ventana de solapamiento.
3. Cambiar todos los clientes al nuevo `Key-Id`.
4. Retirar el secreto viejo.

La cabecera ya soporta lookup; solo hay que crecer el resolver de
`string → Record<KeyId, string>`.

## Security notes

- **`/api/auth/config` está bloqueado en producción** (v1.2 H-01). Solo
  sirve el secreto en `NODE_ENV !== 'production'`. La sustitución por
  `POST /api/auth/token` con firma server-side está en v1.4.x.
- **CORS restringido** (v1.2 H-01). `origin: true` está prohibido; usar
  `CORS_ALLOWED_ORIGINS`.
- **Anti-replay real** (v1.2 H-05). Cada request lleva un nonce único
  (`X-Floci-Nonce`); el servidor lo rechaza si se repite dentro de la
  ventana. La ventana se redujo de 300s a 60s.
- **Query string firmada** (v1.2 H-04). El prompt del usuario (`?q=...`)
  entra en la firma. Si se intercepta la petición y se altera `q`, la
  firma se invalida.
- **Subject firmado** (v1.3 H-03). `X-Floci-Subject` entra como quinto
  campo en la cadena canónica. Sin este campo, una firma capturada
  permitiría suplantar la identidad del llamante al cambiar solo la
  cabecera en tránsito.
- **Autorización a nivel de recurso** (v1.3 H-03). Las sesiones
  (`/api/sessions/:id`) están ancladas al `user_id` del subject
  verificado. Una sesión ajena devuelve 404 indistinguible del caso
  "no existe".
- **Comparación en tiempo constante** enforced via `crypto.timingSafeEqual`.
  No sustituir por `===`.
- **`Key-Id` forma parte de la verificación pero no del canonical**
  (chequeado antes de recomputar). Aceptable en modelo de secreto único;
  antes de introducir multi-clave (v2.x), incluir el `Key-Id` en la
  cadena canónica para evitar confusión de claves.
- **Limitación consciente del `NonceStore`**: en memoria (Map). En un
  despliegue multi-instancia cada agente tendría su propio Map; en v2.0
  se sustituirá por DynamoDB con TTL (SEC-08).
- **Limitación consciente del sujeto en dev**: `HMAC_KEY_ID` se reutiliza
  como subject por defecto (single-tenant). En producción el subject
  debe venir del OIDC; nunca confíes en un subject enviado por el
  cliente sin verificar contra el IDP.

## Lo que **NO** cierra v1.3

Quedan pendientes (v2.0):
- H-06 prompt injection real (Guardrails, delimitadores, grounding)
- H-07 credenciales embebidas (Secrets Manager)
- H-08 transport MCP global multi-conexión
- H-09 TLS en todos los tramos
- H-10 rate limiting / WAF
- H-11 gobierno de prompts en logs (PII / redacción)
- H-12 endurecimiento de contenedores (USER node, cap_drop) — **parcial en v1.2.1**
- H-13 schema restrictions preservadas en adapter MCP
- H-14 kill switch `HMAC_AUTH_ENABLED` retirado del binario de prod
