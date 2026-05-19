// Раздел «Заказать» — псевдо-чат с менеджером.
//
// Это превью реального диалога, который произойдёт в чате с ботом.
// Поле ввода и скрепка — не функциональны: тап по любому из них (или по send-кнопке)
// открывает чат с ботом через openBotChat('request'). Бот в этом чате повторит
// приветствие из bubble'ов и предложит клиенту описать заказ.
//
// Тексты bubble'ов синхронизированы с тем, что говорит бот в handle_start_request —
// чтобы клиент видел одно и то же в апке и в боте.

import { t, getLang } from '../i18n.js';
import { escapeHtml, formatDayHeader } from '../utils.js';
import { openBotChat, haptic } from '../tg.js';

let rendered = false;

export function resetChat() { rendered = false; }

export function renderChat() {
  const page = document.getElementById('page-chat');
  if (!page.innerHTML) {
    page.innerHTML = `
      <div class="chat-scroll" id="chatScroll"></div>
      <div class="chat-composer">
        <div class="chat-input-row chat-input-row-fake" id="chatComposer">
          <button type="button" class="chat-input-icon-btn" id="chatAttachBtn" aria-label="Attach" tabindex="-1">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <div class="chat-input-field chat-input-field-fake" id="chatInputFake">
            ${escapeHtml(t('chatInputPlaceholder'))}
          </div>
          <button type="button" class="chat-input-icon-btn send" id="chatSendBtn" aria-label="Send" tabindex="-1">
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
}

function setupChatHandlers() {
  // Любой тап в области композера (поле ввода, скрепка, send) — открывает чат с ботом.
  // На всех элементах одинаковое поведение, чтобы клиенту не приходилось целиться.
  const handler = () => {
    haptic('light');
    openBotChat('request');
  };
  document.getElementById('chatComposer').addEventListener('click', handler);
}

function appendBubble(direction, text) {
  const scroll = document.getElementById('chatScroll');
  const msg = document.createElement('div');
  msg.className = 'chat-msg ' + direction;
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;
  msg.appendChild(bubble);
  scroll.appendChild(msg);
  scroll.scrollTop = scroll.scrollHeight;
}
