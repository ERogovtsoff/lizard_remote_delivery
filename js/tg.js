// Обёртка над window.Telegram.WebApp.
import { CONFIG } from './config.js';

export const tg = window.Telegram?.WebApp || null;

export function initTelegram() {
  if (!tg) return;
  try { tg.ready(); } catch (e) {}
  try { tg.expand(); } catch (e) {}
  // Отключаем вертикальные свайпы (фикс сворачивания при скролле). Bot API 7.7+.
  try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}
  // Никогда не включаем closing confirmation — клиент сам решает когда выйти.
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

// Открыть чат с ботом-посредником с deep-link-параметром.
// token:
//   'request'           — общий запрос на подбор товара
//   'ask_<product_id>'  — уточнение по конкретному товару
//   'order_<order_id>'  — клиент только что оформил заказ
//
// После открытия чата сворачиваем мини-апп, чтобы клиент оказался непосредственно
// в чате с ботом. Задержка перед close() даёт клиенту Telegram время отреагировать
// на openTelegramLink — без неё на некоторых платформах ссылка не успевает открыться.
export function openBotChat(token) {
  const url = `https://t.me/${CONFIG.BOT_USERNAME}?start=${encodeURIComponent(token)}`;
  if (tg?.openTelegramLink) {
    try {
      tg.openTelegramLink(url);
    } catch (e) {
      try { window.open(url, '_blank'); } catch (_) {}
    }
  } else {
    try { window.open(url, '_blank'); } catch (_) {}
  }
  // Сворачиваем апку — клиент должен оказаться в чате с ботом
  setTimeout(() => {
    try { tg?.close?.(); } catch (e) {}
  }, 200);
}

export function onThemeChanged(handler) {
  try { tg?.onEvent?.('themeChanged', handler); } catch (e) {}
}

export function onViewportChanged(handler) {
  try { tg?.onEvent?.('viewportChanged', handler); } catch (e) {}
}
