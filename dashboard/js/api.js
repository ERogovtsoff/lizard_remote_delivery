// Слой доступа к Supabase REST API для панели управления.
// Без SDK — чистый fetch, чтобы не тянуть зависимости в статику.
import { CONFIG } from './config.js';

const BASE = CONFIG.SUPABASE_URL + '/rest/v1';
const HEADERS = {
  'apikey': CONFIG.SUPABASE_ANON_KEY,
  'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY,
  'Content-Type': 'application/json',
};

// fetch с автоповтором при сетевых сбоях (обрыв соединения, отсутствие сети).
// Экспонента с потолком 4с, до 8 попыток. HTTP-ответы (даже 4xx/5xx) НЕ
// повторяются — это не сетевая ошибка, их обрабатывает вызывающий код.
// Критично для доставки сообщений менеджера, когда у него нестабильный интернет.
async function fetchRetry(url, options = {}, retries = 8) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      // TypeError от fetch = сетевой сбой (нет соединения, обрыв, DNS)
      lastErr = e;
      if (attempt < retries) {
        const delay = Math.min(500 * Math.pow(2, attempt - 1), 4000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// GET с query-параметрами PostgREST. params — объект вида { select: '*', order: 'created_at.desc' }
async function get(table, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetchRetry(`${BASE}/${table}?${qs}`, { headers: HEADERS });
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
    select: 'tg_id,username,is_on_duty,chat_id',
    username: `ilike.${clean}`,
    limit: '1',
  });
  if (rows && rows.length > 0) {
    return { username: clean, is_superadmin: false, ...rows[0] };
  }
  return false;
}

// Подгружает актуальный статус дежурства менеджера (для отображения переключателя).
// Возвращает { is_on_duty: bool, chat_id: int|null } или null, если запись не найдена.
// Для суперадмина — отдельная логика: его «дежурство» по сути всегда включено
// (он всегда получает уведомления, если сделал /start боту).
export async function loadMyDutyStatus(username) {
  const clean = (username || '').replace(/^@/, '').trim().toLowerCase();
  if (!clean) return null;
  if (clean === CONFIG.SUPERADMIN_USERNAME.toLowerCase()) {
    // Суперадмин: показываем его текущий chat_id из manager_chat.txt? Нет —
    // в БД его нет. Просто вернём «всегда онлайн».
    return { is_on_duty: true, chat_id: null, is_superadmin: true };
  }
  const rows = await get('managers', {
    select: 'is_on_duty,chat_id',
    username: `ilike.${clean}`,
    limit: '1',
  });
  if (rows && rows.length > 0) return rows[0];
  return null;
}

