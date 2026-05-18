// Сетка товаров с diff-rendering.
//
// Зачем: предотвратить моргание <img> при переходе главная → деталь → главная
// и при обновлениях каталога. Если карточка уже есть в DOM и её данные не
// изменились — она остаётся как есть, браузер не пересчитывает layout.
//
// Стратегия:
//   1. Каждая карточка имеет «ключ» (стабильный id) и «хеш» (компактное представление
//      данных, отображаемых в карточке: цена, имя, доступность, состояние избранного).
//   2. При update(): для каждой нужной карточки смотрим, есть ли уже DOM с этим ключом.
//      Если есть и хеш совпадает — оставляем. Если хеш изменился — пересоздаём.
//      Если такого DOM нет — создаём. Удаляем DOM, чей ключ больше не нужен.
//   3. Расставляем в правильном порядке через after()/prepend().

import { createProductCard } from './product-card.js';
import { state } from '../state.js';

function cardKey(prod, favSize) {
  return favSize !== undefined ? prod.id + '::' + (favSize || '') : prod.id;
}

// Хеш-строка, по изменению которой нужно пересоздать карточку.
// Включает всё что может рендериться в карточке + состояние избранного.
function cardHash(prod, favSize, currency) {
  const fav = favSize !== undefined
    ? state.favorites.some(f => f.productId === prod.id && (f.size || null) === (favSize || null))
    : state.favorites.some(f => f.productId === prod.id);
  const img0 = (prod.images && prod.images[0]) || '';
  return [
    prod.id,
    prod.name_ru, prod.name_en,
    prod.price_usd, prod.price_byn,
    img0,
    currency,
    fav ? '1' : '0',
    favSize ?? '',
  ].join('|');
}

export function createProductGrid({ source = 'home', favSizeBy = null, onCardChange = null } = {}) {
  const el = document.createElement('div');
  el.className = 'products-grid';

  // key → { node, hash }
  const cards = new Map();

  function makeCard(prod, favSize) {
    return createProductCard(prod, {
      source,
      showSize: favSize || undefined,
      favSize,
      onChange: onCardChange,
    });
  }

  function update(items) {
    const currency = state.settings.currency;
    const wantedKeys = new Set();

    // Сначала создаём/обновляем нужные карточки
    items.forEach(prod => {
      const favSize = favSizeBy ? favSizeBy(prod) : undefined;
      const key = cardKey(prod, favSize);
      const hash = cardHash(prod, favSize, currency);
      wantedKeys.add(key);

      const existing = cards.get(key);
      if (existing && existing.hash === hash) {
        // Без изменений — оставляем
        return;
      }
      if (existing) {
        // Хеш изменился — заменяем DOM-элемент на месте
        const newNode = makeCard(prod, favSize);
        existing.node.replaceWith(newNode);
        cards.set(key, { node: newNode, hash });
      } else {
        // Новая карточка
        const node = makeCard(prod, favSize);
        cards.set(key, { node, hash });
      }
    });

    // Удаляем те, что не нужны больше
    for (const [key, entry] of cards) {
      if (!wantedKeys.has(key)) {
        entry.node.remove();
        cards.delete(key);
      }
    }

    // Расставляем в правильном порядке
    let prev = null;
    items.forEach(prod => {
      const favSize = favSizeBy ? favSizeBy(prod) : undefined;
      const key = cardKey(prod, favSize);
      const node = cards.get(key).node;
      const expected = prev ? prev.nextSibling : el.firstChild;
      if (expected !== node) {
        if (prev) prev.after(node);
        else el.prepend(node);
      }
      prev = node;
    });
  }

  function clear() {
    cards.forEach(({ node }) => node.remove());
    cards.clear();
  }

  return { element: el, update, clear };
}
