// Слой доступа к Supabase REST API для панели управления.
// Без SDK — чистый fetch, чтобы не тянуть зависимости в статику.
import { CONFIG } from './config.js';

const BASE = CONFIG.SUPABASE_URL + '/rest/v1';
const HEADERS = {
  'apikey': CONFIG.SUPABASE_ANON_KEY,
  'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY,
  'Content-Type': 'application/json',
};

// GET с query-параметрами PostgREST. params — объект вида { select: '*', order: 'created_at.desc' }
async function get(table, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/${table}?${qs}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET ${table} failed: ${res.status}`);
  return res.json();
}

// Проверка, что username — менеджер (или суперадмин).
export async function checkManager(username) {
  const clean = (username || '').replace(/^@/, '').trim().toLowerCase();
  if (!clean) return false;
  if (clean === CONFIG.SUPERADMIN_USERNAME.toLowerCase()) {
    return { username: clean, is_superadmin: true };
  }
  // Ищем в таблице managers по username (без учёта регистра)
  const rows = await get('managers', {
    select: 'tg_id,username,is_on_duty',
    username: `ilike.${clean}`,
    limit: '1',
  });
  if (rows && rows.length > 0) {
    return { username: clean, is_superadmin: false, ...rows[0] };
  }
  return false;
}

// Список чатов: группируем сообщения по клиенту.
// PostgREST не группирует, поэтому берём последние сообщения и группируем на клиенте.
export async function loadChats() {
  // Берём последние 500 сообщений (для прототипа достаточно), новейшие первыми
  const msgs = await get('messages', {
    select: 'id,customer_tg_id,direction,sender,text,attachment_type,read_at,created_at',
    order: 'created_at.desc',
    limit: '500',
  });

  // Группируем по customer_tg_id
  const chatMap = new Map();
  for (const m of msgs) {
    const cid = m.customer_tg_id;
    if (!chatMap.has(cid)) {
      chatMap.set(cid, {
        customer_tg_id: cid,
        last_message: m,            // первое встреченное = самое свежее (т.к. desc)
        unread: 0,
      });
    }
    // Считаем непрочитанные входящие
    if (m.direction === 'in' && !m.read_at) {
      chatMap.get(cid).unread += 1;
    }
  }

  const chats = Array.from(chatMap.values());
  // Сортируем по времени последнего сообщения (свежие сверху)
  chats.sort((a, b) => new Date(b.last_message.created_at) - new Date(a.last_message.created_at));
  return chats;
}

// Имена клиентов: подтягиваем username/имя из customers одним запросом.
export async function loadCustomers(ids) {
  if (!ids || ids.length === 0) return {};
  const list = ids.join(',');
  const rows = await get('customers', {
    select: 'tg_id,username,first_name,last_name',
    tg_id: `in.(${list})`,
  });
  const map = {};
  for (const c of rows) map[c.tg_id] = c;
  return map;
}

// Полная переписка с одним клиентом (по возрастанию времени).
export async function loadConversation(customerTgId) {
  return get('messages', {
    select: '*',
    customer_tg_id: `eq.${customerTgId}`,
    order: 'created_at.asc',
    limit: '500',
  });
}

// Пометить входящие сообщения клиента прочитанными.
export async function markRead(customerTgId) {
  try {
    await fetch(`${BASE}/messages?customer_tg_id=eq.${customerTgId}&direction=eq.in&read_at=is.null`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn('markRead failed:', e);
  }
}

// Отправить ответ клиенту: пишем в очередь outbox, бот её разберёт и отправит
// в Telegram. Возвращает true при успешной постановке в очередь.
export async function sendReply(customerTgId, text, managerUsername) {
  const res = await fetch(`${BASE}/outbox`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      customer_tg_id: customerTgId,
      text: text,
      manager_username: managerUsername,
    }),
  });
  if (!res.ok) throw new Error(`sendReply failed: ${res.status}`);
  return true;
}