// Переключает дежурство менеджера. Возвращает новое значение или null при ошибке.
// Только для не-суперадмина (суперадмин всегда «онлайн»).
export async function setMyDutyStatus(username, isOnDuty) {
  const clean = (username || '').replace(/^@/, '').trim().toLowerCase();
  if (!clean) return null;
  if (clean === CONFIG.SUPERADMIN_USERNAME.toLowerCase()) return isOnDuty;
  const res = await fetchRetry(`${BASE}/managers?username=ilike.${encodeURIComponent(clean)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_on_duty: !!isOnDuty }),
  });
  if (!res.ok) throw new Error(`setMyDutyStatus failed: ${res.status}`);
  logAudit({
    action: isOnDuty ? 'duty_on' : 'duty_off',
    entity_type: 'manager', entity_id: clean,
    manager: clean,
  });
  return !!isOnDuty;
}

// ===== CRUD менеджеров =====

// Загрузить список всех менеджеров (для админ-модалки).
export async function loadManagers() {
  return get('managers', { select: '*', order: 'created_at.asc' });
}

// Добавить менеджера. Принимает { username?, tg_id? } — хотя бы одно поле.
// addedBy — username того, кто добавляет (для audit и поля added_by).
export async function addManager({ username, tg_id }, addedBy) {
  const row = { is_on_duty: true, added_by: (addedBy || '').toLowerCase() };
  if (username) row.username = username.replace(/^@/, '').toLowerCase().trim();
  if (tg_id) row.tg_id = Number(tg_id);
  if (!row.username && !row.tg_id) throw new Error('Нужно указать username или tg_id');
  const res = await fetchRetry(`${BASE}/managers`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`addManager failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  logAudit({
    action: 'manager_add', entity_type: 'manager',
    entity_id: row.username || String(row.tg_id),
    manager: addedBy, details: { username: row.username, tg_id: row.tg_id },
  });
  return true;
}

// Удалить менеджера по username или tg_id.
export async function deleteManager({ username, tg_id }, removedBy) {
  let filter;
  if (tg_id) filter = `tg_id=eq.${encodeURIComponent(tg_id)}`;
  else if (username) filter = `username=eq.${encodeURIComponent(username.replace(/^@/, '').toLowerCase())}`;
  else throw new Error('Нужно указать username или tg_id');
  const res = await fetchRetry(`${BASE}/managers?${filter}`, {
    method: 'DELETE',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
  });
  if (!res.ok) throw new Error(`deleteManager failed: ${res.status}`);
  logAudit({
    action: 'manager_delete', entity_type: 'manager',
    entity_id: username || String(tg_id),
    manager: removedBy, details: { username, tg_id },
  });
  return true;
}

// Переключить дежурство любого менеджера (для админа). От setMyDutyStatus
// отличается тем, что меняет не своё, а указанного менеджера, и доступно
// только суперадмину.
export async function setManagerDuty({ username, tg_id }, isOnDuty, byManager) {
  let filter;
  if (tg_id) filter = `tg_id=eq.${encodeURIComponent(tg_id)}`;
  else if (username) filter = `username=eq.${encodeURIComponent(username.replace(/^@/, '').toLowerCase())}`;
  else throw new Error('Нужно указать username или tg_id');
  const res = await fetchRetry(`${BASE}/managers?${filter}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_on_duty: !!isOnDuty }),
  });
  if (!res.ok) throw new Error(`setManagerDuty failed: ${res.status}`);
  logAudit({
    action: isOnDuty ? 'manager_duty_on' : 'manager_duty_off',
    entity_type: 'manager', entity_id: username || String(tg_id),
    manager: byManager,
  });
  return true;
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
    select: 'tg_id,username,first_name,last_name,purchases_total,purchases_total_byn,manager_note,updated_at',
    tg_id: `in.(${list})`,
  });
  const map = {};
  for (const c of rows) map[c.tg_id] = c;
  return map;
}

// Все клиенты со всеми полями — для раздела «Клиенты».
export async function loadAllCustomers() {
  return get('customers', {
    select: '*',
    order: 'created_at.desc',
    limit: '5000',
  });
}

// Лёгкая агрегация по заказам/обращениям для раздела «Клиенты»:
// возвращает Map<tg_id, { ordersTotal, ordersActive, lastOrderAt, lastInquiryAt }>.
export async function loadCustomerAggregates() {
  const [orders, inquiries] = await Promise.all([
    get('orders', { select: 'id,customer_tg_id,status,created_at,updated_at', limit: '5000' }),
    get('inquiries', { select: 'id,customer_tg_id,status,created_at,updated_at', limit: '5000' }),
  ]);
  const map = new Map();
  function bag(tg) {
    if (!map.has(tg)) map.set(tg, { ordersTotal: 0, ordersActive: 0, lastOrderAt: null, lastInquiryAt: null });
    return map.get(tg);
  }
  for (const o of (orders || [])) {
    const b = bag(o.customer_tg_id);
    b.ordersTotal++;
    if (o.status !== 'completed' && o.status !== 'cancelled') b.ordersActive++;
    const t = o.updated_at || o.created_at;
    if (!b.lastOrderAt || new Date(t) > new Date(b.lastOrderAt)) b.lastOrderAt = t;
  }
  for (const q of (inquiries || [])) {
    const b = bag(q.customer_tg_id);
    const t = q.updated_at || q.created_at;
    if (!b.lastInquiryAt || new Date(t) > new Date(b.lastInquiryAt)) b.lastInquiryAt = t;
  }
  return map;
}

// Какие клиенты имеют хотя бы одно непрочитанное входящее сообщение.
// Возвращает Set<tg_id>.
export async function loadUnreadCustomers() {
  try {
    const rows = await get('messages', {
      select: 'customer_tg_id',
      direction: 'eq.in',
      read_at: 'is.null',
      limit: '5000',
    });
    const set = new Set();
    (rows || []).forEach(m => set.add(m.customer_tg_id));
    return set;
  } catch (e) {
    console.warn('loadUnreadCustomers failed:', e);
    return new Set();
  }
}

// Дата последнего сообщения от клиента (вход — настоящая активность пользователя).
// Возвращает Map<tg_id, ISO-string>.
export async function loadLastIncomingMessages() {
  // Берём входящие сообщения, отсортированные по времени убывания. PostgREST
  // не умеет distinct, поэтому берём ~5000 последних и схлопываем на фронте.
  const rows = await get('messages', {
    select: 'customer_tg_id,created_at',
    direction: 'eq.in',
    order: 'created_at.desc',
    limit: '5000',
  });
  const map = new Map();
  for (const m of (rows || [])) {
    if (!map.has(m.customer_tg_id)) map.set(m.customer_tg_id, m.created_at);
  }
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

// Переписка в рамках конкретного обращения — СТРОГО только привязанные сюда.
// customerTgId оставлен в сигнатуре для совместимости вызовов, но не используется:
// fallback на «бесконтекстные» сообщения убран, чтобы в карточку не попадал
// чужой хлам (старые сообщения, напоминания и т.п.).
export async function loadInquiryMessages(inquiryId, customerTgId) {
  return get('messages', {
    select: '*',
    inquiry_id: `eq.${inquiryId}`,
    order: 'created_at.asc',
    limit: '500',
  });
}

// Переписка в рамках конкретного заказа — СТРОГО только привязанные сюда.
export async function loadOrderMessages(orderId, customerTgId) {
  return get('messages', {
    select: '*',
    order_id: `eq.${orderId}`,
    order: 'created_at.asc',
    limit: '500',
  });
}

// Пометить входящие сообщения клиента прочитанными.
export async function markRead(customerTgId) {
  try {
    await fetchRetry(`${BASE}/messages?customer_tg_id=eq.${customerTgId}&direction=eq.in&read_at=is.null`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn('markRead failed:', e);
  }
}

// Какие заказы/обращения имеют непрочитанные входящие сообщения от клиента.
// Возвращает { orderIds: Set, inquiryIds: Set } — для индикатора «ждёт ответа».
export async function loadUnreadContexts() {
  const res = { orderIds: new Set(), inquiryIds: new Set() };
  try {
    const rows = await get('messages', {
      select: 'order_id,inquiry_id',
      direction: 'eq.in',
      read_at: 'is.null',
      limit: '1000',
    });
    (rows || []).forEach(m => {
      if (m.order_id != null) res.orderIds.add(String(m.order_id));
      if (m.inquiry_id != null) res.inquiryIds.add(String(m.inquiry_id));
    });
  } catch (e) {
    console.warn('loadUnreadContexts failed:', e);
  }
  return res;
}

// Пометить прочитанными входящие конкретного заказа/обращения.
export async function markContextRead(context) {
  try {
    let filter;
    if (context.order_id != null) filter = `order_id=eq.${context.order_id}`;
    else if (context.inquiry_id != null) filter = `inquiry_id=eq.${context.inquiry_id}`;
    else return;
    await fetchRetry(`${BASE}/messages?${filter}&direction=eq.in&read_at=is.null`, {
      method: 'PATCH',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    });
  } catch (e) {
    console.warn('markContextRead failed:', e);
  }
}

// Отправить ответ клиенту: пишем в очередь outbox, бот её разберёт и отправит
// в Telegram. context = { inquiry_id } или { order_id }.
export async function sendReply(customerTgId, text, managerUsername, context = {}, attachmentUrl = null) {
  const res = await fetchRetry(`${BASE}/outbox`, {
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
  const res = await fetchRetry(url, {
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
export async function saveProduct(product, manager) {
  const row = productToRow(product);
  // Подгружаем старое для сравнения и audit (только ключевые поля)
  let before = null;
  try {
    const rows = await get('products', { select: '*', id: `eq.${product.id}`, limit: '1' });
    before = rows[0] || null;
  } catch (_) {}
  const res = await fetchRetry(`${BASE}/products`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`saveProduct failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  // Audit: фиксируем изменения видимых клиенту полей
  const watch = ['price_usd', 'price_byn', 'name_ru', 'name_en', 'is_active', 'sizes', 'stock'];
  if (before) {
    const changes = {};
    for (const k of watch) {
      const a = JSON.stringify(before[k]);
      const b = JSON.stringify(row[k]);
      if (a !== b) changes[k] = { from: before[k], to: row[k] };
    }
    if (Object.keys(changes).length) {
      logAudit({ action: 'product_update', entity_type: 'product', entity_id: product.id, manager, details: changes });
    }
  } else {
    logAudit({ action: 'product_create', entity_type: 'product', entity_id: product.id, manager, details: { name: row.name_ru || row.name_en, price_usd: row.price_usd } });
  }
  return true;
}

// Удалить один товар по id.
// Удалить один товар по id.
// Если на товар уже ссылаются позиции заказов (order_items.product_id с NO ACTION),
// БД не даст его удалить (409 conflict). В этом случае «мягко» прячем товар:
// is_active=false. История заказов сохраняется, в каталоге товар исчезает.
// Возвращает { mode: 'deleted' | 'archived' } — чтобы UI мог показать понятное сообщение.
export async function deleteProduct(id, manager) {
  // 1) Проверим заранее: есть ли позиции заказов с этим товаром
  let hasOrderItems = false;
  try {
    const items = await get('order_items', { select: 'id', product_id: `eq.${encodeURIComponent(id)}`, limit: '1' });
    hasOrderItems = (items && items.length > 0);
  } catch (_) { /* если запрос упал — попробуем delete и обработаем 409 */ }

  if (!hasOrderItems) {
    // Чистое удаление возможно
    const res = await fetchRetry(`${BASE}/products?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    });
    if (res.ok) {
      logAudit({ action: 'product_delete', entity_type: 'product', entity_id: id, manager });
      return { mode: 'deleted' };
    }
    // 409 (или другие) — пойдём по soft-пути ниже
    if (res.status !== 409) {
      throw new Error(`deleteProduct failed: ${res.status}`);
    }
  }

  // Soft-delete: прячем товар (is_active=false), история сохраняется.
  const res = await fetchRetry(`${BASE}/products?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_active: false }),
  });
  if (!res.ok) throw new Error(`deleteProduct (soft) failed: ${res.status}`);
  logAudit({ action: 'product_archive', entity_type: 'product', entity_id: id, manager, details: { reason: 'has order_items' } });
  return { mode: 'archived' };
}

