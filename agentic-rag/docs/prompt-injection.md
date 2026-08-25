# Prompt Injection Defense (v1.4.0)

PRD section 4 H-06 found that the agent had no defenses against
prompt injection (OWASP LLM01). The fix is layered: input
filtering at the edge, content demarcation in the prompt, and a
grounding check on the way out. Each layer is intentionally
limited and the layering is what makes the system robust against
attacks that succeed against any single layer.

## Threat model

Three classes of attack reach our LLM:

1. **Direct injection** — the user types an adversarial prompt.
   Cheap to launch, easy to filter, but bypassable by
   paraphrase.
2. **Indirect injection via tool output** — an attacker
   controls a chunk in the RAG knowledge base and smuggles
   instructions inside its text. Harder to launch (requires
   write access to the corpus), trivial to launch at scale if
   the corpus is open (Confluence, S3, public docs).
3. **Indirect injection via future ingestion** — same vector,
   but the poisoned text arrives through the S3 ingestion
   pipeline. Mitigation lands in v1.5.x alongside that pipeline
   (SEC-21 in the PRD).

## The three layers

```
request → [SEC-18 input guard] → /api/chat + /api/chat/stream
            ↓ on pass
        Ollama chat loop
            ↓ tool call
        MCP search_documents → raw text
            ↓
        [SEC-19 context wrap] → <<CONTEXT_*>> ... <<CONTEXT_END>>
            ↓
        Ollama continues (model has been told to ignore instructions
                          inside CONTEXT blocks via the system prompt)
            ↓
        final assistant message
            ↓
        [SEC-20 grounding] → cited → response
                           → not cited → abstention (RF-02)
            ↓
        client / persisted session
```

### SEC-18 — input guardrails

File: `agent/src/security/inputGuard.ts` — `assessPrompt(input)`.

- **Length cap**: 4000 characters by default. Defends partially
  against LLM10 (unbounded consumption) at the request level.
- **Pattern detector**: 5 default regex patterns (`ignore_prior_instructions`,
  `disregard_prior`, `you_are_now`, `system_role_tag`, `reveal_system_prompt`)
  plus caller-supplied extras. Each blocked reason has a stable
  id so we can track firing rates without logging the prompt
  itself (SEC-16).
- **Returns** `{ ok: true, normalized }` or
  `{ ok: false, reason }` where `reason` is one of
  `empty_input | max_length | pattern:<id>`.

Limitations:

- The regex set is conservative. A paraphrased attack
  ("descarta todo lo anterior") evades it. We rely on the next
  two layers to handle that case.
- Unicode lookalikes, base64-encoded instructions, and other
  encoding tricks are not detected. LLM-side guardrails (Bedrock
  Guardrails in v2.0) are the planned second line.

### SEC-19 — context delimiters

Files:
- `agent/src/agent/contextWrap.ts` — `wrapContextBlock`,
  `extractContextSources`.
- `agent/src/agent/llm.ts` — wraps every `messages.push({ role: "tool", content })`.

Every tool result is wrapped:

```
<<CONTEXT_START tool="search_documents" sources=["policy-vacaciones.md","policy-codereview.md"]>>
...raw JSON returned by the tool...
<<CONTEXT_END>>
```

The system prompt is updated with a "Tratamiento del contenido
recuperado" section that names the markers and instructs the
model to treat the block as untrusted data, not as instructions.
This is what closes the LLM01 ambiguity at the prompt level.

The wrap function deliberately:

- Keeps the header on a single line so a chunk containing
  `<<CONTEXT_END>>` inside its payload cannot prematurely close
  the wrapper.
- Surfaces declared sources in a JSON-parseable header so the
  grounding check (SEC-20) can read them without parsing the
  raw payload.
- Never edits the payload — the orchestrator is not the
  censor. If a chunk contains dangerous text, it goes through
  verbatim; the system prompt is what tells the model to
  ignore it. This avoids the trap of accidentally sanitising
  legitimate but unusual content.

### SEC-20 — grounding verification

Files:
- `agent/src/agent/grounding.ts` — `enforceGrounding`.
- `agent/src/agent/llm.ts` — collects sources across tool calls
  and applies the check before emitting `done`.

The final assistant message must cite at least one of the
sources declared by the tools used during the conversation.
Citation matching is case-insensitive and accepts the basename
of a path (so `"policy-vacaciones.md"` matches
`"docs/policies/policy-vacaciones.md"`).

If the response does not cite any declared source, it is
substituted with the abstention message:

> No he podido encontrar información fundamentada en la base de
> conocimiento para responder a esta pregunta. Por favor
> reformula la consulta o verifica si el tema está cubierto en
> los documentos disponibles.

Clients receive an `abstain` SSE event on the streaming
endpoint, with `done.grounded === false` and a "· sin
fundamento" tag in the meta line. The non-streaming endpoint
returns `grounded: false` in the JSON body.

RF-02 permits general-knowledge answers without citations, so
the check is a no-op when no tools were used.

### SEC-24 — adversarial test suite

File: `agent/test/security/adversarial.test.ts` — 21 cases,
with Ollama and mcp-client mocked so the suite runs in CI
without the stack.

Coverage:

- **Direct injection**: 5 textbook payloads + 1 negative case
  for legitimate questions mentioning trigger words.
- **Indirect injection via context wrap**: poisoned chunk
  preservation, escape-attempt via injected `<<CONTEXT_END>>`,
  source extraction under wrap.
- **Grounding evasion**: no citation, basename citation,
  paraphrased citation, citation to unrelated document.
- **Integrated pipeline**: clean question → grounded, no
  citation → abstention, poisoned chunk + model ignores
  citation → still abstained by SEC-20, chit-chat → grounded.
- **Documented limitations**: regex bypass by paraphrasing,
  missing `source` field in tool output.

The suite is the regression net for the three layers. Any
change to `inputGuard.ts`, `contextWrap.ts`, `grounding.ts`, or
the relevant calls in `llm.ts` must come with a corresponding
test case here.

## Operational notes

- **No new env vars**. The defenses are on by default and have
  no toggle. Adding a `H06_ENABLED=false` escape hatch would
  re-introduce H-06 — do not add one.
- **No telemetry yet**. Blocked prompts are logged with reason
  id and `q_len` only (SEC-16). Wiring this into a metrics
  pipeline is on the v2.0 roadmap; for now, grep the logs.
- **No persistent memory of the model**. We don't store the
  full assistant response unless `grounded === true`; on
  abstention the persisted `last_response` is the abstention
  message itself, so the session history does not carry
  ungrounded answers.

## Out of scope (v1.4.x and later)

- **SEC-21 — Ingestion validation with quarantine**. Will land
  in v1.5.x with the S3 ingestion pipeline. The plan is to
  run incoming documents through a quarantine stage that
  rejects anything with known injection patterns, length
  anomalies, or unexpected MIME types, before they reach
  `search_documents`.
- **LLM-side guardrails**. Bedrock Guardrails (or equivalent)
  land in v2.0 with the Ollama → Bedrock swap. They give us a
  second, model-level filter on both input and output, with
  configurable topic deny-lists and PII redaction.
- **Source visibility in the UI**. The current `· sin
  fundamento` tag tells the user the response was substituted
  but does not show which sources were used. Surfacing the
  cited sources in the message meta is a UX follow-up.