// Реализация API через Supabase.
//
// ⚠️ БЕЗОПАСНОСТЬ: текущая версия работает БЕЗ Row Level Security.
//   Анонимный ключ публичен в JS-коде, поэтому через DevTools любой может
//   читать/менять данные подменяя tg_id. Это режим прототипа.
//   Для прод-релиза нужно:
//     1. Включить RLS-политики (закомментированы внизу db/schema.sql)
//     2. Развернуть Edge Function для валидации Telegram initData
//     3. Заменить anon-ключ на JWT с tg_id в claims

import { CONFIG } from '../config.js';
import { getUser } from '../tg.js';
import { state } from '../state.js';
import * as productsCache from '../cache/products.js';

// Подгружаем supabase-js через ESM CDN. Один экземпляр клиента на всё приложение.
let _client = null;
let _clientPromise = null;

async function getClient() {
  if (_client) return _client;
  if (_clientPromise) return _clientPromise;

  _clientPromise = (async () => {
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY) {
      throw new Error('[supabase] SUPABASE_URL и SUPABASE_ANON_KEY не заполнены в config.js');
    }
    const mod = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
    _client = mod.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return _client;
  })();
  return _clientPromise;
}

// ============================== ПРОДУКТЫ ==============================

function rowToProduct(row) {
  return {
    id: row.id,
    name_ru: row.name_ru || '',
    name_en: row.name_en || '',
    desc_ru: row.desc_ru || '',
    desc_en: row.desc_en || '',
    price_usd: Number(row.price_usd) || 0,
    price_byn: Number(row.price_byn) || 0,
    images: Array.isArray(row.images) ? row.images : [],
    sizes: Array.isArray(row.sizes) ? row.sizes : [],
    stock: (row.stock && typeof row.stock === 'object') ? row.stock : {},
    is_active: row.is_active !== false,
    badge_text: row.badge_text || '',
    badge_color: row.badge_color || '',
    updated_at: row.updated_at || null,  // используется для сравнения в кэше
  };
}

function productToRow(p) {
  return {
    id: p.id,
    name_ru: p.name_ru || '',
    name_en: p.name_en || '',
    desc_ru: p.desc_ru || '',
    desc_en: p.desc_en || '',
    price_usd: Number(p.price_usd) || 0,
    price_byn: Number(p.price_byn) || 0,
    images: Array.isArray(p.images) ? p.images : (p.img ? [p.img] : []),
    sizes: Array.isArray(p.sizes) ? p.sizes : [],
    stock: (p.stock && typeof p.stock === 'object') ? p.stock : {},
    is_active: p.is_active !== false,
    badge_text: (p.badge_text || '').trim() || null,
    badge_color: (p.badge_color || '').trim() || null,
  };
}

let _seedAttempted = false;

async function seedIfEmpty(sb) {
  if (_seedAttempted) return;
  _seedAttempted = true;
  try {
    const r = await fetch(CONFIG.CATALOG_URL, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!Array.isArray(j?.catalog) || j.catalog.length === 0) return;
    const rows = j.catalog.map(productToRow);
    const { error } = await sb.from('products').insert(rows);
    if (error) {
      console.warn('[supabase] seed products failed:', error.message);
    } else {
      console.log('[supabase] seeded products from catalog.json:', rows.length);
    }
  } catch (e) {
    console.warn('[supabase] seed fetch failed:', e);
  }
}

// Внутренний метод: реально идёт в БД.
async function fetchProductsFromDb() {
  const sb = await getClient();
  let { data, error } = await sb.from('products').select('*').eq('is_active', true).order('id');
  if (error) {
    console.error('[supabase] loadProducts error:', error.message);
    return null;
  }
  if (!data || data.length === 0) {
    await seedIfEmpty(sb);
    const res2 = await sb.from('products').select('*').eq('is_active', true).order('id');
    data = res2.data || [];
  }
  return data.map(rowToProduct);
}

// Промис «текущий идущий fetch» — чтобы параллельные вызовы не плодили запросов.
let _inFlight = null;

