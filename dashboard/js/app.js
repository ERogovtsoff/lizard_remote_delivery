// Главная логика панели управления.
import { CONFIG } from './config.js';
import * as api from './api.js';
import * as catalog from './catalog.js';
import { escapeHtml, customerName, initial, formatTime, formatFullDate, previewText } from './utils.js';

let currentManager = null;     // { username, is_superadmin }
let chats = [];                // список чатов
let customersById = {};        // tg_id -> customer
let activeChatId = null;       // выбранный customer_tg_id
let refreshTimer = null;

// ============ АВТОРИЗАЦИЯ ============

function loadAuth() {
  try {
    const raw = localStorage.getItem(CONFIG.AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveAuth(mgr) {
  try { localStorage.setItem(CONFIG.AUTH_KEY, JSON.stringify(mgr)); } catch {}
}
function clearAuth() {
  try { localStorage.removeItem(CONFIG.AUTH_KEY); } catch {}
}

async function attemptLogin(username) {
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = 'Проверяем…';
  try {
    const mgr = await api.checkManager(username);
    if (!mgr) {
      errEl.textContent = 'Этот пользователь не найден среди менеджеров.';
      btn.disabled = false;
      btn.textContent = 'Войти';
      return;
    }
    currentManager = mgr;
    saveAuth(mgr);
    showApp();
  } catch (e) {
    console.error(e);
    errEl.textContent = 'Ошибка соединения. Попробуйте ещё раз.';
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

function logout() {
  clearAuth();
  currentManager = null;
  if (refreshTimer) clearInterval(refreshTimer);
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  document.getElementById('loginUsername').value = '';
  const btn = document.getElementById('loginBtn');
  btn.disabled = false;
  btn.textContent = 'Войти';
}

// ============ ПРИЛОЖЕНИЕ ============

function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('managerName').textContent = '@' + currentManager.username
    + (currentManager.is_superadmin ? ' · админ' : '');
  catalog.setupCatalog();
  setupSectionTabs();
  refreshChats();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshChats, CONFIG.REFRESH_INTERVAL);
}

let currentSection = 'chats';
function setupSectionTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.onclick = () => switchSection(tab.getAttribute('data-section'));
  });
}

function switchSection(section) {
  if (section === currentSection) return;
  currentSection = section;
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.getAttribute('data-section') === section));

  const isChats = section === 'chats';
  document.getElementById('chatList').style.display = isChats ? '' : 'none';
  document.getElementById('catalogSide').style.display = isChats ? 'none' : '';
  document.getElementById('sectionChats').style.display = isChats ? '' : 'none';
  document.getElementById('sectionCatalog').style.display = isChats ? 'none' : '';

  if (section === 'catalog') {
    catalog.loadCatalog();
  }
}

async function refreshChats() {
  try {
    chats = await api.loadChats();
    const ids = chats.map(c => c.customer_tg_id);
    customersById = await api.loadCustomers(ids);
    renderChatList();
    // Если открыт чат — обновим переписку (вдруг пришло новое)
    if (activeChatId != null) {
      // не сбрасываем прокрутку, если пользователь читает — обновляем мягко
      refreshConversation(activeChatId, /*keepScroll*/ true);
    }
  } catch (e) {
    console.error('refreshChats failed:', e);
  }
}