// Быстрое переключение видимости (скрыть/показать).
export async function setProductActive(id, isActive, manager) {
  const res = await fetchRetry(`${BASE}/products?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_active: isActive }),
  });
  if (!res.ok) throw new Error(`setProductActive failed: ${res.status}`);
  logAudit({ action: isActive ? 'product_show' : 'product_hide', entity_type: 'product', entity_id: id, manager });
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

// Сменить статус заказа + (опционально) уведомить клиента + записать в историю.
// oldStatus — прежний статус (для лога); cancelReason — причина при отмене.
export async function setOrderStatus(orderId, status, clientMessage, customerTgId, managerUsername, oldStatus = null, cancelReason = null) {
  const now = new Date().toISOString();
  const patch = { status, updated_at: now, status_changed_at: now };
  if (cancelReason != null) patch.cancel_reason = cancelReason;
  const res = await fetchRetry(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`setOrderStatus failed: ${res.status}`);
  logStatusChange({ order_id: orderId }, oldStatus, status, managerUsername);
  if (clientMessage && customerTgId) {
    await queueClientNotice(customerTgId, clientMessage, managerUsername, { order_id: orderId });
  }
  return true;
}

// Сменить статус обращения.
export async function setInquiryStatus(inquiryId, status, clientMessage, customerTgId, managerUsername, oldStatus = null, cancelReason = null) {
  const now = new Date().toISOString();
  const patch = { status, updated_at: now, status_changed_at: now };
  if (cancelReason != null) patch.cancel_reason = cancelReason;
  const res = await fetchRetry(`${BASE}/inquiries?id=eq.${encodeURIComponent(inquiryId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`setInquiryStatus failed: ${res.status}`);
  logStatusChange({ inquiry_id: inquiryId }, oldStatus, status, managerUsername);
  if (clientMessage && customerTgId) {
    await queueClientNotice(customerTgId, clientMessage, managerUsername, { inquiry_id: inquiryId });
  }
  return true;
}

// Записать смену статуса в историю (не критично — не блокируем основную операцию).
async function logStatusChange(context, oldStatus, newStatus, changedBy) {
  try {
    await fetchRetry(`${BASE}/status_history`, {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        order_id: context.order_id || null,
        inquiry_id: context.inquiry_id || null,
        old_status: oldStatus,
        new_status: newStatus,
        changed_by: changedBy || null,
      }),
    });
  } catch (e) { console.warn('logStatusChange failed:', e); }
  // И в общий audit-log
  logAudit({
    action: context.inquiry_id ? 'inquiry_status_change' : 'order_status_change',
    entity_type: context.inquiry_id ? 'inquiry' : 'order',
    entity_id: String(context.order_id || context.inquiry_id),
    manager: changedBy,
    details: { from: oldStatus, to: newStatus },
  });
}

