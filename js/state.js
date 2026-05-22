// Локальное состояние приложения.
//
// Что хранится:
//   - favorites: [{ productId, size }]
//   - cart:      [{ productId, size, qty }]
//   - settings:  { lang, theme, currency }
//
// История заказов и запросов в state НЕ хранится — она всегда читается из БД.
// Онбординг — отдельный флаг по ключу ONBOARD_KEY, не часть state. На каждом
// устройстве приветствие показывается один раз; синхронизировать смысла нет.
//
// Изменения favorites и cart транслируются в БД через зарегистрированные
// syncer-функции (см. setFavoritesSyncer / setCartSyncer). Это позволяет
// сохранять разделение: state.js не знает о существовании сети.

import { CONFIG } from './config.js';

const KEY = CONFIG.STORAGE.STATE;
const ONBOARD_KEY = CONFIG.STORAGE.ONBOARDING;

const DEFAULT = {
  favorites: [],
  cart: [],
  settings: { lang: 'auto', theme: 'auto', currency: 'USD' },
};

// Миграция со старых форматов: cart [{id, qty}] -> [{productId, size, qty}],
// favorites string[] -> [{productId, size}]
function migrate(parsed) {
  const cart = (parsed.cart || []).map(c => ({
    productId: c.productId || c.id,
    size: c.size || null,
    qty: c.qty || 1,
  }));
  let favorites = parsed.favorites || [];
  if (favorites.length > 0 && typeof favorites[0] === 'string') {
    favorites = favorites.map(id => ({ productId: id, size: null }));
  } else {
    favorites = favorites.map(f => ({ productId: f.productId || f.id, size: f.size || null }));
  }
  return {
    ...DEFAULT, ...parsed,
    cart, favorites,
    settings: { ...DEFAULT.settings, ...(parsed.settings || {}) },
  };
}

export const state = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT));
})();

export function saveState() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (e) {}
  // Сообщаем UI, что корзина/избранное изменились — для мгновенного обновления
  // бейджей и анимаций (без ожидания периодического опроса).
  try { window.dispatchEvent(new CustomEvent('state:changed')); } catch (e) {}
}

// Локальный быстрый кэш факта прохождения онбординга.
// Источник правды — поле customers.onboarded в БД. localStorage здесь нужен только
// чтобы при следующих запусках не моргать онбординг-страницей пока ждём ответ из БД.
export function isOnboardedLocal() {
  try { return !!localStorage.getItem(ONBOARD_KEY); } catch (e) { return false; }
}
export function setOnboardedLocal() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
}
export function clearOnboardedLocal() {
  try { localStorage.removeItem(ONBOARD_KEY); } catch (e) {}
}

// Старые имена сохраняем для обратной совместимости с другими местами в коде.
export const isOnboarded = isOnboardedLocal;
export const setOnboarded = setOnboardedLocal;

// ============================== FAVORITES ==============================

export function isFavExact(productId, size) {
  return state.favorites.some(f =>
    f.productId === productId && (f.size || null) === (size || null)
  );
}

export function isFavAny(productId) {
  return state.favorites.some(f => f.productId === productId);
}

// Внешний синхронизатор: ({ action: 'add'|'remove', productId, size }) => void
let _favSync = null;
export function setFavoritesSyncer(fn) { _favSync = fn; }
function syncFav(action, productId, size) {
  if (!_favSync) return;
  try { _favSync({ action, productId, size: size || null }); } catch (e) {}
}

export function toggleFav(productId, size) {
  const idx = state.favorites.findIndex(f =>
    f.productId === productId && (f.size || null) === (size || null)
  );
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    saveState();
    syncFav('remove', productId, size);
    return false;
  }
  state.favorites.push({ productId, size: size || null });
  saveState();
  syncFav('add', productId, size);
  return true;
}

export function removeFav(productId, size) {
  state.favorites = state.favorites.filter(f =>
    !(f.productId === productId && (f.size || null) === (size || null))
  );
  saveState();
  syncFav('remove', productId, size);
}

export function removeFavAll(productId) {
  const removed = state.favorites.filter(f => f.productId === productId);
  state.favorites = state.favorites.filter(f => f.productId !== productId);
  saveState();
  removed.forEach(f => syncFav('remove', productId, f.size));
}

// ============================== CART ==============================

export function cartKey(productId, size) {
  return productId + '::' + (size || '');
}

// Внешний синхронизатор: ({ action, productId?, size?, qty? }) => void
let _cartSync = null;
export function setCartSyncer(fn) { _cartSync = fn; }
function syncCart(action, payload) {
  if (!_cartSync) return;
  try { _cartSync({ action, ...payload }); } catch (e) {}
}

export function addToCart(productId, size) {
  const key = cartKey(productId, size);
  const it = state.cart.find(c => cartKey(c.productId, c.size) === key);
  if (it) it.qty += 1;
  else state.cart.push({ productId, size: size || null, qty: 1 });
  saveState();
  const newQty = state.cart.find(c => cartKey(c.productId, c.size) === key).qty;
  syncCart('set', { productId, size: size || null, qty: newQty });
}

export function changeCartQty(productId, size, delta) {
  const key = cartKey(productId, size);
  const it = state.cart.find(c => cartKey(c.productId, c.size) === key);
  if (!it) return;
  it.qty += delta;
  if (it.qty <= 0) {
    state.cart = state.cart.filter(c => cartKey(c.productId, c.size) !== key);
    saveState();
    syncCart('remove', { productId, size: size || null });
  } else {
    saveState();
    syncCart('set', { productId, size: size || null, qty: it.qty });
  }
}

export function removeFromCart(productId, size) {
  const key = cartKey(productId, size);
  state.cart = state.cart.filter(c => cartKey(c.productId, c.size) !== key);
  saveState();
  syncCart('remove', { productId, size: size || null });
}

export function clearLocalCart() {
  state.cart = [];
  saveState();
  syncCart('clear', {});
}

export function cartTotalCount() {
  return state.cart.reduce((s, c) => s + c.qty, 0);
}

// ============================== SETTINGS ==============================

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveState();
}
