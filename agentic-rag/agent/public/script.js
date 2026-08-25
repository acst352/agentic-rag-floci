// Agentic RAG UI — wired to agent-api-server (Fastify SSE)
//
// Endpoints:
//   POST /api/sessions                       → { session_id, created_at }
//   GET  /api/sessions/:id                   → { ... } | 404
//   GET  /api/chat/stream?q=...&session_id=...  → SSE (HMAC signed, v1.1.0+)
//
// SSE events:
//   token       → { token: "ch" }
//   tool_call   → { name, args }
//   tool_result → { name, result, ms }
//   done        → { session_id, iterations, totalMs }
//   error       → { message }
//
// HMAC auth (v1.2):
//   Bootstrap (dev only): GET /api/auth/config → { keyId, secret, windowSeconds, enabled }
//   For each /api/chat/stream request, compute HMAC-SHA256 over:
//     `${timestamp}\n${method}\n${pathWithSortedQuery}\n${sha256(body)}`
//   Headers: X-Floci-Timestamp, X-Floci-Key-Id, X-Floci-Signature.
//   pathWithSortedQuery incluye la query string ordenada alfabéticamente.
//   Implementation uses Web Crypto (SubtleCrypto) — no external deps.

const sidebar = document.getElementById('sidebar');
const toggleSidebar = document.getElementById('toggleSidebar');
const toggleSidebarMobile = document.getElementById('toggleSidebarMobile');
const newChatBtn = document.getElementById('newChatBtn');
const composerForm = document.getElementById('composerForm');
const composerInput = document.getElementById('composerInput');
const sendBtn = document.getElementById('sendBtn');
const messages = document.getElementById('messages');
const welcomeScreen = document.getElementById('welcomeScreen');
const chatContainer = document.getElementById('chatContainer');
const suggestions = document.querySelectorAll('.suggestion-card');
const sessionIdDisplay = document.getElementById('session-id-display');

let sessionId = null;
let activeStream = null;
let busy = false;

const HMAC_TS_HEADER = 'X-Floci-Timestamp';
const HMAC_KEY_HEADER = 'X-Floci-Key-Id';
const HMAC_SIG_HEADER = 'X-Floci-Signature';
const HMAC_NONCE_HEADER = 'X-Floci-Nonce';
// v1.3 H-03: identidad lógica del llamante, firmada en la cadena
// canónica. En dev es el HMAC_KEY_ID; en producción será el `sub`
// del OIDC.
const HMAC_SUBJ_HEADER = 'X-Floci-Subject';

let hmacConfig = null;

async function sha256Hex(input) {
    const bytes = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function hmacSha256Hex(secret, input) {
    const keyBytes = new TextEncoder().encode(secret);
    const key = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const data = new TextEncoder().encode(input);
    const sig = await crypto.subtle.sign('HMAC', key, data);
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * v1.2 H-04: ordena alfabéticamente los pares clave=valor de la query
 * string para que la firma sea estable independientemente del orden
 * de llegada de los parámetros en la URL.
 */
function canonicalizePath(path) {
    const qIdx = path.indexOf('?');
    if (qIdx === -1) return path;
    const pathname = path.slice(0, qIdx);
    const query = path.slice(qIdx + 1);
    const params = Array.from(new URLSearchParams(query).entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return `${pathname}?${params}`;
}

/**
 * v1.2 H-05: genera un nonce único por request. crypto.randomUUID()
 * está disponible en navegadores modernos y en contextos seguros.
 */
function generateNonce() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    // Fallback improbable (browsers modernos lo soportan)
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function signRequest(method, pathWithQuery, body) {
    if (!hmacConfig || !hmacConfig.enabled) return {};
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = generateNonce();
    const bodyStr = body ?? '';
    const bodyHash = await sha256Hex(bodyStr);
    const canonicalPath = canonicalizePath(pathWithQuery);
    // v1.3 H-03: el subject entra en la cadena canónica como quinto
    // campo. Si no llega del bootstrap (versión v1.2.x), caemos al
    // keyId para preservar la compatibilidad transitoria.
    const subject = hmacConfig.subject ?? hmacConfig.keyId ?? '';
    const canonical = `${timestamp}\n${method.toUpperCase()}\n${canonicalPath}\n${bodyHash}\n${subject}`;
    const signature = await hmacSha256Hex(hmacConfig.secret, canonical);
    return {
        [HMAC_TS_HEADER]: String(timestamp),
        [HMAC_KEY_HEADER]: hmacConfig.keyId,
        [HMAC_NONCE_HEADER]: nonce,
        [HMAC_SIG_HEADER]: signature,
        [HMAC_SUBJ_HEADER]: subject,
    };
}

async function bootstrapHmac() {
    try {
        const r = await fetch('/api/auth/config', { cache: 'no-store' });
        if (r.status === 204) {
            hmacConfig = { enabled: false };
            return;
        }
        if (!r.ok) throw new Error(`GET /api/auth/config → ${r.status}`);
        hmacConfig = await r.json();
        if (!hmacConfig.enabled) {
            hmacConfig = { enabled: false };
        }
    } catch (err) {
        console.error('HMAC bootstrap failed; UI will fail to sign stream requests', err);
        hmacConfig = { enabled: false };
    }
}

// ─── Sidebar ────────────────────────────────────────────────
toggleSidebar.addEventListener('click', () => {
    sidebar.classList.add('collapsed');
});

toggleSidebarMobile.addEventListener('click', () => {
    sidebar.classList.toggle('open');
});

document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 &&
        sidebar.classList.contains('open') &&
        !sidebar.contains(e.target) &&
        e.target !== toggleSidebarMobile &&
        !toggleSidebarMobile.contains(e.target)) {
        sidebar.classList.remove('open');
    }
});

