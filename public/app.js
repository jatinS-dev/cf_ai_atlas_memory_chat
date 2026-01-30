const messagesEl = document.getElementById('messages');
const formEl = document.getElementById('chat-form');
const inputEl = document.getElementById('message-input');
const sessionEl = document.getElementById('session-id');
const newSessionBtn = document.getElementById('new-session');

const SESSION_KEY = 'cf_ai_session_id';

function generateSessionId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `session-${Math.random().toString(36).slice(2)}`;
}

function getSessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = generateSessionId();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function setSessionId(id) {
  localStorage.setItem(SESSION_KEY, id);
  sessionEl.textContent = id;
}

function addMessage(role, content) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  message.textContent = content;
  messagesEl.appendChild(message);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadHistory() {
  const sessionId = getSessionId();
  setSessionId(sessionId);

  const response = await fetch(`/api/history?sessionId=${encodeURIComponent(sessionId)}`);
  if (!response.ok) return;
  const data = await response.json();
  if (!data?.messages) return;
  messagesEl.innerHTML = '';
  if (data.messages.length === 0) {
    addMessage('assistant', 'Hi! Ask me anything about Cloudflare Workers or AI.');
    return;
  }
  data.messages.forEach((msg) => addMessage(msg.role, msg.content));
}

async function sendMessage(message) {
  const sessionId = getSessionId();
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const errorData = await response.json();
      const message = errorData?.detail
        ? `${errorData.error}: ${errorData.detail}`
        : errorData?.error || 'Request failed';
      throw new Error(message);
    }
    const errorText = await response.text();
    throw new Error(errorText || 'Request failed');
  }

  const data = await response.json();
  return data?.response ?? 'No response.';
}

formEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = inputEl.value.trim();
  if (!message) return;

  addMessage('user', message);
  inputEl.value = '';
  inputEl.focus();

  formEl.classList.add('loading');
  try {
    const reply = await sendMessage(message);
    addMessage('assistant', reply);
  } catch (error) {
    addMessage('assistant', 'Something went wrong. Please try again.');
    console.error(error);
  } finally {
    formEl.classList.remove('loading');
  }
});

newSessionBtn.addEventListener('click', async () => {
  const id = generateSessionId();
  setSessionId(id);
  messagesEl.innerHTML = '';
  addMessage('assistant', 'New session started. What should we explore?');
});

loadHistory();
