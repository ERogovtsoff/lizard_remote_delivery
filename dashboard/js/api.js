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

// Переписка в рамках конкретного обращения.
// Показываем привязанные к обращению + непривязанные сообщения этого клиента
// (последние — для устойчивости к старым/непривязанным сообщениям).
export async function loadInquiryMessages(inquiryId, customerTgId) {
  const bound = await get('messages', {
    select: '*',
    inquiry_id: `eq.${inquiryId}`,
    order: 'created_at.asc',
    limit: '500',
  });
  if (customerTgId == null) return bound;
  // Непривязанные сообщения клиента (inquiry_id и order_id оба пусты)
  let orphan = [];
  try {
    orphan = await get('messages', {
      select: '*',
      customer_tg_id: `eq.${customerTgId}`,
      inquiry_id: 'is.null',
      order_id: 'is.null',
      order: 'created_at.asc',
      limit: '500',
    });
  } catch (_) {}
  // Объединяем и сортируем по времени
  const all = [...bound, ...orphan];
  all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return all;
}

// Переписка в рамках конкретного заказа (с тем же fallback).
export async function loadOrderMessages(orderId, customerTgId) {
  const bound = await get('messages', {
    select: '*',
    order_id: `eq.${orderId}`,
    order: 'created_at.asc',
    limit: '500',
  });
  if (customerTgId == null) return bound;
  let orphan = [];
  try {
    orphan = await get('messages', {
      select: '*',
      customer_tg_id: `eq.${customerTgId}`,
      inquiry_id: 'is.null',
      order_id: 'is.null',
      order: 'created_at.asc',
      limit: '500',
    });
  } catch (_) {}
  const all = [...bound, ...orphan];
  all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return all;
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
// в Telegram. context = { inquiry_id } или { order_id }.
export async function sendReply(customerTgId, text, managerUsername, context = {}, attachmentUrl = null) {
  const res = await fetch(`${BASE}/outbox`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      customer_tg_id: customerTgId,
      text: text || null,
      manager_username: managerUsername,
      attachment_url: attachmentUrl,
      inquiry_id: context.inquiry_id || null,
      order_id: context.order_id || null,
    }),
  });
  if (!res.ok) throw new Error(`sendReply failed: ${res.status}`);
  return true;
}

// Загрузить файл в Supabase Storage (bucket chat-files) из браузера.
// Возвращает публичный URL.
export async function uploadFile(file) {
  const ext = file.name && file.name.includes('.') ? '.' + file.name.split('.').pop() : '';
  const objectName = `dash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
  const url = `${CONFIG.SUPABASE_URL}/storage/v1/object/chat-files/${objectName}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': CONFIG.SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY,
      'Content-Type': file.type || 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`uploadFile failed: ${res.status} ${txt.slice(0, 150)}`);
  }
  return `${CONFIG.SUPABASE_URL}/storage/v1/object/public/chat-files/${objectName}`;
}

// ====================== КАТАЛОГ ТОВАРОВ ======================
//
// Точечные операции (в отличие от «save all» в приложении) — безопаснее при
// параллельной работе с приложением: меняем только нужный товар.

// Все товары (для управления — включая скрытые).
export async function loadProducts() {
  return get('products', { select: '*', order: 'created_at.desc' });
}

// Нормализует объект товара к строке БД.
function productToRow(p) {
  return {
    id: p.id,
    name_ru: p.name_ru || '',
    name_en: p.name_en || '',
    desc_ru: p.desc_ru || '',
    desc_en: p.desc_en || '',
    price_usd: Number(p.price_usd) || 0,
    price_byn: Number(p.price_byn) || 0,
    images: Array.isArray(p.images) ? p.images : [],
    sizes: Array.isArray(p.sizes) ? p.sizes : [],
    stock: (p.stock && typeof p.stock === 'object') ? p.stock : {},
    is_active: p.is_active !== false,
    badge_text: (p.badge_text || '').trim() || null,
    badge_color: (p.badge_color || '').trim() || null,
  };
}

// Создать или обновить один товар (upsert по id).
export async function saveProduct(product) {
  const row = productToRow(product);
  const res = await fetch(`${BASE}/products`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`saveProduct failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return true;
}

// Удалить один товар по id.
export async function deleteProduct(id) {
  const res = await fetch(`${BASE}/products?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
  });
  if (!res.ok) throw new Error(`deleteProduct failed: ${res.status}`);
  return true;
}