// ─── Composer ───────────────────────────────────────────────
composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 200) + 'px';
    sendBtn.disabled = composerInput.value.trim().length === 0 || busy;
});

composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        composerForm.dispatchEvent(new Event('submit'));
    }
});

// ─── Init session ───────────────────────────────────────────
async function initSession() {
    try {
        const r = await fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!r.ok) throw new Error(`POST /api/sessions → ${r.status}`);
        const data = await r.json();
        sessionId = data.session_id;
        sessionIdDisplay.textContent = sessionId;
    } catch (err) {
        console.error('initSession failed', err);
        sessionIdDisplay.textContent = 'error';
    }
}

// ─── Helpers ────────────────────────────────────────────────
function hideWelcome() {
    welcomeScreen.style.display = 'none';
}

function showWelcome() {
    welcomeScreen.style.display = 'flex';
}

function setBusy(state) {
    busy = state;
    sendBtn.disabled = state || composerInput.value.trim().length === 0;
    composerInput.disabled = state;
    newChatBtn.disabled = state;
}

function scrollToBottom() {
    setTimeout(() => {
        chatContainer.scrollTo({
            top: chatContainer.scrollHeight,
            behavior: 'smooth'
        });
    }, 50);
}

function addMessage(role, content, meta) {
    const wrapper = document.createElement('div');
    wrapper.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? 'Tú' : 'AI';

    const body = document.createElement('div');
    body.className = 'message-body';

    const name = document.createElement('div');
    name.className = 'message-name';
    name.textContent = role === 'user' ? 'Tú' : 'Agentic RAG';

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';
    messageContent.textContent = content;

    body.appendChild(name);
    body.appendChild(messageContent);

    if (role === 'assistant' && meta) {
        const metaEl = document.createElement('div');
        metaEl.className = 'message-meta';
        const sec = (meta.totalMs / 1000).toFixed(1);
        metaEl.textContent = `${meta.iterations} iter · ${sec}s`;
        body.appendChild(metaEl);
    }

    if (role === 'assistant') {
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = `
            <button class="message-action-btn" title="Copiar">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
            </button>`;
        body.appendChild(actions);

        actions.querySelector('[title="Copiar"]').addEventListener('click', () => {
            navigator.clipboard.writeText(content).then(() => {
                const btn = actions.querySelector('[title="Copiar"]');
                btn.style.color = 'var(--accent)';
                setTimeout(() => btn.style.color = '', 1000);
            });
        });
    }

    wrapper.appendChild(avatar);
    wrapper.appendChild(body);
    messages.appendChild(wrapper);

    scrollToBottom();
    return { wrapper, contentEl: messageContent };
}

function addTypingIndicator() {
    const id = 'typing-' + Date.now();
    const wrapper = document.createElement('div');
    wrapper.className = 'message assistant';
    wrapper.id = id;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = 'AI';

    const body = document.createElement('div');
    body.className = 'message-body';

    const name = document.createElement('div');
    name.className = 'message-name';
    name.textContent = 'Agentic RAG';

    const typing = document.createElement('div');
    typing.className = 'typing-indicator';
    typing.innerHTML = '<span></span><span></span><span></span>';

    body.appendChild(name);
    body.appendChild(typing);
    wrapper.appendChild(avatar);
    wrapper.appendChild(body);
    messages.appendChild(wrapper);
    scrollToBottom();

    return id;
}

function replaceTypingWithMessage(id, content, meta) {
    const typing = document.getElementById(id);
    if (!typing) return addMessage('assistant', content, meta);
    typing.remove();
    return addMessage('assistant', content, meta);
}

// ─── SSE parsing ───────────────────────────────────────────
function parseSseStream(reader, handlers) {
    const decoder = new TextDecoder();
    let buffer = '';

    function processEvent(eventName, dataLine) {
        const handler = handlers[eventName];
        if (!handler) return;
        try {
            const data = dataLine.startsWith('{') ? JSON.parse(dataLine) : dataLine;
            handler(data);
        } catch (err) {
            console.error('SSE parse error', eventName, err);
        }
    }

    return (async () => {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sep;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);

                let eventName = 'message';
                let dataLine = '';
                for (const line of rawEvent.split('\n')) {
                    if (line.startsWith('event:')) eventName = line.slice(6).trim();
                    else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
                }
                if (dataLine) processEvent(eventName, dataLine);
            }
        }
    })();
}

