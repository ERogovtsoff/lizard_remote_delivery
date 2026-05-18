// Заглушка Supabase API. Не активна, пока CONFIG.API_MODE === 'local'.
//
// Чтобы её включить:
//   1. Создайте проект на supabase.com
//   2. В SQL Editor выполните содержимое db/schema.sql
//   3. Откройте Project Settings → API, скопируйте:
//        - Project URL  → CONFIG.SUPABASE_URL
//        - anon public key → CONFIG.SUPABASE_ANON_KEY
//   4. Замените CONFIG.API_MODE = 'supabase'
//   5. (Когда будет готов бэк) Разверните Edge Function для валидации initData
//      и хранения JWT; здесь нужно будет добавить заголовок Authorization.
//
// ВАЖНО ПО БЕЗОПАСНОСТИ:
//   - tg.initDataUnsafe.user НЕЛЬЗЯ доверять. Это публичная информация, её можно подделать.
//   - До появления Edge Function валидации, режим 'supabase' будет работать только для
//     демонстрации (запись/чтение по tg_id без проверки). Не публикуйте секретные данные
//     до настройки Row Level Security и валидации initData.
//
// API сам не подгружает supabase-js. В реальной интеграции:
//   import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
//   const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY)

import { CONFIG } from '../config.js';
import { getUser } from '../tg.js';

function notImplemented(method) {
  console.warn(`[supabase api] ${method} ещё не реализован. Переключитесь на CONFIG.API_MODE='local'.`);
}

export async function loadProducts() {
  notImplemented('loadProducts');
  // TODO:
  //   const { data, error } = await sb.from('products').select('*').eq('is_active', true);
  //   return data;
  return [];
}

export async function saveProducts(products) {
  notImplemented('saveProducts');
  // TODO: upsert по id; в проде делать через Edge Function с проверкой админ-прав
}

export async function loadHistory() {
  notImplemented('loadHistory');
  // TODO:
  //   const user = getUser();
  //   const { data: orders } = await sb.from('orders')
  //     .select('*, order_items(*)')
  //     .eq('customer_tg_id', user.id)
  //     .order('created_at', { ascending: false });
  //   const { data: reqs } = await sb.from('requests')
  //     .select('*').eq('customer_tg_id', user.id).order('created_at', { ascending: false });
  //   // объединить и отсортировать по дате, привести к виду HistoryItem
  return [];
}

export async function addOrder(order) {
  notImplemented('addOrder');
  // TODO:
  //   const user = getUser();
  //   const { data: newOrder } = await sb.from('orders').insert({
  //     customer_tg_id: user.id,
  //     total_usd: order.total_usd,
  //     total_byn: order.total_byn,
  //     currency: order.currency,
  //     status: 'processing',
  //     is_paid: false,
  //   }).select().single();
  //   await sb.from('order_items').insert(
  //     order.items.map(i => ({ order_id: newOrder.id, product_id: i.productId, size: i.size, qty: i.qty }))
  //   );
  //   return newOrder;
  return null;
}

export async function addRequest(req) {
  notImplemented('addRequest');
  // TODO:
  //   const user = getUser();
  //   const { data } = await sb.from('requests').insert({
  //     customer_tg_id: user.id, text: req.text, photos_count: req.photosCount
  //   }).select().single();
  //   return data;
  return null;
}

export async function loadCustomer() {
  notImplemented('loadCustomer');
  // TODO:
  //   const user = getUser();
  //   await sb.from('customers').upsert({
  //     tg_id: user.id, first_name: user.first_name, last_name: user.last_name,
  //     username: user.username, photo_url: user.photo_url,
  //   }, { onConflict: 'tg_id' });
  //   const { data } = await sb.from('customers').select('*').eq('tg_id', user.id).single();
  //   return data;
  return null;
}

export async function upsertCustomer(patch) {
  notImplemented('upsertCustomer');
  // TODO: sb.from('customers').update(patch).eq('tg_id', getUser().id)
  return null;
}
