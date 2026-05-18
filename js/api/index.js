// Фасад API. Меняйте CONFIG.API_MODE между 'local' и 'supabase'.
//
// Контракт (что должна реализовать каждая реализация):
//   loadProducts()                     -> Promise<Product[]>
//   saveProducts(products)             -> Promise<void>            (только в local — admin export)
//   loadHistory()                      -> Promise<HistoryItem[]>
//   addOrder(order)                    -> Promise<Order>           // создаёт заказ с status='processing', isPaid=false
//   addRequest(request)                -> Promise<HistoryItem>     // запрос-подбор из чата
//   loadCustomer()                     -> Promise<Customer | null>
//   upsertCustomer(patch)              -> Promise<Customer>
//
// Product: { id, name_ru, name_en, desc_ru, desc_en, price_usd, price_byn, images, sizes }
// Customer: { tg_id, first_name, last_name, username, phone, birth_date, purchases_total, preferences }
// Order: { id, customer_id, items, total_usd, total_byn, currency, status, is_paid, eta, created_at }
// HistoryItem (для UI): { id, type, date, payload, status?, isPaid?, eta? }

import { CONFIG } from '../config.js';
import * as local from './local.js';
import * as supabase from './supabase.js';

const impls = { local, supabase };

function impl() {
  return impls[CONFIG.API_MODE] || impls.local;
}

export const api = {
  loadProducts: (...a) => impl().loadProducts(...a),
  saveProducts: (...a) => impl().saveProducts(...a),
  loadHistory: (...a) => impl().loadHistory(...a),
  addOrder: (...a) => impl().addOrder(...a),
  addRequest: (...a) => impl().addRequest(...a),
  loadCustomer: (...a) => impl().loadCustomer(...a),
  upsertCustomer: (...a) => impl().upsertCustomer(...a),
};
