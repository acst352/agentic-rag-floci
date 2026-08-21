# HMAC Auth (v1.1.0)

Lightweight request signing for `agent-api`. Inspired by AWS SigV4 — same
primitives (HMAC-SHA256 over a canonical string) but without region/service
key derivation, since we have a single trust domain.

## Status

| Version | Scope |
|---|---|
| **v1.1.0** (this) | `GET /api/chat/stream` |
| Planned v1.2.x | Extend to `POST /api/chat`, `POST /api/sessions`, debug endpoints |
| Planned v1.3.x | Server-side signing via `POST /api/auth/token` so the secret never leaves the server |
| Planned v2.x | Multi-`Key-Id` map → SSM/Secrets Manager for per-client rotation |

## How it works

The client computes a signature over a canonical string and sends it in three
headers. The server recomputes the signature and compares in constant time.

```
canonical  = {timestamp}\n{METHOD}\n{path}\n{sha256(body or "")}
signature  = hex(HMAC_SHA256(secret, canonical))
```

### Required request headers

| Header | Value |
|---|---|
| `X-Floci-Timestamp` | Epoch seconds at sign time |
| `X-Floci-Key-Id` | Identifier of the secret to use |
| `X-Floci-Signature` | Hex HMAC-SHA256 of the canonical string |

### Server validation order

1. All three headers present.
2. Timestamp is an integer and within `HMAC_WINDOW_SECONDS` (±300s default)
   of server clock. Outside the window → `401 timestamp_out_of_window`.
3. `Key-Id` matches the server's configured key → otherwise `401 unknown_key_id`.
4. Recomputed signature matches in constant time
   (`crypto.timingSafeEqual`) → otherwise `401 signature_mismatch`.

The window check gives anti-replay protection: any captured request becomes
useless once the timestamp ages past the window.

## Configuration

The agent-api server reads three env vars (see `agent/.env.example`):

```bash
HMAC_SECRET=...            # openssl rand -hex 32
HMAC_KEY_ID=default        # stable identifier, allows rotation later
HMAC_WINDOW_SECONDS=300    # default 300; tighten to 60 for production
HMAC_AUTH_ENABLED=true     # set to false ONLY for local dev
```

When `HMAC_AUTH_ENABLED=false`, the hook short-circuits and requests pass
without validation (logs a WARN at boot). `HMAC_SECRET` / `HMAC_KEY_ID`
are still required to be present, otherwise boot fails.

## Quick start

### 1. Generate a secret

```bash
openssl rand -hex 32
# e.g. 9b3d... (64 hex chars)
```

### 2. Put it in `.env` at the repo root (read by docker-compose)

```bash
HMAC_SECRET=9b3d...
HMAC_KEY_ID=local-dev
HMAC_WINDOW_SECONDS=300
```

### 3. `make up` and verify

```bash
make up
make logs-agent-api    # look for "HMAC auth enabled" or boot error
```

### 4. Open the UI

The browser UI fetches `/api/auth/config` on load, signs each stream request
automatically, and you should see streaming tokens as usual.

## Calling the API from outside the UI

### curl

```bash
HMAC_SECRET='9b3d...'
KEY_ID='local-dev'
PATH_='/api/chat/stream'
QUERY='q=hola&session_id=abc'
TS=$(date +%s)
BODY_HASH=$(printf '' | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf '%s\nGET\n%s\n%s' "$TS" "$PATH_" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $2}')

curl -N "http://localhost:3002${PATH_}?${QUERY}" \
  -H "X-Floci-Timestamp: $TS" \
  -H "X-Floci-Key-Id: $KEY_ID" \
  -H "X-Floci-Signature: $SIG" \
  -H "Accept: text/event-stream"
```

### Python helper

```python
import hashlib, hmac, time, requests

SECRET = bytes.fromhex("9b3d...")  # or just b"..." if not hex
KEY_ID = "local-dev"
BASE = "http://localhost:3002"

def signed_headers(method: str, path: str, body: bytes = b"") -> dict:
    ts = str(int(time.time()))
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = f"{ts}\n{method.upper()}\n{path}\n{body_hash}".encode()
    sig = hmac.new(SECRET, canonical, hashlib.sha256).hexdigest()
    return {
        "X-Floci-Timestamp": ts,
        "X-Floci-Key-Id": KEY_ID,
        "X-Floci-Signature": sig,
    }

def stream_chat(question: str):
    path = "/api/chat/stream"
    headers = signed_headers("GET", path)
    headers["Accept"] = "text/event-stream"
    with requests.get(BASE + path, params={"q": question}, headers=headers, stream=True) as r:
        r.raise_for_status()
        for line in r.iter_lines(decode_unicode=True):
            if line:
                print(line)
```

### Browser / Web Crypto

The bundled `public/script.js` already implements this — see
`signRequest()` / `sha256Hex()` / `hmacSha256Hex()` near the top.

## Tests

22 unit tests cover happy path, replay window expiry, body/path/method
mutation, key-id mismatch, malformed signatures, header case-insensitivity,
and `loadHmacConfigFromEnv` edge cases:

```bash
cd agent
yarn test
```

## Why HMAC instead of bearer tokens?

| Concern | Bearer JWT | HMAC (this) |
|---|---|---|
| Stateless | yes | yes |
| Server can rotate without client redeploy | no (new token) | yes (change secret, client keeps using same algorithm) |
| Replay protection | requires nonce store or jti | timestamp window, no state |
| Body integrity | not signed | signed into canonical |
| Verifiability | requires signature key + claim checks | single HMAC compare |

HMAC is the right primitive when both ends share a secret and you want the
server to be able to prove the body wasn't tampered with. JWT wins when you
need claims (user id, scopes) embedded in the token.

## Rotation

When the secret needs to change:

1. Add a new `Key-Id` to a future multi-secret map (`v2.x`).
2. The server accepts both old and new during the rollover window.
3. Switch all clients to the new Key-Id.
4. Remove the old secret.

The header-driven lookup already supports this; only the secret resolver
needs to grow from `string → Record<KeyId, string>`.

## Security notes

- **The `/api/auth/config` endpoint serves the secret to the browser.**
  This is acceptable for local dev and demos. For production, replace it
  with `POST /api/auth/token` that signs server-side — planned for v1.3.x.
- **The window check tolerates clock skew** of up to `HMAC_WINDOW_SECONDS`
  in either direction. Use NTP in production.
- **Constant-time comparison** is enforced server-side via
  `crypto.timingSafeEqual`. Don't substitute `===`.
- **The `Key-Id` is part of the signature payload only by convention**
  (server checks it before recomputing). It is not bound into the canonical
  string — that's fine for a single-secret model but means a multi-secret
  server must validate Key-Id first, then verify signature.