// Универсальный журнал действий менеджера (#17).
// Не блокирует основную операцию — ошибки игнорируем.
export async function logAudit({ action, entity_type, entity_id, manager, details }) {
  try {
    await fetchRetry(`${BASE}/audit_log`, {
      method: 'POST',
      headers: { ...HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        manager: manager || null,
        action,
        entity_type: entity_type || null,
        entity_id: entity_id != null ? String(entity_id) : null,
        details: details || null,
      }),
    });
  } catch (e) { console.warn('logAudit failed:', e); }
}

// Журнал действий — фильтры опциональны. Возвращает последние N записей.
export async function loadAuditLog({ manager, entityType, entityId, limit = 200 } = {}) {
  const params = { select: '*', order: 'created_at.desc', limit: String(limit) };
  if (manager) params.manager = `eq.${manager}`;
  if (entityType) params.entity_type = `eq.${entityType}`;
  if (entityId) params.entity_id = `eq.${entityId}`;
  try { return await get('audit_log', params); } catch (e) { return []; }
}

// Постоянная заметка о клиенте (#14) — отдельно от заметок к заказам.
export async function setCustomerNote(tgId, note, manager) {
  const res = await fetchRetry(`${BASE}/customers?tg_id=eq.${encodeURIComponent(tgId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ manager_note: note, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`setCustomerNote failed: ${res.status}`);
  logAudit({ action: 'customer_note_set', entity_type: 'customer', entity_id: tgId, manager });
  return true;
}

// Объединить двух клиентов (#17): все заказы/обращения/сообщения от sourceId
// перемещаются на targetId, sourceId удаляется. Это нужно когда клиент пишет
// с другого аккаунта или появился дубль.
export async function mergeCustomers(sourceId, targetId, manager) {
  if (sourceId === targetId) throw new Error('Совпадают tg_id');
  // 1. Переносим заказы
  await fetchRetry(`${BASE}/orders?customer_tg_id=eq.${sourceId}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ customer_tg_id: targetId }),
  });
  // 2. Обращения
  await fetchRetry(`${BASE}/inquiries?customer_tg_id=eq.${sourceId}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ customer_tg_id: targetId }),
  });
  // 3. Сообщения
  await fetchRetry(`${BASE}/messages?customer_tg_id=eq.${sourceId}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ customer_tg_id: targetId }),
  });
  // 4. Корзина и избранное — удалим источника (чтобы не дублировать), цель оставим как есть
  await fetchRetry(`${BASE}/cart_items?customer_tg_id=eq.${sourceId}`, {
    method: 'DELETE', headers: { ...HEADERS, 'Prefer': 'return=minimal' },
  });
  await fetchRetry(`${BASE}/favorites?customer_tg_id=eq.${sourceId}`, {
    method: 'DELETE', headers: { ...HEADERS, 'Prefer': 'return=minimal' },
  });
  // 5. Удаляем самого клиента-источника
  await fetchRetry(`${BASE}/customers?tg_id=eq.${sourceId}`, {
    method: 'DELETE', headers: { ...HEADERS, 'Prefer': 'return=minimal' },
  });
  logAudit({
    action: 'customer_merge', entity_type: 'customer', entity_id: String(targetId),
    manager, details: { source: sourceId, target: targetId },
  });
  return true;
}

