// Кэш каталога товаров.
//
// Стратегия: stale-while-revalidate
//   1. При запросе — если в кэше что-то есть, отдаём моментально.
//   2. Параллельно идёт сетевой запрос; когда он завершится — обновляем кэш.
//   3. Подписчики (view'ы) получают уведомление и перерисовывают свой UI.
//
// Уровни хранения:
//   - memory: переменная _cached — мгновенный доступ, живёт в рамках сессии
//   - localStorage: восстанавливается при перезагрузке апки; снимок последнего успешного ответа
//
// Зачем такой подход: при переходе главная → деталь → главная мы не должны
// каждый раз ждать сеть. На мобильной связи это даёт мгновенные переходы.
//
// Опционально: можно инвалидировать кэш через updated_at, но это не упростит код,
// потому что нужно отдельно отслеживать удаления. SWR проще и работает.

import { CONFIG } from '../config.js';

const STORAGE_KEY = CONFIG.STORAGE.CATALOG + '_cache';
const TTL_FRESH_MS = 30_000;       // в течение 30с после последнего обновления считаем кэш свежим — не идём в сеть
let _cached = null;                 // массив продуктов в памяти
let _lastFetchAt = 0;               // timestamp последнего успешного fetch
let _subscribers = new Set();

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.products)) return null;
    return parsed.products;
  } catch (e) { return null; }
}

function saveToStorage(products) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      products,
      ts: Date.now(),
    }));
  } catch (e) {}
}

// Сравнение списков продуктов — поверхностное по id+updated_at.
// Если updated_at нет — сравниваем JSON (медленнее, но надёжнее).
function listsEqual(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].updated_at && b[i].updated_at) {
      if (a[i].updated_at !== b[i].updated_at) return false;
    } else {
      // Fallback: сравниваем структуру (медленнее, но точно).
      if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
    }
  }
  return true;
}

export function getCached() {
  if (_cached) return _cached;
  _cached = loadFromStorage();
  return _cached;
}

export function isFresh() {
  return _cached && (Date.now() - _lastFetchAt) < TTL_FRESH_MS;
}

export function setCache(products) {
  const hadPrev = _cached !== null;
  const same = listsEqual(_cached, products);
  _cached = products.slice();
  _lastFetchAt = Date.now();
  saveToStorage(_cached);
  // notify только если у нас уже был кэш и он реально изменился.
  // Первая загрузка (hadPrev=false) — это не «изменение», а первичное заполнение,
  // view сам ждёт ответ через await loadProducts и отрисуется один раз.
  if (hadPrev && !same) notify();
}

// Сразу обновить состояние без сравнения (использовать после save/delete в админке)
export function invalidate() {
  _lastFetchAt = 0;
}

export function clearCache() {
  _cached = null;
  _lastFetchAt = 0;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  notify();
}

export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

function notify() {
  _subscribers.forEach(fn => {
    try { fn(_cached); } catch (e) {}
  });
}
