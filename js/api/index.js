// Фасад API. Меняйте CONFIG.API_MODE между 'local' и 'supabase'.
//
// Контракт (что должна реализовать каждая реализация):
//   loadProducts()                     -> Promise<Product[]>
//   saveProducts(products)             -> Promise<void>            (только в local — admin export)
//   loadHistory()                      -> Promise<HistoryItem[]>
//   addOrder(order)                    -> Promise<Order>
//   addRequest(request)                -> Promise<HistoryItem>
//   loadCustomer()                     -> Promise<Customer | null>
//   upsertCustomer(patch)              -> Promise<Customer>
//   loadFavorites()                    -> Promise<Array<{productId, size}>>
//   addFavorite(productId, size)       -> Promise<void>
//   removeFavorite(productId, size)    -> Promise<void>
//   onProductsChange(callback)         -> () => void  (unsubscribe)
//
// Все методы должны возвращать одинаковые структуры независимо от реализации —
// UI не должен знать что под капотом (local или supabase).

import { CONFIG } from '../config.js';
import * as local from './local.js';
import * as supabase from './supabase.js';

const impls = { local, supabase };

function impl() {
  return impls[CONFIG.API_MODE] || impls.local;
}

// Заглушка для unsubscribe если реализация не поддерживает подписку
const noop = () => {};

export const api = {
  loadProducts: (...a) => impl().loadProducts(...a),
  saveProducts: (...a) => impl().saveProducts(...a),
  loadHistory: (...a) => impl().loadHistory(...a),
  addOrder: (...a) => impl().addOrder(...a),
  addRequest: (...a) => impl().addRequest(...a),
  loadCustomer: (...a) => impl().loadCustomer(...a),
  upsertCustomer: (...a) => impl().upsertCustomer(...a),
  loadFavorites: (...a) => (impl().loadFavorites ? impl().loadFavorites(...a) : Promise.resolve(null)),
  addFavorite: (...a) => (impl().addFavorite ? impl().addFavorite(...a) : Promise.resolve()),
  removeFavorite: (...a) => (impl().removeFavorite ? impl().removeFavorite(...a) : Promise.resolve()),
  loadCart: (...a) => (impl().loadCart ? impl().loadCart(...a) : Promise.resolve(null)),
  setCartItem: (...a) => (impl().setCartItem ? impl().setCartItem(...a) : Promise.resolve()),
  removeCartItem: (...a) => (impl().removeCartItem ? impl().removeCartItem(...a) : Promise.resolve()),
  clearCart: (...a) => (impl().clearCart ? impl().clearCart(...a) : Promise.resolve()),
  onProductsChange: (cb) => (impl().onProductsChange ? impl().onProductsChange(cb) : noop),
};