// Полный профиль клиента — для модалки/раздела.
export async function loadCustomerProfile(tgId) {
  const [custRows, orders, inquiries] = await Promise.all([
    get('customers', { select: '*', tg_id: `eq.${tgId}`, limit: '1' }).catch(() => []),
    get('orders', { select: '*,order_items(*)', customer_tg_id: `eq.${tgId}`, order: 'created_at.desc' }).catch(() => []),
    get('inquiries', { select: '*', customer_tg_id: `eq.${tgId}`, order: 'created_at.desc' }).catch(() => []),
  ]);
  return { customer: custRows[0] || null, orders, inquiries };
}

// Обновить цену позиции заказа (snapshot) + пересчёт + audit (#12).
export async function updateOrderItemPrice(itemId, priceUsd, priceByn, orderId, manager) {
  const res = await fetchRetry(`${BASE}/order_items?id=eq.${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      price_usd_snapshot: Number(priceUsd) || 0,
      price_byn_snapshot: Number(priceByn) || 0,
    }),
  });
  if (!res.ok) throw new Error(`updateOrderItemPrice failed: ${res.status}`);
  logAudit({
    action: 'order_item_price_change',
    entity_type: 'order_item', entity_id: itemId, manager,
    details: { order_id: orderId, price_usd: priceUsd, price_byn: priceByn },
  });
  return recalcOrderTotal(orderId);
}

// История статусов заказа/обращения (по возрастанию времени).
export async function loadStatusHistory(context) {
  const params = { select: '*', order: 'created_at.asc', limit: '100' };
  if (context.order_id != null) params.order_id = `eq.${context.order_id}`;
  else params.inquiry_id = `eq.${context.inquiry_id}`;
  try {
    return await get('status_history', params);
  } catch (e) { return []; }
}

// Назначить менеджера на заказ/обращение («Взять в работу»).
export async function assignManager(context, username) {
  const table = context.order_id != null ? 'orders' : 'inquiries';
  const id = context.order_id != null ? context.order_id : context.inquiry_id;
  const res = await fetchRetry(`${BASE}/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ assigned_to: username, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`assignManager failed: ${res.status}`);
  logAudit({
    action: 'assign', entity_type: context.order_id != null ? 'order' : 'inquiry',
    entity_id: String(id), manager: username, details: { to: username },
  });
  return true;
}

