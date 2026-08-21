// Agentic RAG UI — wired to agent-api-server (Fastify SSE)
//
// Endpoints:
//   POST /api/sessions                       → { session_id, created_at }
//   GET  /api/sessions/:id                   → { ... } | 404
//   GET  /api/chat/stream?q=...&session_id=...  → SSE
//
// SSE events:
//   token       → { token: "ch" }
//   tool_call   → { name, args }
//   tool_result → { name, result, ms }
//   done        → { session_id, iterations, totalMs }
//   error       → { message }

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
    const url = `/api/chat/stream?q=${encodeURIComponent(question)}&session_id=${encodeURIComponent(sessionId)}`;
    const es = new EventSource(url);

    // Prepare a live assistant bubble that we update as tokens arrive
    let assistant = addMessage('assistant', '');
    let buffer = '';

    const typingId = addTypingIndicator();
    assistant.wrapper.hidden = true; // hide the empty placeholder until first token

    es.addEventListener('token', (ev) => {
        const { token } = JSON.parse(ev.data);
        buffer += token;
        // Replace typing indicator with the assistant bubble on first token
        const t = document.getElementById(typingId);
        if (t) {
            t.remove();
            assistant.wrapper.hidden = false;
            // Re-grab contentEl since it was just appended (still valid ref)
        }
        assistant.contentEl.textContent = buffer;
        scrollToBottom();
    });

    es.addEventListener('tool_call', (ev) => {
        const { name } = JSON.parse(ev.data);
        // Optional: append a small inline badge to the assistant body
        const badge = document.createElement('div');
        badge.className = 'message-meta';
        badge.textContent = `🔧 ${name}`;
        assistant.wrapper.querySelector('.message-body').appendChild(badge);
    });

    es.addEventListener('tool_result', (ev) => {
        const { name, ms } = JSON.parse(ev.data);
        const badges = assistant.wrapper.querySelectorAll('.message-meta');
        const last = badges[badges.length - 1];
        if (last && last.textContent.startsWith('🔧')) {
            last.textContent = `🔧 ${name} · ${ms}ms`;
        }
    });

    es.addEventListener('done', (ev) => {
        const meta = JSON.parse(ev.data);
        // Add final meta line
        const metaEl = document.createElement('div');
        metaEl.className = 'message-meta';
        const sec = (meta.totalMs / 1000).toFixed(1);
        metaEl.textContent = `${meta.iterations} iter · ${sec}s`;
        assistant.wrapper.querySelector('.message-body').appendChild(metaEl);
        es.close();
        activeStream = null;
        setBusy(false);
    });

    es.addEventListener('error', (ev) => {
        if (es.readyState === EventSource.CLOSED) return;
        const t = document.getElementById(typingId);
        if (t) t.remove();
        assistant.wrapper.hidden = false;
        assistant.contentEl.textContent = buffer || '(sin respuesta)';
        const errEl = document.createElement('div');
        errEl.className = 'message-error';
        errEl.textContent = '⚠ Stream interrupted';
        assistant.wrapper.querySelector('.message-body').appendChild(errEl);
        es.close();
        activeStream = null;
        setBusy(false);
    });
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
initSession().then(() => composerInput.focus());
