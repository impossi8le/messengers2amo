const state = {
  status: null,
  chats: [],
  activeChatId: null,
  messages: [],
  filterText: '',
  latestSnapshotId: null,
  typingSnapshotId: null,
  isPolling: false,
  isSending: false
};

const AVATAR_COLORS = ['#e17076', '#7bc862', '#6ec9cb', '#65aadd', '#a695e7', '#ee7aae', '#faa774'];
function getAvatarColor(str) {
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) hash = (hash * 31 + str.charCodeAt(i)) & 0xffffff;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function validateTelegramUsername(username) {
  return typeof username === 'string' && /^[a-zA-Z0-9_]{5,32}$/.test(username);
}

const dom = {
  appLayout: document.getElementById('appLayout'),
  demoBadge: document.getElementById('demoBadge'),
  statusBadge: document.getElementById('statusBadge'),
  demoIncomingBtn: document.getElementById('demoIncomingBtn'),
  chatSearch: document.getElementById('chatSearch'),
  chatList: document.getElementById('chatList'),
  chatView: document.getElementById('chatView'),
  noChatSelected: document.getElementById('noChatSelected'),
  botLink: document.getElementById('botLink'),
  activeChat: document.getElementById('activeChat'),
  backBtn: document.getElementById('backBtn'),
  activeChatAvatar: document.getElementById('activeChatAvatar'),
  activeChatTitle: document.getElementById('activeChatTitle'),
  activeChatSubtitle: document.getElementById('activeChatSubtitle'),
  messageList: document.getElementById('messageList'),
  composerError: document.getElementById('composerError'),
  composerInput: document.getElementById('composerInput'),
  sendBtn: document.getElementById('sendBtn')
};

function renderStatus() {
  const s = state.status;
  if (!s) return;
  dom.demoBadge.hidden = s.mode !== 'demo';
  dom.demoIncomingBtn.hidden = s.mode !== 'demo';
  
  if (s.error) {
    dom.statusBadge.textContent = 'Ошибка: ' + s.error;
    dom.statusBadge.className = 'badge badge-err';
  } else {
    const botLabel = s.bot?.name || (s.bot?.username ? '@' + s.bot.username : null);
    const labels = { ready: 'Готов', polling: 'Подключен', initializing: 'Подключение', retrying: 'Повтор подключения', blocked: 'Остановлено' };
    const connectionLabel = labels[s.state] || 'Проверка подключения';
    dom.statusBadge.textContent = botLabel ? `${botLabel} · ${connectionLabel}` : connectionLabel;
    dom.statusBadge.className = 'badge badge-ok';
  }

  if (s.bot?.username && validateTelegramUsername(s.bot.username)) {
    dom.botLink.href = `https://t.me/${s.bot.username}`;
    dom.botLink.textContent = `@${s.bot.username}`;
    dom.botLink.hidden = false;
  } else {
    dom.botLink.hidden = true;
  }
}

function renderChats() {
  dom.chatList.textContent = '';
  const q = state.filterText.trim().toLowerCase();
  const filtered = state.chats.filter(c => {
    const title = (c.title || '').toLowerCase();
    const user = (c.username || '').toLowerCase();
    return !q || title.includes(q) || user.includes(q);
  });

  filtered.forEach(chat => {
    const item = document.createElement('button');
    item.type = 'button';
    item.style.width = '100%';
    item.style.textAlign = 'left';
    item.style.font = 'inherit';
    item.style.color = 'inherit';
    item.style.border = '0';
    item.className = 'chat-item' + (chat.id === state.activeChatId ? ' active' : '');
    item.setAttribute('aria-pressed', String(chat.id === state.activeChatId));

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    const name = chat.title || chat.username || 'Чат';
    avatar.textContent = name.trim()[0]?.toUpperCase() || '?';
    avatar.style.backgroundColor = getAvatarColor(String(chat.id));

    const info = document.createElement('div');
    info.className = 'chat-info';

    const topRow = document.createElement('div');
    topRow.className = 'chat-row-top';
    const titleEl = document.createElement('span');
    titleEl.className = 'chat-item-title';
    titleEl.textContent = name;
    const timeEl = document.createElement('span');
    timeEl.className = 'chat-item-time';
    timeEl.textContent = formatTime(chat.lastMessageAt);
    topRow.appendChild(titleEl);
    topRow.appendChild(timeEl);

    const btmRow = document.createElement('div');
    btmRow.className = 'chat-row-bottom';
    const preview = document.createElement('span');
    preview.className = 'chat-item-preview';
    preview.textContent = chat.lastMessage || (chat.username ? '@' + chat.username : '');
    btmRow.appendChild(preview);

    if (chat.unansweredCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'waiting-badge';
      badge.textContent = String(chat.unansweredCount);
      btmRow.appendChild(badge);
    }

    info.appendChild(topRow);
    info.appendChild(btmRow);
    item.appendChild(avatar);
    item.appendChild(info);

    item.addEventListener('click', () => selectChat(chat.id));
    dom.chatList.appendChild(item);
  });
}

