// Health monitoring — состояние компонентов экосистемы.
//
// Опрашивает раз в HEALTH_INTERVAL_MS:
//   - БД      : короткий запрос к Supabase (managers?limit=1)
//   - Storage : список бакетов через Supabase Storage API
//   - Бот     : читает bot_heartbeat.last_seen и сравнивает с порогом
//   - App     : HEAD-запрос на клиентский index.html (GitHub Pages)
//
// Результат каждого опроса пишется в health_status — это нужно для бота,
// который читает её и шлёт уведомления при изменении статуса.
//
// API экспорта:
//   - startHealthMonitor()          → запустить опрос (вызывается из app.js)
//   - stopHealthMonitor()           → остановить
//   - forceCheck()                  → принудительная проверка сейчас
//   - getOverallStatus()            → 'ok' | 'down' | 'unknown' — для иконки в углу
//   - onStatusChange(callback)      → подписаться на изменения статуса

import { CONFIG } from './config.js';

const HEALTH_INTERVAL_MS = 60 * 1000;        // опрос раз в минуту
const BOT_DEAD_THRESHOLD_SEC = 120;          // если heartbeat не обновлялся 2+ мин — бот мёртв

// URL клиентского приложения (берём из конфига админки)
const APP_URL = (CONFIG.APP_URL || 'https://erogovtsoff.github.io/lizard_remote_delivery/index.html');

const COMPONENTS = ['db', 'storage', 'bot', 'app'];

// Текущее состояние, наблюдаемое в этой вкладке
let state = {
  db:      { status: 'unknown', latency_ms: null, error: null, checked_at: null },
  storage: { status: 'unknown', latency_ms: null, error: null, checked_at: null },
  bot:     { status: 'unknown', latency_ms: null, error: null, checked_at: null },
  app:     { status: 'unknown', latency_ms: null, error: null, checked_at: null },
};

let timerId = null;
let isChecking = false;
const subscribers = new Set();

function notify() {
  for (const cb of subscribers) {
    try { cb(state); } catch (e) { console.warn('health subscriber error:', e); }
  }
}

export function onStatusChange(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getState() {
  return state;
}

export function getOverallStatus() {
  const statuses = COMPONENTS.map(c => state[c].status);
  if (statuses.some(s => s === 'down')) return 'down';
  if (statuses.every(s => s === 'ok'))  return 'ok';
  return 'unknown';
}

// ============ Проверки отдельных компонентов ============

const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_KEY = CONFIG.SUPABASE_ANON_KEY;
const SUPABASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

async function checkDb() {
  const t0 = performance.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/managers?select=tg_id&limit=1`, {
      headers: SUPABASE_HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    return { status: 'ok', latency_ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { status: 'down', latency_ms: null, error: String(e.message || e) };
  }
}

async function checkStorage() {
  const t0 = performance.now();
  try {
    // Самый дешёвый запрос: список бакетов
    const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, { headers: SUPABASE_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    return { status: 'ok', latency_ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { status: 'down', latency_ms: null, error: String(e.message || e) };
  }
}

async function checkBot() {
  const t0 = performance.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bot_heartbeat?select=last_seen&id=eq.1`, {
      headers: SUPABASE_HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows || !rows.length) {
      return { status: 'down', latency_ms: null, error: 'Бот ни разу не присылал heartbeat' };
    }
    const lastSeen = new Date(rows[0].last_seen).getTime();
    const ageSec = (Date.now() - lastSeen) / 1000;
    if (ageSec > BOT_DEAD_THRESHOLD_SEC) {
      return {
        status: 'down',
        latency_ms: null,
        error: `Последний heartbeat ${Math.round(ageSec)}с назад (порог ${BOT_DEAD_THRESHOLD_SEC}с)`,
      };
    }
    return { status: 'ok', latency_ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { status: 'down', latency_ms: null, error: String(e.message || e) };
  }
}

async function checkApp() {
  const t0 = performance.now();
  try {
    // HEAD-запрос к клиентскому index.html. CORS обычно разрешает HEAD на статике.
    // Если HEAD не разрешён — fallback на GET с no-cors (тогда не узнаем статус,
    // но узнаем что сервер ответил)
    const res = await fetch(APP_URL, { method: 'GET', cache: 'no-cache' });
    if (!res.ok && res.status !== 0) throw new Error(`HTTP ${res.status}`);
    return { status: 'ok', latency_ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { status: 'down', latency_ms: null, error: String(e.message || e) };
  }
}

// ============ Цикл опроса ============

async function runAllChecks() {
  if (isChecking) return;
  isChecking = true;
  const t0 = Date.now();
  try {
    const [db, storage, bot, app] = await Promise.all([
      checkDb(), checkStorage(), checkBot(), checkApp(),
    ]);
    const checkedAt = new Date().toISOString();
    state = {
      db:      { ...db,      checked_at: checkedAt },
      storage: { ...storage, checked_at: checkedAt },
      bot:     { ...bot,     checked_at: checkedAt },
      app:     { ...app,     checked_at: checkedAt },
    };

    // Пишем результат в БД — это нужно боту для алертов
    await writeStateToDb();

    notify();
  } catch (e) {
    console.warn('health check failed:', e);
  } finally {
    isChecking = false;
  }
}

// Пишем текущее состояние в БД одним батчем (через UPSERT).
// Каждый менеджер пишет независимо — последний победит. Это OK, потому что
// бот сравнивает состояния через известную ему _health_known_state в памяти,
// а не доверяет одной конкретной записи.
async function writeStateToDb() {
  const rows = COMPONENTS.map(c => ({
    component: c,
    status: state[c].status,
    checked_at: state[c].checked_at,
    latency_ms: state[c].latency_ms,
    error_message: state[c].error,
  }));
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/health_status?on_conflict=component`, {
      method: 'POST',
      headers: {
        ...SUPABASE_HEADERS,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    // не критично — пишем best-effort. Логируем, чтобы знать.
    console.warn('writeStateToDb failed:', e);
  }
}

export function startHealthMonitor() {
  if (timerId) return;
  // Первая проверка сразу
  runAllChecks();
  timerId = setInterval(runAllChecks, HEALTH_INTERVAL_MS);
}

export function stopHealthMonitor() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

export async function forceCheck() {
  await runAllChecks();
}
