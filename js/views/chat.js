// Раздел «Заказать» — чат с менеджером.
// Правка #4 из предыдущей итерации: ?text= в URL для приватных чатов Telegram не работает,
// поэтому копируем текст в буфер и открываем чат с подсказкой «вставьте сообщение».
import { t, getLang } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { state, saveState } from '../state.js';
import { api } from '../api/index.js';
import { openManagerChat, haptic } from '../tg.js';
import { showToast } from '../components/toast.js';
import { formatDayHeader } from '../utils.js';

let rendered = false;

export function resetChat() { rendered = false; }

export function renderChat() {
  const page = document.getElementById('page-chat');
  if (!page.innerHTML) {
    page.innerHTML = `
      <div class="chat-scroll" id="chatScroll"></div>
      <div class="chat-composer">
        <div class="chat-file-hint" id="chatFileHint">${escapeHtml(t('chatFileHint'))}</div>
        <div class="chat-attached" id="chatAttached"></div>
        <div class="chat-input-row">
          <button type="button" class="chat-input-icon-btn" id="chatAttachBtn" aria-label="Attach">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <input type="file" id="chatAttachInput" accept="image/*,application/pdf,.doc,.docx" multiple style="display:none">
          <div class="chat-input-field">
            <textarea id="chatInput" rows="1" placeholder="${escapeHtml(t('chatInputPlaceholder'))}"></textarea>
          </div>
          <button type="button" class="chat-input-icon-btn send" id="chatSendBtn" aria-label="Send" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </button>
        </div>
      </div>
    `;
    setupChatHandlers();
  }
  if (!rendered) {
    const scroll = document.getElementById('chatScroll');
    scroll.innerHTML = '';
    const today = formatDayHeader(new Date(), getLang());
    const dayDiv = document.createElement('div');
    dayDiv.className = 'chat-day';
    dayDiv.textContent = today;
    scroll.appendChild(dayDiv);
    appendBubble('in', t('chatGreeting1'));
    appendBubble('in', t('chatGreeting2'));
    appendBubble('in', t('chatGreeting3'));
    rendered = true;
  }
  renderAttached();
  updateSendBtn();
  document.getElementById('chatFileHint').classList.toggle('show', state.attached.length > 0);
}

function setupChatHandlers() {
  const input = document.getElementById('chatInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    updateSendBtn();
  });

  // Кнопка-скрепка: открываем file picker программно.
  // КЛЮЧЕВОЙ МОМЕНТ: preventDefault на pointerdown/mousedown/touchstart предотвращает
  // фокус-перехват кнопкой — благодаря этому textarea НЕ теряет фокус,
  // а значит экранная клавиатура НЕ закрывается при тапе по скрепке.
  const attachBtn = document.getElementById('chatAttachBtn');
  const attachInput = document.getElementById('chatAttachInput');
  const preventBlur = (e) => e.preventDefault();
  attachBtn.addEventListener('pointerdown', preventBlur);
  attachBtn.addEventListener('mousedown', preventBlur);
  attachBtn.addEventListener('touchstart', preventBlur, { passive: false });
  attachBtn.addEventListener('click', () => {
    // Запоминаем что textarea был в фокусе ДО клика
    const wasFocused = document.activeElement === input;
    attachInput.click();
    // Страховка: если по какой-то причине браузер всё же снял фокус (бывает в iOS WebView
    // при появлении системного file picker), возвращаем его сразу.
    if (wasFocused) {
      // requestAnimationFrame даёт браузеру обработать его внутренние эффекты, потом мы
      // восстанавливаем фокус — это в большинстве случаев не дает клавиатуре уйти
      requestAnimationFrame(() => {
        if (document.activeElement !== input) {
          try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
        }
      });
    }
  });

  document.getElementById('chatSendBtn').onclick = sendChatMessage;
  attachInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach(file => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          state.attached.push({ kind: 'image', dataUrl: ev.target.result, name: file.name });
          renderAttached(); updateSendBtn();
          document.getElementById('chatFileHint').classList.add('show');
        };
        reader.readAsDataURL(file);
      } else {
        state.attached.push({ kind: 'file', name: file.name });
        renderAttached(); updateSendBtn();
        document.getElementById('chatFileHint').classList.add('show');
      }
    });
    e.target.value = '';
  });
}

function appendBubble(direction, text, photos = [], files = []) {
  const scroll = document.getElementById('chatScroll');
  const msg = document.createElement('div');
  msg.className = 'chat-msg ' + direction;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  if (photos.length > 0) {
    const grid = document.createElement('div');
    grid.className = 'chat-bubble-photos' + (photos.length === 1 ? ' one' : '');
    photos.forEach(url => {
      const img = document.createElement('img'); img.src = url; grid.appendChild(img);
    });
    bubble.appendChild(grid);
  }
  if (files.length > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-bubble-files';
    files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'chat-bubble-file';
      row.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="chat-bubble-file-name">${escapeHtml(f)}</span>`;
      wrap.appendChild(row);
    });
    bubble.appendChild(wrap);
  }
  if (text) {
    const tx = document.createElement('div');
    tx.textContent = text;
    bubble.appendChild(tx);
  }
  msg.appendChild(bubble);
  scroll.appendChild(msg);
  scroll.scrollTop = scroll.scrollHeight;
}

function renderAttached() {
  const wrap = document.getElementById('chatAttached');
  wrap.innerHTML = '';
  state.attached.forEach((a, idx) => {
    const el = document.createElement('div');
    el.className = 'chat-attached-item';
    if (a.kind === 'image') {
      el.innerHTML = `<img src="${a.dataUrl}" alt=""><button data-idx="${idx}" aria-label="Remove">×</button>`;
    } else {
      el.innerHTML = `
        <div class="file-tile">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span>${escapeHtml(a.name)}</span>
        </div>
        <button data-idx="${idx}" aria-label="Remove">×</button>`;
    }
    el.querySelector('button').onclick = () => {
      state.attached.splice(idx, 1);
      renderAttached(); updateSendBtn();
      document.getElementById('chatFileHint').classList.toggle('show', state.attached.length > 0);
    };
    wrap.appendChild(el);
  });
}

function updateSendBtn() {
  const text = document.getElementById('chatInput').value.trim();
  const hasFiles = state.attached.length > 0;
  document.getElementById('chatSendBtn').disabled = !text && !hasFiles;
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  const attached = state.attached.slice();
  if (!text && attached.length === 0) {
    showToast(t('chatNothingToSend'));
    haptic('warning');
    return;
  }
  const photos = attached.filter(a => a.kind === 'image').map(a => a.dataUrl);
  const files = attached.filter(a => a.kind === 'file').map(a => a.name);
  appendBubble('out', text, photos, files);

  await api.addRequest({ text, photosCount: photos.length + files.length });

  input.value = ''; input.style.height = '';
  state.attached = [];
  renderAttached(); updateSendBtn();
  document.getElementById('chatFileHint').classList.remove('show');
  haptic('success');

  setTimeout(() => {
    openManagerChat(text);
  }, 350);
}
