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
    is_active: row.is_active !== false,
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
    is_active: p.is_active !== false,
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
  try {
    const fresh = await refreshFromDb();
    return fresh || [];
  } catch (e) {
    console.error('[supabase] loadProducts exception:', e);
    return [];
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

  const { data: existing, error: selErr } = await sb
    .from('customers').select('*').eq('tg_id', u.id).maybeSingle();
  if (selErr) {
    console.error('[supabase] ensureCustomer select error:', selErr.message);
  }

  if (!existing) {
    const insert = { ...baseFields, preferences: state.settings || {} };
    const { data, error } = await sb.from('customers').insert(insert).select().single();
    if (error) {
      console.error('[supabase] ensureCustomer insert error:', error.message);
      return null;
    }
    return data;
  }

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
    for (const k of ['first_name', 'last_name', 'username', 'photo_url', 'phone', 'birth_date']) {
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

// ============================== ИСТОРИЯ ==============================

export async function loadHistory() {
  try {
    const u = getUser();
    if (!u) return [];
    const sb = await getClient();

    const [ordersRes, reqsRes] = await Promise.all([
      sb.from('orders').select('*, order_items(*)')
        .eq('customer_tg_id', u.id).order('created_at', { ascending: false }),
      sb.from('requests').select('*')
        .eq('customer_tg_id', u.id).order('created_at', { ascending: false }),
    ]);

    if (ordersRes.error) console.error('[supabase] loadHistory orders:', ordersRes.error.message);
    if (reqsRes.error) console.error('[supabase] loadHistory requests:', reqsRes.error.message);

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

    const requests = (reqsRes.data || []).map(r => ({
      id: 'r' + r.id,
      type: 'request',
      date: r.created_at,
      payload: {
        text: r.text || '',
        photosCount: r.photos_count || 0,
      },
    }));

    const all = [...orders, ...requests];
    all.sort((a, b) => new Date(b.date) - new Date(a.date));
    return all;
  } catch (e) {
    console.error('[supabase] loadHistory exception:', e);
    return [];
  }
}

// ============================== ЗАКАЗЫ ==============================

export async function addOrder(order) {
  try {
    const u = getUser();
    if (!u) throw new Error('No Telegram user');
    const sb = await getClient();

    // FK requires customer present
    await ensureCustomer(sb);

    // Снапшоты цен товаров
    const products = await loadProducts();
    const productMap = new Map(products.map(p => [p.id, p]));

    const { data: newOrder, error: e1 } = await sb.from('orders').insert({
      customer_tg_id: u.id,
      total_usd: order.total_usd || 0,
      total_byn: order.total_byn || 0,
      currency: order.currency || 'USD',
      status: 'processing',
      is_paid: false,
    }).select().single();

    if (e1) {
      console.error('[supabase] addOrder: orders insert error:', e1.message);
      throw e1;
    }

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
      if (e2) console.error('[supabase] addOrder: order_items insert error:', e2.message);
    }

    return {
      id: 'o' + newOrder.id,
      dbId: newOrder.id,             // raw UUID — нужен для deep-link в бот
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
  } catch (e) {
    console.error('[supabase] addOrder exception:', e);
    throw e;
  }
}

// ============================== ЗАПРОСЫ ==============================

export async function addRequest(req) {
  try {
    const u = getUser();
    if (!u) throw new Error('No Telegram user');
    const sb = await getClient();
    await ensureCustomer(sb);

    const { data, error } = await sb.from('requests').insert({
      customer_tg_id: u.id,
      text: req.text || '',
      photos_count: req.photosCount || 0,
    }).select().single();

    if (error) {
      console.error('[supabase] addRequest error:', error.message);
      throw error;
    }
    return {
      id: 'r' + data.id,
      type: 'request',
      date: data.created_at,
      payload: { text: data.text, photosCount: data.photos_count || 0 },
    };
  } catch (e) {
    console.error('[supabase] addRequest exception:', e);
    throw e;
  }
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
