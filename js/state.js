// Состояние приложения. Хранит то, что нужно прямо в UI:
// - favorites: [{ productId, size }]  — избранное с размерами (правка #3)
// - cart: [{ productId, size, qty }]  — корзина с размерами
// - history: [...]                     — кэш истории (источник правды — БД, если API_MODE='supabase')
// - settings: { lang, theme, currency }
// - attached: [...]                    — черновик чата, в localStorage не пишем
//
// История читается из API. В local-режиме API сам читает/пишет localStorage.
// В supabase-режиме API будет ходить в БД, а кэш в state нужен только чтобы рендер не моргал.
//
// Онбординг — отдельный флаг, специально вне state: его не нужно
// синхронизировать между устройствами (каждое устройство показывает приветствие 1 раз).
import { CONFIG } from './config.js';

const KEY = CONFIG.STORAGE.STATE;
const ONBOARD_KEY = CONFIG.STORAGE.ONBOARDING;

const DEFAULT = {
  favorites: [],
  cart: [],
  history: [],
  settings: { lang: 'auto', theme: 'auto', currency: 'USD' },
  attached: [],
};

function migrate(parsed) {
  // Старая корзина была [{id, qty}], потом стала [{id, size, qty}]
  const cart = (parsed.cart || []).map(c => ({
    productId: c.productId || c.id,
    size: c.size || null,
    qty: c.qty || 1,
  }));
  // Старое избранное было массивом id; теперь массив объектов {productId, size}
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
    attached: [],
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
    const toSave = { ...state };
    delete toSave.attached;
    localStorage.setItem(KEY, JSON.stringify(toSave));
  } catch (e) {}
}

export function isOnboarded() {
  try { return !!localStorage.getItem(ONBOARD_KEY); } catch (e) { return false; }
}
export function setOnboarded() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (e) {}
}

// Хелперы по избранному (с учётом размера)
export function favKey(productId, size) { return productId + '::' + (size || ''); }
export function isFavExact(productId, size) {
  return state.favorites.some(f => f.productId === productId && (f.size || null) === (size || null));
}
// Любой размер этого товара
export function isFavAny(productId) {
  return state.favorites.some(f => f.productId === productId);
}

// Внешний синхронизатор (регистрируется app.js при старте) — пишет изменения в БД.
// Сигнатура: ({ action: 'add'|'remove', productId, size }) => Promise<void>
let _favSync = null;
export function setFavoritesSyncer(fn) { _favSync = fn; }

function syncFav(action, productId, size) {
  if (!_favSync) return;
  try { _favSync({ action, productId, size: size || null }); } catch (e) {}
}

export function toggleFav(productId, size) {
  const idx = state.favorites.findIndex(
    f => f.productId === productId && (f.size || null) === (size || null)
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
  state.favorites = state.favorites.filter(
    f => !(f.productId === productId && (f.size || null) === (size || null))
  );
  saveState();
  syncFav('remove', productId, size);
}
// Удалить все варианты товара (используется при удалении карточки без указания размера)
export function removeFavAll(productId) {
  const removed = state.favorites.filter(f => f.productId === productId);
  state.favorites = state.favorites.filter(f => f.productId !== productId);
  saveState();
  removed.forEach(f => syncFav('remove', productId, f.size));
}

// Корзина
export function cartKey(productId, size) { return productId + '::' + (size || ''); }

// Внешний синхронизатор корзины (регистрируется app.js)
// Сигнатура: ({ action: 'set'|'remove'|'clear', productId?, size?, qty? }) => void
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
  const newQty = (state.cart.find(c => cartKey(c.productId, c.size) === key) || {}).qty;
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
export function cartTotalCount() { return state.cart.reduce((s, c) => s + c.qty, 0); }

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  saveState();
}