async function refreshFromDb() {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const fresh = await fetchProductsFromDb();
      if (fresh) productsCache.setCache(fresh);
      return fresh;
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

export async function loadProducts() {
  const cached = productsCache.getCached();

  // 1. Есть кэш — отдаём моментально. Если он «свежий» (TTL не истёк) — не идём в сеть.
  if (cached) {
    if (!productsCache.isFresh()) {
      // Фоновое обновление без await — view получит обновлённый список через подписку.
      refreshFromDb().catch(e => console.warn('[supabase] background refresh failed:', e));
    }
    return cached;
  }

  // 2. Кэша нет — придётся подождать сеть.
  //    Если сеть упала и кэша нет — пробрасываем ошибку, чтобы view показал
  //    error-state (а не пустой каталог, который путают с «товаров нет»).
  try {
    const fresh = await refreshFromDb();
    return fresh || [];
  } catch (e) {
    console.error('[supabase] loadProducts exception:', e);
    // Последняя попытка — отдать сид-каталог как фолбэк
    const fallback = await loadSeedCatalog().catch(() => null);
    if (fallback && fallback.length) return fallback;
    throw e;   // ни кэша, ни сети, ни сида — пусть view покажет ошибку
  }
}

// Сид-каталог из catalog.json — последний фолбэк при недоступной БД.
async function loadSeedCatalog() {
  try {
    const res = await fetch(CONFIG.CATALOG_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    const arr = Array.isArray(j?.catalog) ? j.catalog
              : Array.isArray(j) ? j
              : (j.products || []);
    return arr.map(rowToProduct);
  } catch {
    return null;
  }
}

// Все товары (включая is_active=false) — для админки.
// Без кэширования: админ редко открывает список и ему нужна актуальная картина.
export async function loadAllProducts() {
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('products').select('*').order('id');
    if (error) {
      console.error('[supabase] loadAllProducts error:', error.message);
      return [];
    }
    return (data || []).map(rowToProduct);
  } catch (e) {
    console.error('[supabase] loadAllProducts exception:', e);
    return [];
  }
}

// Экспортируем подписку — чтобы view могли реагировать на обновление каталога.
export const onProductsChange = productsCache.subscribe;

// Полная синхронизация каталога:
// 1. Получаем текущие id в БД
// 2. Делаем upsert переданных
// 3. Удаляем те id, которые есть в БД но отсутствуют в переданных
// После — обновляем кэш свежими данными из БД (чтобы updated_at был актуальным).
export async function saveProducts(products) {
  try {
    const sb = await getClient();
    const rows = products.map(productToRow);
    const newIds = rows.map(r => r.id);

    const { data: existing, error: e1 } = await sb.from('products').select('id');
    if (e1) {
      console.error('[supabase] saveProducts: read ids error:', e1.message);
      throw e1;
    }
    const existingIds = (existing || []).map(r => r.id);

    if (rows.length > 0) {
      const { error: e2 } = await sb.from('products').upsert(rows, { onConflict: 'id' });
      if (e2) {
        console.error('[supabase] saveProducts: upsert error:', e2.message);
        throw e2;
      }
    }

    const toDelete = existingIds.filter(id => !newIds.includes(id));
    if (toDelete.length > 0) {
      const { error: e3 } = await sb.from('products').delete().in('id', toDelete);
      if (e3) {
        console.error('[supabase] saveProducts: delete error:', e3.message);
      }
    }

    // Сразу обновим кэш свежими данными
    productsCache.invalidate();
    await refreshFromDb();
  } catch (e) {
    console.error('[supabase] saveProducts exception:', e);
    throw e;
  }
}

// ============================== КЛИЕНТ ==============================

async function ensureCustomer(sb) {
  const u = getUser();
  if (!u) return null;

  const baseFields = {
    tg_id: u.id,
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    username: u.username || '',
    photo_url: u.photo_url || '',
  };

  // Проверяем, есть ли уже запись клиента
  const { data: existing } = await sb
    .from('customers').select('*').eq('tg_id', u.id).maybeSingle();

  if (!existing) {
    // Первый заход: создаём запись СРАЗУ с дефолтными настройками клиента.
    // Это фиксирует язык/тему/валюту, определённые при первом запуске.
    const insertRow = {
      ...baseFields,
      preferences: state.settings || {},
    };
    const { data, error } = await sb
      .from('customers').insert(insertRow).select().single();
    if (error) {
      // Возможна гонка: параллельный вызов уже создал запись. Перечитываем.
      console.warn('[supabase] ensureCustomer insert race, re-reading:', error.message);
      const { data: again } = await sb
        .from('customers').select('*').eq('tg_id', u.id).maybeSingle();
      return again || null;
    }
    return data;
  }

  // Запись уже есть: обновляем только идентификационные поля (имя/username/фото),
  // НЕ трогая preferences и purchases_total.
  const { data, error } = await sb
    .from('customers').update(baseFields).eq('tg_id', u.id).select().single();
  if (error) {
    console.error('[supabase] ensureCustomer update error:', error.message);
    return existing;
  }
  return data;
}

export async function loadCustomer() {
  try {
    const u = getUser();
    if (!u) return null;
    const sb = await getClient();
    return await ensureCustomer(sb);
  } catch (e) {
    console.error('[supabase] loadCustomer exception:', e);
    return null;
  }
}

// Список менеджеров (для проверки доступа к админке). Возвращает массив
// { tg_id, username, is_on_duty }. Суперадмин проверяется отдельно через config.
export async function loadManagers() {
  try {
    const sb = await getClient();
    const { data, error } = await sb.from('managers').select('tg_id, username, is_on_duty');
    if (error) {
      console.error('[supabase] loadManagers error:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('[supabase] loadManagers exception:', e);
    return [];
  }
}

export async function upsertCustomer(patch) {
  try {
    const u = getUser();
    if (!u) return null;
    const sb = await getClient();

    const update = {};
    if (patch.preferences !== undefined) {
      const { data: cur } = await sb.from('customers')
        .select('preferences').eq('tg_id', u.id).maybeSingle();
      const merged = { ...(cur?.preferences || {}), ...patch.preferences };
      update.preferences = merged;
    }
    for (const k of ['first_name', 'last_name', 'username', 'photo_url', 'phone', 'birth_date', 'onboarded']) {
      if (patch[k] !== undefined) update[k] = patch[k];
    }
    if (Object.keys(update).length === 0) {
      return await ensureCustomer(sb);
    }
    const { data, error } = await sb.from('customers')
      .update(update).eq('tg_id', u.id).select().single();
    if (error) {
      console.error('[supabase] upsertCustomer error:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.error('[supabase] upsertCustomer exception:', e);
    return null;
  }
}

// Помечает онбординг как пройденный — пишет TRUE в customers.onboarded.
export async function markOnboarded() {
  try {
    const u = getUser();
    if (!u) return;
    const sb = await getClient();
    const { error } = await sb.from('customers')
      .update({ onboarded: true }).eq('tg_id', u.id);
    if (error) console.error('[supabase] markOnboarded error:', error.message);
  } catch (e) {
    console.error('[supabase] markOnboarded exception:', e);
  }
}

// ============================== ИСТОРИЯ ==============================

export async function loadHistory() {
  try {
    const u = getUser();
    if (!u) return [];
    const sb = await getClient();

    const [ordersRes, inqRes] = await Promise.all([
      sb.from('orders').select('*, order_items(*)')
        .eq('customer_tg_id', u.id).order('created_at', { ascending: false }),
      sb.from('inquiries').select('*')
        .eq('customer_tg_id', u.id).order('created_at', { ascending: false }),
    ]);

    if (ordersRes.error) console.error('[supabase] loadHistory orders:', ordersRes.error.message);
    if (inqRes.error) console.error('[supabase] loadHistory inquiries:', inqRes.error.message);

    // Если оба запроса упали — это сетевая ошибка, а не «история пуста».
    if (ordersRes.error && inqRes.error) {
      throw new Error('history load failed');
    }

    const orders = (ordersRes.data || []).map(o => ({
      id: 'o' + o.id,
      type: 'order',
      date: o.created_at,
      status: o.status,
      isPaid: !!o.is_paid,
      eta: o.eta,
      payload: {
        items: (o.order_items || []).map(it => ({
          productId: it.product_id,
          size: it.size,
          qty: it.qty,
        })),
        total_usd: Number(o.total_usd) || 0,
        total_byn: Number(o.total_byn) || 0,
        currency: o.currency || 'USD',
      },
    }));

    // Обращения (запросы на подбор и вопросы по товарам)
    const inquiries = (inqRes.data || []).map(q => ({
      id: 'i' + q.id,
      type: 'inquiry',
      date: q.created_at,
      status: q.status,                 // new | in_progress | closed
      payload: {
        inquiryType: q.type,            // request | product_question
        productId: q.product_id || null,
        number: q.number || null,
      },
    }));

    const all = [...orders, ...inquiries];
    all.sort((a, b) => new Date(b.date) - new Date(a.date));
    return all;
  } catch (e) {
    console.error('[supabase] loadHistory exception:', e);
    throw e;   // пусть view покажет error-state с кнопкой «Повторить»
  }
}

// ============================== ЗАКАЗЫ ==============================

export async function addOrder(order) {
  const u = getUser();
  if (!u) throw new Error('No Telegram user');
  const sb = await getClient();

  // 1. Гарантируем существование customer-а (FK constraint на customer_tg_id).
  //    Если не удалось — заказ оформить нельзя.
  const customer = await ensureCustomer(sb);
  if (!customer) {
    throw new Error('Не удалось зарегистрировать клиента в БД');
  }

  // 2. Снапшоты цен — из текущего кэша или прямо из БД (для скрытых товаров).
  //    Если товар в корзине больше не активен — берём его всё равно (по id),
  //    т.к. он может быть просто скрыт, но в БД есть и FK не упадёт.
  const products = await loadProducts();
  const productMap = new Map(products.map(p => [p.id, p]));
  const missingIds = (order.items || [])
    .map(it => it.productId)
    .filter(id => !productMap.has(id));
  if (missingIds.length > 0) {
    // Дочитаем по id (включая is_active=false) — нам нужны снапшоты цен
    const { data: extras } = await sb.from('products').select('*').in('id', missingIds);
    (extras || []).forEach(p => productMap.set(p.id, p));
  }

  // 3. Создаём заказ. Если падает — пробрасываем оригинальное сообщение.
  const { data: newOrder, error: e1 } = await sb.from('orders').insert({
    customer_tg_id: u.id,
    total_usd: order.total_usd || 0,
    total_byn: order.total_byn || 0,
    currency: order.currency || 'USD',
    status: 'new',
    is_paid: false,
  }).select().single();

  if (e1) {
    console.error('[supabase] addOrder: orders insert error:', e1.message);
    throw new Error(e1.message || 'Не удалось создать заказ');
  }

  // 4. Добавляем позиции. Если упадёт — откатываем заказ.
  const itemRows = (order.items || []).map(it => {
    const prod = productMap.get(it.productId);
    return {
      order_id: newOrder.id,
      product_id: it.productId,
      size: it.size,
      qty: it.qty || 1,
      price_usd_snapshot: prod?.price_usd || 0,
      price_byn_snapshot: prod?.price_byn || 0,
    };
  });
  if (itemRows.length > 0) {
    const { error: e2 } = await sb.from('order_items').insert(itemRows);
    if (e2) {
      console.error('[supabase] addOrder: order_items insert error:', e2.message);
      // Rollback — удаляем создавшийся заказ, иначе у клиента будет
      // «пустой заказ» в истории, а у менеджера — заказ без позиций
      await sb.from('orders').delete().eq('id', newOrder.id);
      throw new Error(e2.message || 'Не удалось сохранить позиции заказа');
    }
  }

  return {
    id: 'o' + newOrder.id,
    dbId: newOrder.id,
    type: 'order',
    date: newOrder.created_at,
    status: newOrder.status,
    isPaid: !!newOrder.is_paid,
    eta: newOrder.eta,
    payload: {
      items: order.items || [],
      total_usd: Number(newOrder.total_usd) || 0,
      total_byn: Number(newOrder.total_byn) || 0,
      currency: newOrder.currency || 'USD',
    },
  };
}

// ============================== FAVORITES ==============================
//
// Схема: favorites(customer_tg_id, product_id, size) с композитным PK.
// size '' = «без размера» (например, товар у которого только 1 размер,
// или клиент добавил в избранное со страницы списка без выбора размера).

export async function loadFavorites() {
  try {
    const u = getUser();
    if (!u) return [];
    const sb = await getClient();
    await ensureCustomer(sb);

    const { data, error } = await sb.from('favorites')
      .select('product_id, size')
      .eq('customer_tg_id', u.id);
    if (error) {
      console.error('[supabase] loadFavorites error:', error.message);
      return [];
    }
    return (data || []).map(r => ({
      productId: r.product_id,
      size: r.size || null,   // нормализуем пустую строку в null для удобства state.js
    }));
  } catch (e) {
    console.error('[supabase] loadFavorites exception:', e);
    return [];
  }
}

export async function addFavorite(productId, size) {
  try {
    const u = getUser();
    if (!u) return;
    const sb = await getClient();
    await ensureCustomer(sb);
    const { error } = await sb.from('favorites').upsert({
      customer_tg_id: u.id,
      product_id: productId,
      size: size || '',
    }, { onConflict: 'customer_tg_id,product_id,size' });
    if (error) console.error('[supabase] addFavorite error:', error.message);
  } catch (e) {
    console.error('[supabase] addFavorite exception:', e);
  }
}

export async function removeFavorite(productId, size) {
  try {
    const u = getUser();
    if (!u) return;
    const sb = await getClient();
    const { error } = await sb.from('favorites').delete()
      .eq('customer_tg_id', u.id)
      .eq('product_id', productId)
      .eq('size', size || '');
    if (error) console.error('[supabase] removeFavorite error:', error.message);
  } catch (e) {
    console.error('[supabase] removeFavorite exception:', e);
  }
}

// ============================== CART ==============================
//
// Схема: cart_items(customer_tg_id, product_id, size, qty)
// Композитный PK по (customer_tg_id, product_id, size) — один и тот же товар
// с одним и тем же размером не может появиться дважды, qty увеличивается.

export async function loadCart() {
  try {
    const u = getUser();
    if (!u) return [];
    const sb = await getClient();
    await ensureCustomer(sb);

    const { data, error } = await sb.from('cart_items')
      .select('product_id, size, qty')
      .eq('customer_tg_id', u.id);
    if (error) {
      console.error('[supabase] loadCart error:', error.message);
      return [];
    }
    return (data || []).map(r => ({
      productId: r.product_id,
      size: r.size || null,
      qty: r.qty || 1,
    }));
  } catch (e) {
    console.error('[supabase] loadCart exception:', e);
    return [];
  }
}

// Записать одну позицию (upsert: создаст или обновит qty)
export async function setCartItem(productId, size, qty) {
  try {
    const u = getUser();
    if (!u) return;
    const sb = await getClient();
    await ensureCustomer(sb);
    if (qty <= 0) {
      const { error } = await sb.from('cart_items').delete()
        .eq('customer_tg_id', u.id)
        .eq('product_id', productId)
        .eq('size', size || '');
      if (error) console.error('[supabase] setCartItem delete error:', error.message);
      return;
    }
    const { error } = await sb.from('cart_items').upsert({
      customer_tg_id: u.id,
      product_id: productId,
      size: size || '',
      qty,
    }, { onConflict: 'customer_tg_id,product_id,size' });
    if (error) console.error('[supabase] setCartItem upsert error:', error.message);
  } catch (e) {
    console.error('[supabase] setCartItem exception:', e);
  }
}

export async function removeCartItem(productId, size) {
  try {
    const u = getUser();
    if (!u) return;
    const sb = await getClient();
    const { error } = await sb.from('cart_items').delete()
      .eq('customer_tg_id', u.id)
      .eq('product_id', productId)
      .eq('size', size || '');
    if (error) console.error('[supabase] removeCartItem error:', error.message);
  } catch (e) {
    console.error('[supabase] removeCartItem exception:', e);
  }
}

// Очистить всю корзину клиента (после checkout)
export async function clearCart() {
  try {
    const u = getUser();
    if (!u) return;
    const sb = await getClient();
    const { error } = await sb.from('cart_items').delete()
      .eq('customer_tg_id', u.id);
    if (error) console.error('[supabase] clearCart error:', error.message);
  } catch (e) {
    console.error('[supabase] clearCart exception:', e);
  }
}