// Быстрое переключение видимости (скрыть/показать).
export async function setProductActive(id, isActive) {
  const res = await fetch(`${BASE}/products?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_active: isActive }),
  });
  if (!res.ok) throw new Error(`setProductActive failed: ${res.status}`);
  return true;
}

// ====================== ЗАКАЗЫ И ОБРАЩЕНИЯ ======================

// Список заказов (новейшие первыми) с позициями.
export async function loadOrders() {
  return get('orders', {
    select: '*,order_items(*)',
    order: 'created_at.desc',
    limit: '200',
  });
}

// Список обращений (новейшие первыми).
export async function loadInquiries() {
  return get('inquiries', {
    select: '*',
    order: 'created_at.desc',
    limit: '200',
  });
}

// Сменить статус заказа + (опционально) поставить клиенту уведомление в outbox.
export async function setOrderStatus(orderId, status, clientMessage, customerTgId, managerUsername) {
  const res = await fetch(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`setOrderStatus failed: ${res.status}`);
  // Уведомление клиенту — через ту же очередь outbox, с привязкой к заказу
  if (clientMessage && customerTgId) {
    await queueClientNotice(customerTgId, clientMessage, managerUsername, { order_id: orderId });
  }
  return true;
}

// Сменить статус обращения.
export async function setInquiryStatus(inquiryId, status, clientMessage, customerTgId, managerUsername) {
  const res = await fetch(`${BASE}/inquiries?id=eq.${encodeURIComponent(inquiryId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`setInquiryStatus failed: ${res.status}`);
  if (clientMessage && customerTgId) {
    await queueClientNotice(customerTgId, clientMessage, managerUsername, { inquiry_id: inquiryId });
  }
  return true;
}

// Добавить позиции в существующий заказ + пересчитать сумму.
export async function addOrderItems(orderId, items) {
  // 1. Вставляем позиции
  const rows = items.map(it => ({
    order_id: orderId,
    product_id: it.product_id,
    size: it.size || '',
    qty: it.qty || 1,
    price_usd_snapshot: Number(it.price_usd) || 0,
    price_byn_snapshot: Number(it.price_byn) || 0,
  }));
  const res = await fetch(`${BASE}/order_items`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`addOrderItems failed: ${res.status}`);

  // 2. Пересчитываем сумму заказа по всем его позициям
  const allItems = await get('order_items', { select: '*', order_id: `eq.${orderId}` });
  const totalUsd = (allItems || []).reduce((s, it) => s + (Number(it.price_usd_snapshot) || 0) * (it.qty || 1), 0);
  const totalByn = (allItems || []).reduce((s, it) => s + (Number(it.price_byn_snapshot) || 0) * (it.qty || 1), 0);
  await fetch(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ total_usd: totalUsd, total_byn: totalByn, updated_at: new Date().toISOString() }),
  });
  return { totalUsd, totalByn };
}

// Сохранить внутреннюю заметку менеджера к заказу.
export async function setOrderNote(orderId, note) {
  const res = await fetch(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ manager_note: note }),
  });
  if (!res.ok) throw new Error(`setOrderNote failed: ${res.status}`);
  return true;
}

// Создать заказ из обращения. items = [{product_id, size, qty, price_usd, price_byn}].
// Возвращает созданный заказ { id, ... }.
export async function createOrder(customerTgId, items, currency, inquiryId, status = 'in_progress') {
  const totalUsd = items.reduce((s, it) => s + (Number(it.price_usd) || 0) * (it.qty || 1), 0);
  const totalByn = items.reduce((s, it) => s + (Number(it.price_byn) || 0) * (it.qty || 1), 0);

  // 1. Создаём заказ
  const orderRes = await fetch(`${BASE}/orders`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify({
      customer_tg_id: customerTgId,
      total_usd: totalUsd,
      total_byn: totalByn,
      currency: currency || 'USD',
      status: status,
      is_paid: false,
    }),
  });
  if (!orderRes.ok) throw new Error(`createOrder failed: ${orderRes.status}`);
  const orderArr = await orderRes.json();
  const order = Array.isArray(orderArr) ? orderArr[0] : orderArr;
  if (!order || !order.id) throw new Error('createOrder: no order id');

  // 2. Позиции
  const rows = items.map(it => ({
    order_id: order.id,
    product_id: it.product_id,
    size: it.size || '',
    qty: it.qty || 1,
    price_usd_snapshot: Number(it.price_usd) || 0,
    price_byn_snapshot: Number(it.price_byn) || 0,
  }));
  const itemsRes = await fetch(`${BASE}/order_items`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!itemsRes.ok) throw new Error(`createOrder items failed: ${itemsRes.status}`);

  // 3. Привязываем сообщения обращения к заказу (чтобы переписка продолжилась в заказе)
  if (inquiryId) {
    try {
      await fetch(`${BASE}/messages?inquiry_id=eq.${inquiryId}`, {
        method: 'PATCH',
        headers: { ...HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ order_id: order.id }),
      });
    } catch (_) {}
  }
  return order;
}

// Положить клиентское уведомление в очередь (бот доставит и сохранит в messages).
async function queueClientNotice(customerTgId, text, managerUsername, context = {}) {
  await fetch(`${BASE}/outbox`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      customer_tg_id: customerTgId,
      text: text,
      manager_username: managerUsername || null,
      inquiry_id: context.inquiry_id || null,
      order_id: context.order_id || null,
    }),
  });
}