// Сохранить трек-номер заказа.
export async function setTrackingNumber(orderId, track, manager) {
  const res = await fetchRetry(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ tracking_number: track, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`setTrackingNumber failed: ${res.status}`);
  logAudit({ action: 'tracking_set', entity_type: 'order', entity_id: String(orderId), manager, details: { track } });
  return true;
}

// Отметить/снять оплату заказа.
export async function setPaid(orderId, isPaid, manager) {
  const res = await fetchRetry(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_paid: isPaid, paid_at: isPaid ? new Date().toISOString() : null, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`setPaid failed: ${res.status}`);
  logAudit({ action: isPaid ? 'paid_on' : 'paid_off', entity_type: 'order', entity_id: String(orderId), manager });
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
  const res = await fetchRetry(`${BASE}/order_items`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`addOrderItems failed: ${res.status}`);

  // 2. Пересчитываем сумму заказа по всем его позициям
  const allItems = await get('order_items', { select: '*', order_id: `eq.${orderId}` });
  const totalUsd = (allItems || []).reduce((s, it) => s + (Number(it.price_usd_snapshot) || 0) * (it.qty || 1), 0);
  const totalByn = (allItems || []).reduce((s, it) => s + (Number(it.price_byn_snapshot) || 0) * (it.qty || 1), 0);
  await fetchRetry(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ total_usd: totalUsd, total_byn: totalByn, updated_at: new Date().toISOString() }),
  });
  return { totalUsd, totalByn };
}

