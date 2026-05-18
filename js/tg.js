// Обёртка над window.Telegram.WebApp с безопасными вызовами.
// Никаких enableClosingConfirmation — клиент сам решает когда выйти.
import { CONFIG } from './config.js';
import { copyToClipboard } from './utils.js';

export const tg = window.Telegram?.WebApp || null;

export function initTelegram() {
  if (!tg) return;
  try { tg.ready(); } catch (e) {}
  try { tg.expand(); } catch (e) {}
  // ВАЖНО: отключаем вертикальные свайпы (фикс сворачивания при скролле).
  // Bot API 7.7+ (апрель 2024). Если метод недоступен — игнорируем.
  try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
  // НИКОГДА: tg.enableClosingConfirmation() — это вызывает попап «Несохранённые изменения».
  try { tg.disableClosingConfirmation && tg.disableClosingConfirmation(); } catch (e) {}
}

export function getUser() {
  return tg?.initDataUnsafe?.user || null;
}

export function getUserLanguage() {
  return tg?.initDataUnsafe?.user?.language_code || navigator.language || 'en';
}

export function isAdmin() {
  const u = (tg?.initDataUnsafe?.user?.username || '').toLowerCase();
  if (!u) return false;
  return CONFIG.ADMIN_USERNAMES.some(a => a.toLowerCase() === u);
}

export function haptic(kind = 'light') {
  try {
    if (!tg?.HapticFeedback) return;
    if (kind === 'success' || kind === 'warning' || kind === 'error') {
      tg.HapticFeedback.notificationOccurred(kind);
    } else {
      tg.HapticFeedback.impactOccurred(kind);
    }
  } catch (e) {}
}

export function setHeaderColor(color) {
  try { tg?.setHeaderColor?.(color); } catch (e) {}
  try { tg?.setBackgroundColor?.(color); } catch (e) {}
}

export function showBackButton(show, onClick) {
  if (!tg?.BackButton) return;
  try {
    if (onClick) tg.BackButton.onClick(onClick);
    if (show) tg.BackButton.show();
    else tg.BackButton.hide();
  } catch (e) {}
}

// Отправка данных боту с фолбэком.
//
// Главный способ: tg.sendData(JSON) — официальное API Telegram WebApp.
//   Работает, когда мини-апп открыт через:
//     - KeyboardButton(web_app=...) — обычная клавиатурная кнопка в боте
//     - InlineKeyboardButton с web_app
//   После вызова Telegram автоматически закрывает мини-апп и шлёт данные боту
//   (бот получит их в событии web_app_data).
//
// Фолбэк (если sendData недоступен): открываем чат с менеджером через
//   https://t.me/USERNAME?text=... + тихо копируем текст в буфер обмена.
//   На Desktop текст подставится сам, на мобиле клиент сделает paste.
//
// Возвращает:
//   { mode: 'sent' }         — отправлено через бота, мини-апп закроется
//   { mode: 'fallback' }     — открыт чат с менеджером, текст скопирован в буфер
//   { mode: 'failed' }       — ничего не сработало (редкий случай)
export async function sendToBot(payload, fallbackText) {
  // 1. Пробуем sendData — это работает только если апка открыта через keyboard/inline-кнопку
  if (tg?.sendData) {
    try {
      tg.sendData(JSON.stringify(payload));
      return { mode: 'sent' };
    } catch (e) {
      // sendData бросает если апка открыта через menu_button или прямой ссылкой
    }
  }

  // 2. Fallback: открыть чат менеджера с текстом + скопировать в буфер
  if (fallbackText) {
    try { copyToClipboard(fallbackText); } catch (e) {}
  }

  const base = `https://t.me/${CONFIG.MANAGER_USERNAME}`;
  const url = fallbackText ? `${base}?text=${encodeURIComponent(fallbackText)}` : base;

  if (tg?.openTelegramLink) {
    try { tg.openTelegramLink(url); return { mode: 'fallback' }; } catch (e) {}
  }
  try { window.open(url, '_blank'); return { mode: 'fallback' }; } catch (e) {}

  return { mode: 'failed' };
}

// Оставлено для обратной совместимости (используется в detail.js для "уточнить размеры")
// — там мы хотим именно открыть чат, а не отправлять данные боту.
export function openManagerChat(text) {
  const base = `https://t.me/${CONFIG.MANAGER_USERNAME}`;
  const url = text ? `${base}?text=${encodeURIComponent(text)}` : base;
  if (text) {
    try { copyToClipboard(text); } catch (e) {}
  }
  if (tg?.openTelegramLink) {
    try { tg.openTelegramLink(url); return; } catch (e) {}
  }
  try { window.open(url, '_blank'); } catch (e) {}
}

// Подписаться на смену темы Telegram
export function onThemeChanged(handler) {
  try { tg?.onEvent?.('themeChanged', handler); } catch (e) {}
}

// Подписаться на изменение viewport (для повторного disableVerticalSwipes)
export function onViewportChanged(handler) {
  try { tg?.onEvent?.('viewportChanged', handler); } catch (e) {}
}
