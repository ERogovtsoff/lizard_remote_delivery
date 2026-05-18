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

// Открыть чат с менеджером с предзаполненным текстом.
// ВАЖНО: параметр ?text= для приватных чатов Telegram не работает —
// поэтому копируем текст в буфер обмена и открываем чат.
// Возвращает 'opened' | 'opened-no-copy' | 'failed'
export async function openManagerChat(text) {
  const url = `https://t.me/${CONFIG.MANAGER_USERNAME}`;

  let copied = false;
  if (text) {
    copied = await copyToClipboard(text);
  }

  let opened = false;
  if (tg?.openTelegramLink) {
    try { tg.openTelegramLink(url); opened = true; } catch (e) {}
  }
  if (!opened) {
    try { window.open(url, '_blank'); opened = true; } catch (e) {}
  }

  if (!opened) return 'failed';
  return copied ? 'opened' : 'opened-no-copy';
}

// Подписаться на смену темы Telegram
export function onThemeChanged(handler) {
  try { tg?.onEvent?.('themeChanged', handler); } catch (e) {}
}

// Подписаться на изменение viewport (для повторного disableVerticalSwipes)
export function onViewportChanged(handler) {
  try { tg?.onEvent?.('viewportChanged', handler); } catch (e) {}
}