// Пересчитать и сохранить сумму заказа по его позициям.
async function recalcOrderTotal(orderId) {
  const allItems = await get('order_items', { select: '*', order_id: `eq.${orderId}` });
  const totalUsd = (allItems || []).reduce((s, it) => s + (Number(it.price_usd_snapshot) || 0) * (it.qty || 1), 0);
  const totalByn = (allItems || []).reduce((s, it) => s + (Number(it.price_byn_snapshot) || 0) * (it.qty || 1), 0);
  await fetchRetry(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ total_usd: totalUsd, total_byn: totalByn, updated_at: new Date().toISOString() }),
  });
  return { totalUsd, totalByn };
}

// Удалить позицию заказа (по id строки order_items) + пересчёт суммы.
export async function deleteOrderItem(itemId, orderId, manager) {
  const res = await fetchRetry(`${BASE}/order_items?id=eq.${encodeURIComponent(itemId)}`, {
    method: 'DELETE',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
  });
  if (!res.ok) throw new Error(`deleteOrderItem failed: ${res.status}`);
  logAudit({ action: 'order_item_delete', entity_type: 'order_item', entity_id: itemId, manager, details: { order_id: orderId } });
  return recalcOrderTotal(orderId);
}

// Изменить количество позиции + пересчёт суммы.
export async function updateOrderItemQty(itemId, qty, orderId, manager) {
  const newQty = Math.max(1, parseInt(qty) || 1);
  const res = await fetchRetry(`${BASE}/order_items?id=eq.${encodeURIComponent(itemId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ qty: newQty }),
  });
  if (!res.ok) throw new Error(`updateOrderItemQty failed: ${res.status}`);
  logAudit({ action: 'order_item_qty_change', entity_type: 'order_item', entity_id: itemId, manager, details: { order_id: orderId, qty: newQty } });
  return recalcOrderTotal(orderId);
}
export async function setOrderNote(orderId, note) {
  const res = await fetchRetry(`${BASE}/orders?id=eq.${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ manager_note: note }),
  });
  if (!res.ok) throw new Error(`setOrderNote failed: ${res.status}`);
  return true;
}

// ===== Закрепление заказа/обращения (#9) =====
// Закреплённые сортируются вверху, чтобы менеджер их не упускал.
export async function setPinned(context, pinned, manager) {
  const table = context.order_id != null ? 'orders' : 'inquiries';
  const id = context.order_id != null ? context.order_id : context.inquiry_id;
  const res = await fetchRetry(`${BASE}/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ pinned: !!pinned }),
  });
  if (!res.ok) throw new Error(`setPinned failed: ${res.status}`);
  logAudit({
    action: pinned ? 'pin' : 'unpin',
    entity_type: context.order_id != null ? 'order' : 'inquiry',
    entity_id: String(id), manager,
  });
  return true;
}

// ===== Передача заказа/обращения другому менеджеру (#13) =====
// От assignManager отличается тем, что фиксирует «передачу» как событие
// в audit-логе (не просто назначение, а смена ответственного).
export async function transferAssignment(context, fromUsername, toUsername) {
  const table = context.order_id != null ? 'orders' : 'inquiries';
  const id = context.order_id != null ? context.order_id : context.inquiry_id;
  const res = await fetchRetry(`${BASE}/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      assigned_to: toUsername,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`transferAssignment failed: ${res.status}`);
  logAudit({
    action: 'transfer',
    entity_type: context.order_id != null ? 'order' : 'inquiry',
    entity_id: String(id), manager: fromUsername,
    details: { from: fromUsername, to: toUsername },
  });
  return true;
}