function renderMessages(forceBottom = false) {
  const list = dom.messageList;
  const prevScrollTop = list.scrollTop;
  const isNearBottom = list.scrollHeight - prevScrollTop - list.clientHeight < 60;
  list.textContent = '';

  state.messages.forEach(msg => {
    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${msg.direction === 'out' ? 'out' : 'in'}`;
    bubble.textContent = msg.text || '';

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const time = document.createElement('span');
    time.textContent = formatTime(msg.createdAt);
    meta.appendChild(time);

    if (msg.direction === 'out') {
      const st = document.createElement('span');
      const s = msg.status || 'unknown';
      st.className = `msg-status ${s}`;
      const statusLabels = { sent: 'Отправлено', sending: 'Отправляется', failed: 'Не отправлено', unknown: 'Результат неизвестен', demo: 'Демо · без отправки' };
      st.textContent = (statusLabels[s] || 'Результат неизвестен') + (msg.error ? ': ' + msg.error : '');
      meta.appendChild(st);
    }

    bubble.appendChild(meta);
    list.appendChild(bubble);
  });

  if (forceBottom || isNearBottom) {
    list.scrollTop = list.scrollHeight;
  } else {
    list.scrollTop = prevScrollTop;
  }
}

async function selectChat(chatId) {
  if (state.activeChatId === chatId) return;
  state.activeChatId = chatId;
  state.typingSnapshotId = null;
  state.latestSnapshotId = null;
  state.messages = [];
  renderMessages(true);
  dom.sendBtn.disabled = true;
  dom.composerInput.disabled = true;
  dom.composerError.hidden = true;
  dom.composerInput.value = '';

  if (!chatId) {
    dom.appLayout.classList.remove('chat-open');
    dom.activeChat.hidden = true;
    dom.noChatSelected.hidden = false;
    renderChats();
    return;
  }

  dom.appLayout.classList.add('chat-open');
  dom.noChatSelected.hidden = true;
  dom.activeChat.hidden = false;

  const currentChat = state.chats.find(c => c.id === chatId);
  const chatName = currentChat?.title || currentChat?.username || 'Диалог';
  dom.activeChatTitle.textContent = chatName;
  dom.activeChatSubtitle.textContent = currentChat?.username ? `@${currentChat.username}` : '';
  dom.activeChatAvatar.textContent = chatName.trim()[0]?.toUpperCase() || '?';
  dom.activeChatAvatar.style.backgroundColor = getAvatarColor(String(chatId));

  renderChats();
  await fetchMessages(chatId, true);
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('status error');
    state.status = await res.json();
    renderStatus();
  } catch {
    dom.statusBadge.textContent = 'Ошибка сети';
    dom.statusBadge.className = 'badge badge-err';
  }
}

async function fetchChats() {
  try {
    const res = await fetch('/api/chats');
    if (!res.ok) throw new Error('chats error');
    const data = await res.json();
    state.chats = Array.isArray(data.chats) ? data.chats : [];
    renderChats();
  } catch {
    dom.statusBadge.textContent = 'Не удалось обновить список чатов';
    dom.statusBadge.className = 'badge badge-err';
  }
}

async function fetchMessages(chatId, forceBottom = false) {
  if (!chatId) return;
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`);
    if (!res.ok) throw new Error('messages error');
    const data = await res.json();
    if (state.activeChatId !== chatId) return;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.latestSnapshotId = data.snapshotId ?? null;
    dom.sendBtn.disabled = state.isSending || !state.latestSnapshotId;
    dom.composerInput.disabled = state.isSending || !state.latestSnapshotId;
    renderMessages(forceBottom);
  } catch {
    if (state.activeChatId === chatId) {
      dom.composerError.textContent = 'Не удалось обновить сообщения. Проверьте соединение.';
      dom.composerError.hidden = false;
    }
  }
}

