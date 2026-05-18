// Фасад API. Все методы реализованы в supabase.js.
//
// Использование:
//   import { api } from './api/index.js';
//   const products = await api.loadProducts();
//
// Контракт:
//   loadProducts()                        -> Product[]
//   saveProducts(products)                -> void
//   loadHistory()                         -> HistoryItem[]
//   addOrder(order)                       -> HistoryItem
//   addRequest(request)                   -> HistoryItem
//   loadCustomer()                        -> Customer | null
//   upsertCustomer(patch)                 -> Customer
//   loadFavorites()                       -> Array<{productId, size}>
//   addFavorite(productId, size)          -> void
//   removeFavorite(productId, size)       -> void
//   loadCart()                            -> Array<{productId, size, qty}>
//   setCartItem(productId, size, qty)     -> void
//   removeCartItem(productId, size)       -> void
//   clearCart()                           -> void
//   onProductsChange(callback)            -> unsubscribe function

import * as supabase from './supabase.js';

export const api = supabase;
