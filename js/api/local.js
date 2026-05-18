// Локальная реализация API: localStorage + catalog.json.
// Здесь же — миграция старого формата товаров (img -> images).
import { CONFIG } from '../config.js';
import { state, saveState } from '../state.js';
import { getUser } from '../tg.js';
import { makeId } from '../utils.js';

const SEED = {
  catalog: [
    { id: 'c1', name_ru: 'Оверсайз худи бежевый', name_en: 'Beige oversize hoodie',
      price_usd: 49, price_byn: 159,
      images: [
        'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=800',
        'https://images.unsplash.com/photo-1620799140408-edc6dcb6d633?w=800',
        'https://images.unsplash.com/photo-1571945153237-4929e783af4a?w=800'
      ],
      desc_ru: 'Плотный хлопок 380 г/м². Свободный крой. Капюшон на шнурках.',
      desc_en: 'Heavy cotton 380 gsm. Relaxed fit. Drawstring hood.',
      sizes: ['XS', 'S', 'M', 'L', 'XL'] },
    { id: 'c2', name_ru: 'Карго-брюки чёрные', name_en: 'Black cargo pants',
      price_usd: 55, price_byn: 179,
      images: ['https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=800'],
      desc_ru: 'Универсальные карго с большими карманами. Эластичный пояс.',
      desc_en: 'Versatile cargo with large pockets. Elastic waist.',
      sizes: ['S', 'M', 'L', 'XL'] },
    { id: 'c3', name_ru: 'Базовая футболка белая', name_en: 'Basic white tee',
      price_usd: 15, price_byn: 49,
      images: ['https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?w=800'],
      desc_ru: 'Хлопок 220 г/м². Прямой крой. Без принтов.',
      desc_en: 'Cotton 220 gsm. Straight cut. No prints.',
      sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'] },
    { id: 'c4', name_ru: 'Бомбер демисезонный', name_en: 'Light bomber jacket',
      price_usd: 79, price_byn: 259,
      images: ['https://images.unsplash.com/photo-1591047139829-d91aecb6caea?w=800'],
      desc_ru: 'Лёгкий бомбер на молнии. Подойдёт на весну и осень.',
      desc_en: 'Lightweight zip-up bomber. Great for spring and fall.',
      sizes: ['S', 'M', 'L', 'XL'] },
    { id: 'c5', name_ru: 'Джинсы прямого кроя', name_en: 'Straight-leg jeans',
      price_usd: 42, price_byn: 139,
      images: ['https://images.unsplash.com/photo-1542272604-787c3835535d?w=800'],
      desc_ru: 'Классический деним. Прямой крой, средняя посадка.',
      desc_en: 'Classic denim. Straight cut, mid-rise.',
      sizes: ['28', '30', '32', '34', '36'] },
    { id: 'c6', name_ru: 'Кроссовки белые', name_en: 'White sneakers',
      price_usd: 65, price_byn: 209,
      images: ['https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800'],
      desc_ru: 'Минималистичные кроссовки на каждый день.',
      desc_en: 'Minimal everyday sneakers.',
      sizes: ['38', '39', '40', '41', '42', '43', '44', '45'] }
  ]
};

function migrateProduct(p) {
  if (!p.images || !Array.isArray(p.images) || p.images.length === 0) {
    p.images = p.img ? [p.img] : [];
  }
  delete p.img;
  return p;
}

let cachedCatalog = null;

export async function loadProducts() {
  if (cachedCatalog) return cachedCatalog;

  // 1) Локально сохранённый каталог (правки админа)
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE.CATALOG);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.catalog?.length) {
        cachedCatalog = parsed.catalog.map(migrateProduct);
        return cachedCatalog;
      }
    }
  } catch (e) {}

  // 2) catalog.json с хостинга
  try {
    const r = await fetch(CONFIG.CATALOG_URL, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j?.catalog)) {
        cachedCatalog = j.catalog.map(migrateProduct);
        return cachedCatalog;
      }
    }
  } catch (e) {}

  // 3) Встроенный seed
  cachedCatalog = JSON.parse(JSON.stringify(SEED.catalog)).map(migrateProduct);
  return cachedCatalog;
}

export async function saveProducts(products) {
  cachedCatalog = products.map(migrateProduct);
  try {
    localStorage.setItem(CONFIG.STORAGE.CATALOG, JSON.stringify({ catalog: cachedCatalog }));
  } catch (e) {}
}

export async function loadHistory() {
  return state.history || [];
}

export async function addOrder(order) {
  const record = {
    id: makeId('h'),
    type: 'order',
    date: new Date().toISOString(),
    status: 'processing',
    isPaid: false,
    eta: null,
    payload: {
      items: order.items,        // [{ productId, size, qty }]
      total_usd: order.total_usd,
      total_byn: order.total_byn,
      currency: order.currency,
    }
  };
  state.history.push(record);
  saveState();
  return record;
}

export async function addRequest(req) {
  const record = {
    id: makeId('h'),
    type: 'request',
    date: new Date().toISOString(),
    payload: {
      text: req.text || '',
      photosCount: req.photosCount || 0,
    }
  };
  state.history.push(record);
  saveState();
  return record;
}

export async function loadCustomer() {
  // В локальном режиме данные клиента берутся из tg.initDataUnsafe.
  // purchases_total в local-режиме всегда 0 (он считается на сервере по оплаченным заказам).
  const u = getUser();
  if (!u) return null;
  return {
    tg_id: u.id,
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    username: u.username || '',
    photo_url: u.photo_url || '',
    phone: '',         // в local недоступен — нужен Bot API
    birth_date: null,  // в local недоступен
    purchases_total: 0,
    preferences: state.settings,
  };
}

export async function upsertCustomer(patch) {
  // В локальном режиме настройки и так уже в state — патч просто туда применяется.
  if (patch.preferences) {
    state.settings = { ...state.settings, ...patch.preferences };
    saveState();
  }
  return loadCustomer();
}

// В local-режиме избранное полностью живёт в state.favorites (это и есть «БД»).
// Эти методы — заглушки для соответствия контракту фасада. UI работает напрямую
// со state.favorites через хелперы из state.js.
export async function loadFavorites() {
  return state.favorites.slice();
}
export async function addFavorite() { /* state.js уже сделал это */ }
export async function removeFavorite() { /* state.js уже сделал это */ }

// Каталог в local-режиме статичный (catalog.json), подписка не нужна.
export function onProductsChange() { return () => {}; }