function renderChatList() {
  const list = document.getElementById('chatList');
  if (!chats.length) {
    list.innerHTML = `<div class="empty-hint">Пока нет ни одного чата.<br>Сообщения появятся, когда клиенты напишут боту.</div>`;
    return;
  }
  list.innerHTML = chats.map(chat => {
    const cust = customersById[chat.customer_tg_id];
    const name = customerName(cust, chat.customer_tg_id);
    const preview = previewText(chat.last_message);
    const time = formatTime(chat.last_message.created_at);
    const active = chat.customer_tg_id === activeChatId ? ' active' : '';
    const unread = chat.unread > 0
      ? `<span class="chat-unread">${chat.unread}</span>` : '';
    return `
      <div class="chat-item${active}" data-id="${chat.customer_tg_id}">
        <div class="chat-avatar">${escapeHtml(initial(name))}</div>
        <div class="chat-item-body">
          <div class="chat-item-top">
            <span class="chat-item-name">${escapeHtml(name)}</span>
            <span class="chat-item-time">${escapeHtml(time)}</span>
          </div>
          <div class="chat-item-bottom">
            <span class="chat-item-preview">${escapeHtml(preview)}</span>
            ${unread}
          </div>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.chat-item').forEach(el => {
    el.onclick = () => openChat(Number(el.getAttribute('data-id')));
  });
}

async function openChat(customerTgId) {
  activeChatId = customerTgId;
  renderChatList();   // подсветить активный
  document.getElementById('chatEmpty').style.display = 'none';
  document.getElementById('chatView').style.display = 'flex';

  const cust = customersById[customerTgId];
  const name = customerName(cust, customerTgId);
  document.getElementById('chatHeaderName').textContent = name;
  document.getElementById('chatHeaderId').textContent = 'ID ' + customerTgId;
  document.getElementById('chatHeaderAvatar').textContent = initial(name);

  await refreshConversation(customerTgId, /*keepScroll*/ false);

  // Пометить прочитанным + обновить список (убрать счётчик)
  await api.markRead(customerTgId);
  const chat = chats.find(c => c.customer_tg_id === customerTgId);
  if (chat) chat.unread = 0;
  renderChatList();
}

async function refreshConversation(customerTgId, keepScroll) {
  const box = document.getElementById('messages');
  const prevScrollBottom = box.scrollHeight - box.scrollTop;
  let msgs;
  try {
    msgs = await api.loadConversation(customerTgId);
  } catch (e) {
    box.innerHTML = `<div class="empty-hint">Не удалось загрузить переписку.</div>`;
    return;
  }

  let html = '';
  let lastDate = '';
  for (const m of msgs) {
    const dateLabel = formatFullDate(m.created_at);
    if (dateLabel !== lastDate) {
      html += `<div class="msg-date-sep">${escapeHtml(dateLabel)}</div>`;
      lastDate = dateLabel;
    }
    html += renderMessage(m);
  }
  box.innerHTML = html || `<div class="empty-hint">Сообщений пока нет.</div>`;

  // Прокрутка: при открытии — вниз; при фоновом обновлении — сохраняем позицию
  if (keepScroll) {
    box.scrollTop = box.scrollHeight - prevScrollBottom;
  } else {
    box.scrollTop = box.scrollHeight;
  }
}

function renderMessage(m) {
  const out = m.direction === 'out';
  const cls = out ? 'msg msg-out' : 'msg msg-in';
  let inner = '';

  // Вложение
  if (m.attachment_url) {
    if (m.attachment_type === 'photo') {
      inner += `<a href="${escapeHtml(m.attachment_url)}" target="_blank" rel="noopener">
        <img class="msg-photo" src="${escapeHtml(m.attachment_url)}" alt="фото" loading="lazy"></a>`;
    } else {
      const label = {
        document: '📎 Документ', video: '🎬 Видео', voice: '🎤 Голосовое',
        video_note: '⭕ Кружок', audio: '🎵 Аудио',
      }[m.attachment_type] || '📎 Вложение';
      inner += `<a class="msg-file" href="${escapeHtml(m.attachment_url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    }
  }
  // Текст
  if (m.text) {
    inner += `<div class="msg-text">${escapeHtml(m.text)}</div>`;
  }
  // Подпись: кто отправил (для исходящих — имя менеджера) + время
  const who = out
    ? (m.manager_username ? '@' + escapeHtml(m.manager_username) : 'менеджер')
    : '';
  const meta = `<div class="msg-meta">${who ? who + ' · ' : ''}${escapeHtml(formatTime(m.created_at))}</div>`;

  return `<div class="${cls}"><div class="msg-bubble">${inner}${meta}</div></div>`;
}

// ============ ИНИЦИАЛИЗАЦИЯ ============

function init() {
  // Обработчики входа
  document.getElementById('loginBtn').onclick = () => {
    attemptLogin(document.getElementById('loginUsername').value);
  };
  document.getElementById('loginUsername').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin(e.target.value);
  });
  document.getElementById('logoutBtn').onclick = logout;

  // Композер: отправка ответа
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('composerSend');
  if (input && sendBtn) {
    sendBtn.onclick = sendCurrentReply;
    // Enter — отправить, Shift+Enter — перенос строки
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentReply();
      }
    });
    // Авто-рост высоты поля
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }

  // Автовход, если уже заходили
  const saved = loadAuth();
  if (saved && saved.username) {
    currentManager = saved;
    showApp();
  } else {
    document.getElementById('login').style.display = 'flex';
  }
}

async function sendCurrentReply() {
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('composerSend');
  if (!input || activeChatId == null) return;
  const text = input.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  input.disabled = true;
  try {
    await api.sendReply(activeChatId, text, currentManager.username);
    input.value = '';
    input.style.height = 'auto';
    // Оптимистично дорисуем сообщение в переписку (бот подтвердит при следующем refresh)
    appendOptimisticOut(text);
  } catch (e) {
    console.error('sendReply failed:', e);
    alert('Не удалось отправить. Проверьте соединение и попробуйте снова.');
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

// Мгновенно показываем отправленное сообщение (до подтверждения ботом).
function appendOptimisticOut(text) {
  const box = document.getElementById('messages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'msg msg-out';
  div.innerHTML = `<div class="msg-bubble">
    <div class="msg-text">${escapeHtml(text)}</div>
    <div class="msg-meta">@${escapeHtml(currentManager.username)} · отправляется…</div>
  </div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

init();