async function sendMessage() {
  const text = dom.composerInput.value.trim();
  if (!text || !state.activeChatId || state.isSending || !state.latestSnapshotId) return;

  state.isSending = true;
  dom.sendBtn.disabled = true;
  dom.composerInput.disabled = true;
  dom.composerError.hidden = true;

  const clientRequestId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);

  const snapshotId = state.typingSnapshotId ?? state.latestSnapshotId;
  const payload = { text, clientRequestId, ...(snapshotId ? { snapshotId } : {}) };
  const chatId = state.activeChatId;

  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json();
    if (!res.ok) {
      if (state.activeChatId === chatId) {
        dom.composerError.textContent = data.error || 'Сервер отклонил запрос.';
        dom.composerError.hidden = false;
      }
      await fetchMessages(chatId, true);
      return;
    }
    const result = data.message;
    if (state.activeChatId === chatId) {
      if (result?.status === 'sent' || result?.status === 'demo') {
        dom.composerInput.value = '';
        state.typingSnapshotId = null;
      } else {
        dom.composerError.textContent = result?.status === 'failed'
          ? (result.error || 'Telegram отклонил отправку.')
          : 'Результат отправки неизвестен. Сообщение могло быть отправлено. Проверьте историю перед повторной отправкой.';
        dom.composerError.hidden = false;
      }
    }
    await fetchMessages(chatId, true);
    await fetchChats();
  } catch {
    await fetchMessages(chatId, false);
    await fetchChats();
    if (state.activeChatId === chatId) {
      dom.composerError.textContent = 'Нет подтверждения отправки. Сообщение могло быть отправлено. Проверьте историю перед повторной отправкой.';
      dom.composerError.hidden = false;
    }
  } finally {
    state.isSending = false;
    dom.sendBtn.disabled = !state.latestSnapshotId;
    dom.composerInput.disabled = !state.latestSnapshotId;
    dom.composerInput.focus();
  }
}

async function simulateIncoming() {
  try {
    dom.demoIncomingBtn.disabled = true;
    await fetch('/api/demo/incoming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: state.activeChatId || undefined, text: 'Тестовое входящее сообщение' })
    });
    await fetchChats();
    if (state.activeChatId) await fetchMessages(state.activeChatId, true);
  } catch {
    // safe
  } finally {
    dom.demoIncomingBtn.disabled = false;
  }
}

async function pollLoop() {
  if (!state.isPolling) {
    state.isPolling = true;
    try {
      await fetchStatus();
      await fetchChats();
      if (state.activeChatId) await fetchMessages(state.activeChatId, false);
    } catch {
      // safe
    } finally {
      state.isPolling = false;
    }
  }
  setTimeout(pollLoop, 3000);
}

dom.composerInput.addEventListener('input', () => {
  if (state.typingSnapshotId === null) {
    state.typingSnapshotId = state.latestSnapshotId;
  }
});

dom.composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

dom.sendBtn.addEventListener('click', sendMessage);
dom.backBtn.addEventListener('click', () => selectChat(null));
dom.demoIncomingBtn.addEventListener('click', simulateIncoming);
dom.chatSearch.addEventListener('input', (e) => {
  state.filterText = e.target.value;
  renderChats();
});

(async function init() {
  await fetchStatus();
  await fetchChats();
  setTimeout(pollLoop, 3000);
})();