// ─── Submit → streaming ─────────────────────────────────────
composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = composerInput.value.trim();
    if (!text || busy) return;

    hideWelcome();
    addMessage('user', text);
    composerInput.value = '';
    composerInput.style.height = 'auto';
    setBusy(true);

    streamChat(text);
});

async function streamChat(question) {
    const path = '/api/chat/stream';
    const url = `${path}?q=${encodeURIComponent(question)}&session_id=${encodeURIComponent(sessionId)}`;

    let headers = { Accept: 'text/event-stream' };
    try {
        // v1.2 H-04: firmamos la URL completa con query string, que es
        // lo que enviaremos al servidor. El servidor ordena los
        // parámetros alfabéticamente antes de verificar la firma.
        const sig = await signRequest('GET', url, '');
        headers = { ...headers, ...sig };
    } catch (err) {
        console.error('Failed to sign request', err);
    }

    let response;
    try {
        response = await fetch(url, { method: 'GET', headers });
    } catch (err) {
        console.error('fetch failed', err);
        setBusy(false);
        return;
    }

    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        console.error(`stream failed: ${response.status}`, text);
        setBusy(false);
        return;
    }

    let assistant = addMessage('assistant', '');
    let buffer = '';
    const typingId = addTypingIndicator();
    assistant.wrapper.hidden = true;

    let done = false;

    const handlers = {
        token: ({ token }) => {
            buffer += token;
            const t = document.getElementById(typingId);
            if (t) {
                t.remove();
                assistant.wrapper.hidden = false;
            }
            assistant.contentEl.textContent = buffer;
            scrollToBottom();
        },
        tool_call: ({ name }) => {
            const badge = document.createElement('div');
            badge.className = 'message-meta';
            badge.textContent = `🔧 ${name}`;
            assistant.wrapper.querySelector('.message-body').appendChild(badge);
        },
        tool_result: ({ name, ms }) => {
            const badges = assistant.wrapper.querySelectorAll('.message-meta');
            const last = badges[badges.length - 1];
            if (last && last.textContent.startsWith('🔧')) {
                last.textContent = `🔧 ${name} · ${ms}ms`;
            }
        },
        done: (meta) => {
            done = true;
            const metaEl = document.createElement('div');
            metaEl.className = 'message-meta';
            const sec = (meta.totalMs / 1000).toFixed(1);
            const groundedTag = meta.grounded === false ? ' · sin fundamento' : '';
            metaEl.textContent = `${meta.iterations} iter · ${sec}s${groundedTag}`;
            assistant.wrapper.querySelector('.message-body').appendChild(metaEl);
            activeStream = null;
            setBusy(false);
        },
        // v1.4 H-06 / SEC-20: el servidor sustituye la respuesta por
        // una abstención cuando la fundamentación falla. El cliente
        // descarta los tokens emitidos y muestra el mensaje de
        // abstención; el evento `done` (arriba) lleva `grounded:false`.
        abstain: ({ message }) => {
            buffer = message ?? '';
            if (assistant && assistant.contentEl) {
                assistant.contentEl.textContent = buffer;
            }
        },
        error: ({ message }) => {
            const t = document.getElementById(typingId);
            if (t) t.remove();
            assistant.wrapper.hidden = false;
            assistant.contentEl.textContent = buffer || '(sin respuesta)';
            const errEl = document.createElement('div');
            errEl.className = 'message-error';
            errEl.textContent = `⚠ ${message}`;
            assistant.wrapper.querySelector('.message-body').appendChild(errEl);
            activeStream = null;
            setBusy(false);
        },
    };

    try {
        await parseSseStream(response.body.getReader(), handlers);
    } catch (err) {
        console.error('stream parse error', err);
    }

    if (!done) {
        const t = document.getElementById(typingId);
        if (t) t.remove();
        assistant.wrapper.hidden = false;
        assistant.contentEl.textContent = buffer || '(sin respuesta)';
        const errEl = document.createElement('div');
        errEl.className = 'message-error';
        errEl.textContent = '⚠ Stream interrupted';
        assistant.wrapper.querySelector('.message-body').appendChild(errEl);
        activeStream = null;
        setBusy(false);
    }
}

// ─── New chat ───────────────────────────────────────────────
newChatBtn.addEventListener('click', async () => {
    messages.innerHTML = '';
    showWelcome();
    if (window.innerWidth <= 768) sidebar.classList.remove('open');
    await initSession();
    composerInput.focus();
});

// ─── Suggestions ────────────────────────────────────────────
suggestions.forEach(card => {
    card.addEventListener('click', () => {
        const text = card.dataset.q;
        composerInput.value = text;
        composerInput.focus();
        sendBtn.disabled = false;
        composerInput.dispatchEvent(new Event('input'));
        composerForm.dispatchEvent(new Event('submit'));
    });
});

// ─── Boot ───────────────────────────────────────────────────
(async () => {
    await bootstrapHmac();
    await initSession();
    composerInput.focus();
})();