// ===== Напоминания (#1) =====

// Создать напоминание для заказа/обращения.
// fireAt — ISO-таймстемп, когда напомнить. note — необязательная заметка.
export async function addReminder(context, fireAt, note, manager) {
  const row = {
    order_id: context.order_id || null,
    inquiry_id: context.inquiry_id || null,
    fire_at: fireAt,
    note: note || null,
    manager: manager || null,
  };
  const res = await fetchRetry(`${BASE}/reminders`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`addReminder failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const created = await res.json();
  logAudit({
    action: 'reminder_set',
    entity_type: context.order_id != null ? 'order' : 'inquiry',
    entity_id: String(context.order_id || context.inquiry_id),
    manager, details: { fire_at: fireAt, note },
  });
  return created[0] || created;
}

// Список активных напоминаний (для текущего менеджера и для всех).
// Активные = ещё не отменённые. Если manager задан — фильтрует по нему,
// иначе возвращает все (для суперадмина или сводных уведомлений).
export async function loadActiveReminders(manager) {
  const params = {
    select: '*',
    order: 'fire_at.asc',
    dismissed_at: 'is.null',
  };
  if (manager) params.manager = `eq.${manager}`;
  try { return await get('reminders', params); } catch (_) { return []; }
}

// Список напоминаний, которые УЖЕ должны были сработать (fire_at <= сейчас),
// но ещё не отменены. По ним показываем подсветку и алерт в админке.
export async function loadFiredReminders(manager) {
  const nowIso = new Date().toISOString();
  const params = {
    select: '*',
    order: 'fire_at.asc',
    dismissed_at: 'is.null',
    fire_at: `lte.${nowIso}`,
  };
  if (manager) params.manager = `eq.${manager}`;
  try { return await get('reminders', params); } catch (_) { return []; }
}

// Закрыть напоминание (менеджер отреагировал).
export async function dismissReminder(reminderId, manager) {
  const res = await fetchRetry(`${BASE}/reminders?id=eq.${encodeURIComponent(reminderId)}`, {
    method: 'PATCH',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ dismissed_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`dismissReminder failed: ${res.status}`);
  logAudit({ action: 'reminder_dismiss', entity_type: 'reminder', entity_id: String(reminderId), manager });
  return true;
}

// Список напоминаний для конкретного заказа/обращения (для показа в карточке).
export async function loadRemindersFor(context) {
  const params = {
    select: '*',
    order: 'fire_at.asc',
    dismissed_at: 'is.null',
  };
  if (context.order_id) params.order_id = `eq.${context.order_id}`;
  else if (context.inquiry_id) params.inquiry_id = `eq.${context.inquiry_id}`;
  else return [];
  try { return await get('reminders', params); } catch (_) { return []; }
}

// Создать заказ из обращения. items = [{product_id, size, qty, price_usd, price_byn}].
// Возвращает созданный заказ { id, ... }.
export async function createOrder(customerTgId, items, currency, inquiryId, status = 'in_progress') {
  const totalUsd = items.reduce((s, it) => s + (Number(it.price_usd) || 0) * (it.qty || 1), 0);
  const totalByn = items.reduce((s, it) => s + (Number(it.price_byn) || 0) * (it.qty || 1), 0);

  // 1. Создаём заказ
  const orderRes = await fetchRetry(`${BASE}/orders`, {
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
  const itemsRes = await fetchRetry(`${BASE}/order_items`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!itemsRes.ok) throw new Error(`createOrder items failed: ${itemsRes.status}`);

  // 3. Привязываем сообщения обращения к заказу (чтобы переписка продолжилась в заказе)
  if (inquiryId) {
    try {
      await fetchRetry(`${BASE}/messages?inquiry_id=eq.${inquiryId}`, {
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
  await fetchRetry(`${BASE}/outbox`, {
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
