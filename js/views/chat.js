// Раздел «Заказать» — чат с менеджером.
//
// Логика отправки:
//   1. Пишем запись в локальную историю (api.addRequest).
//   2. Отправляем боту через tg.sendData — если апка открыта через keyboard/inline-кнопку,
//      бот получит payload, перешлёт менеджеру, и Telegram сам закроет апку.
//   3. Если sendData недоступен — fallback: открываем t.me/manager?text=,
//      текст копируется в буфер (страховка для мобильных Telegram-клиентов),
//      показываем понятный тост с инструкцией.
//
// Прикрепление файлов в самой апке убрано: Telegram WebApp API не передаёт файлы боту
// через sendData. Скрепка показывает информационный тост — файлы клиент прикладывает
// уже в чате с менеджером после отправки.
import { t, getLang } from '../i18n.js';
import { escapeHtml, formatDayHeader } from '../utils.js';
import { api } from '../api/index.js';
import { sendToBot, haptic } from '../tg.js';
import { showToast } from '../components/toast.js';

let rendered = false;
let viewportSyncInstalled = false;

// Динамическая подгонка высоты #page-chat под visualViewport.
// На устройствах где interactive-widget=resizes-content работает (Chrome 108+, Safari 16+)
// dvh пересчитывается сам, и наша подгонка совпадает; в более старых WebView это
// единственный путь избежать «провала» вёрстки при появлении клавиатуры.
function setupViewportSync() {
  if (viewportSyncInstalled) return;
  viewportSyncInstalled = true;
  const vv = window.visualViewport;
  if (!vv) return;

  const page = document.getElementById('page-chat');
  if (!page) return;

  // Высота шапки берётся из CSS-переменной --header-h (56px)
  const HEADER_H = 56;

  function sync() {
    // Применяем только если чат активен — иначе зачем
    if (!page.classList.contains('active')) return;
    // visualViewport.height = высота видимой области (за вычетом клавиатуры)
    // Учитываем что шапка всегда сверху, поэтому вычитаем её высоту.
    const h = vv.height - HEADER_H;
    page.style.height = `${Math.max(h, 100)}px`;
  }

  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  // Стартовая синхронизация
  sync();
}

export function resetChat() { rendered = false; }

export function renderChat() {
  const page = document.getElementById('page-chat');
  if (!page.innerHTML) {
    page.innerHTML = `
      <div class="chat-scroll" id="chatScroll"></div>
      <div class="chat-composer">
        <div class="chat-input-row">
          <button type="button" class="chat-input-icon-btn" id="chatAttachBtn" aria-label="Attach">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </button>
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
  updateSendBtn();
}

function setupChatHandlers() {
  const input = document.getElementById('chatInput');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    updateSendBtn();
  });

  // Страховка для динамической высоты чата при появлении/скрытии клавиатуры.
  // На современных WebView (где работает interactive-widget=resizes-content)
  // эта подписка просто не понадобится — dvh пересчитается сам, и нашу высоту
  // мы по-прежнему ставим через style.height, которая совпадёт с dvh-вариантом.
  // На старых — это даст плавность вместо «скачка».
  setupViewportSync();

  // Скрепка: показывает информационный тост.
  // Реализация надёжная для iOS/Android Telegram WebView:
  //   - На touchstart: запоминаем точку касания, preventDefault (сохраняем фокус)
  //   - На touchend: если палец не сдвинулся больше 10px и время < 500мс → показываем тост,
  //     и помечаем флаг handled, чтобы click не сработал повторно
  //   - На click (десктоп): если флаг handled — игнорируем; иначе показываем тост
  // preventDefault на touchstart также удерживает фокус textarea (клавиатура не закрывается)
  const attachBtn = document.getElementById('chatAttachBtn');
  let touchStartX = 0, touchStartY = 0, touchStartT = 0;
  let touchHandled = false;

  function showAttachInfo() {
    haptic('light');
    showToast(t('chatAttachInfo'), 4000);
  }

  attachBtn.addEventListener('touchstart', (e) => {
    if (e.cancelable) e.preventDefault();
    if (e.touches.length !== 1) return;
    const t0 = e.touches[0];
    touchStartX = t0.clientX;
    touchStartY = t0.clientY;
    touchStartT = Date.now();
    touchHandled = false;
  }, { passive: false });

  attachBtn.addEventListener('touchend', (e) => {
    if (e.changedTouches.length !== 1) return;
    const t0 = e.changedTouches[0];
    const dx = Math.abs(t0.clientX - touchStartX);
    const dy = Math.abs(t0.clientY - touchStartY);
    const dt = Date.now() - touchStartT;
    if (dx <= 10 && dy <= 10 && dt < 500) {
      touchHandled = true;
      showAttachInfo();
      // На многих мобильных WebView preventDefault на touchend подавляет
      // последующий click — гарантия что тост не покажется дважды.
      if (e.cancelable) e.preventDefault();
    }
  });

  // Click — только для десктопа (на мобиле touchend уже отработал и поставил touchHandled)
  attachBtn.addEventListener('click', (e) => {
    if (touchHandled) { touchHandled = false; return; }
    showAttachInfo();
  });

  // mousedown с preventDefault — сохраняет фокус textarea на десктопе при клике
  attachBtn.addEventListener('mousedown', (e) => e.preventDefault());

  document.getElementById('chatSendBtn').onclick = sendChatMessage;
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

function updateSendBtn() {
  const text = document.getElementById('chatInput').value.trim();
  document.getElementById('chatSendBtn').disabled = !text;
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) {
    showToast(t('chatNothingToSend'));
    haptic('warning');
    return;
  }
  appendBubble('out', text);

  await api.addRequest({ text, photosCount: 0 });

  input.value = ''; input.style.height = '';
  updateSendBtn();
  haptic('success');

  // Контракт payload — то, что ожидает bot.py (см. handle_request)
  const payload = { type: 'request', text, photosCount: 0 };
  const result = await sendToBot(payload, text);

  if (result.mode === 'sent') {
    // Telegram сам закроет мини-апп — больше ничего показывать не нужно
  } else if (result.mode === 'fallback') {
    showToast(t('msgSentFallback'), 5000);
  } else {
    showToast(t('msgSentFailed'), 4000);
  }
}
