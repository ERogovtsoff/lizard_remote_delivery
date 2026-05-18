// Корзина. Подтверждение на удаление (правка #9), сумма в двух валютах.
import { t, getLang, localizedProduct } from '../i18n.js';
import { escapeHtml, formatPrice } from '../utils.js';
import { state, changeCartQty, removeFromCart, cartKey, clearLocalCart } from '../state.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { showConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { haptic, sendToBot } from '../tg.js';

export async function renderCart() {
  const page = document.getElementById('page-cart');
  page.innerHTML = `
    <h2>${escapeHtml(t('cartTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('cartSub'))}</p>
    <div id="cartList"></div>
    <div id="cartTotal"></div>
    <div class="empty-state" id="cartEmpty" style="display:none">
      <div class="icon">🛒</div>
      <h3>${escapeHtml(t('cartEmptyTitle'))}</h3>
      <p>${escapeHtml(t('cartEmptyText'))}</p>
    </div>
  `;
  const products = await api.loadProducts();
  const map = new Map(products.map(p => [p.id, p]));

  function render() {
    const list = document.getElementById('cartList');
    const totalBox = document.getElementById('cartTotal');
    const empty = document.getElementById('cartEmpty');
    const lang = getLang();
    const cur = state.settings.currency;

    list.innerHTML = ''; totalBox.innerHTML = '';
    if (state.cart.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    let totalUsd = 0, totalByn = 0;
    state.cart.forEach(item => {
      const prod = map.get(item.productId);
      if (!prod) return;
      const p = localizedProduct(prod, cur);
      totalUsd += (prod.price_usd || 0) * item.qty;
      totalByn += (prod.price_byn || 0) * item.qty;

      const row = document.createElement('div');
      row.className = 'cart-item';
      const mainImg = (prod.images && prod.images[0]) || prod.img || '';
      row.innerHTML = `
        <img src="${escapeHtml(mainImg)}" alt="">
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(p.name)}</div>
          ${item.size ? `<div class="cart-item-size">${escapeHtml(item.size)}</div>` : ''}
          <div class="cart-item-price">${formatPrice(p.price * item.qty, cur, lang)}</div>
          <div class="cart-item-controls">
            <button class="qty-btn" data-act="dec">−</button>
            <span class="qty-val">${item.qty}</span>
            <button class="qty-btn" data-act="inc">+</button>
            <button class="remove-btn" data-act="rm" aria-label="Remove">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
            </button>
          </div>
        </div>`;
      row.querySelector('[data-act="dec"]').onclick = () => {
        if (item.qty === 1) {
          showConfirm({
            icon: '🛒',
            title: t('confirmRemoveCartTitle'),
            text: t('confirmRemoveCartText'),
            yes: t('confirmYes'), no: t('confirmNo'), danger: true,
            onYes: () => { removeFromCart(item.productId, item.size); haptic('light'); render(); }
          });
        } else {
          changeCartQty(item.productId, item.size, -1); render();
        }
      };
      row.querySelector('[data-act="inc"]').onclick = () => {
        changeCartQty(item.productId, item.size, +1); render();
      };
      row.querySelector('[data-act="rm"]').onclick = () => {
        showConfirm({
          icon: '🛒',
          title: t('confirmRemoveCartTitle'),
          text: t('confirmRemoveCartText'),
          yes: t('confirmYes'), no: t('confirmNo'), danger: true,
          onYes: () => { removeFromCart(item.productId, item.size); haptic('light'); render(); }
        });
      };
      list.appendChild(row);
    });

    const mainTotal = cur === 'USD' ? totalUsd : totalByn;
    totalBox.innerHTML = `
      <div class="cart-total">
        <div class="cart-total-label">${escapeHtml(t('cartTotal'))}</div>
        <div class="cart-total-val">${escapeHtml(formatPrice(mainTotal, cur, lang))}</div>
      </div>
      <button class="primary-btn" id="checkoutBtn">${escapeHtml(t('checkout'))}</button>
    `;
    document.getElementById('checkoutBtn').onclick = () => checkout(map, totalUsd, totalByn);
  }
  render();
}

async function checkout(productsMap, totalUsd, totalByn) {
  const cur = state.settings.currency;
  const lang = getLang();
  const items = state.cart.map(c => ({ productId: c.productId, size: c.size, qty: c.qty }));

  // Сохраняем заказ
  await api.addOrder({
    items,
    total_usd: totalUsd,
    total_byn: totalByn,
    currency: cur,
  });

  // Полные позиции для бота (бот ожидает name_ru/name_en/price_usd/price_byn/qty/size)
  const itemsForBot = state.cart.map(c => {
    const prod = productsMap.get(c.productId);
    return {
      id: c.productId,
      name_ru: prod?.name_ru || '',
      name_en: prod?.name_en || '',
      size: c.size || null,
      qty: c.qty,
      price_usd: prod?.price_usd || 0,
      price_byn: prod?.price_byn || 0,
    };
  });

  const mainTotal = cur === 'USD' ? totalUsd : totalByn;

  // Текст для fallback-режима (когда бот недоступен)
  const lines = [t('orderMsgHeader'), ''];
  state.cart.forEach(c => {
    const prod = productsMap.get(c.productId);
    if (!prod) return;
    const p = localizedProduct(prod, cur);
    const sz = c.size ? ` (${c.size})` : '';
    lines.push(`• ${p.name}${sz} × ${c.qty} — ${formatPrice(p.price * c.qty, cur, lang)}`);
  });
  lines.push('');
  lines.push(`${t('orderMsgTotal')}: ${formatPrice(mainTotal, cur, lang)}`);
  const fallbackText = lines.join('\n');

  // Чистим корзину локально + в БД одной операцией (через syncer).
  clearLocalCart();
  haptic('success');

  // Сразу даём пользователю фидбек и уводим в историю, чтобы он видел свой заказ.
  // Это работает одинаково независимо от того, сработает sendData или нет:
  //   - Если sendData сработает → Telegram сам закроет апку поверх (наш переход
  //     в историю в этом случае не виден, но и не мешает)
  //   - Если нет → пользователь остаётся в апке на странице «История» и видит
  //     свой только что созданный заказ
  showToast(t('orderPlaced'), 3000);
  router.navigate('history');

  // Контракт payload — то, что ожидает bot.py (см. handle_order)
  const payload = {
    type: 'order',
    items: itemsForBot,
    total: mainTotal,
    currency: cur,
  };
  const result = await sendToBot(payload, fallbackText);

  if (result.mode === 'fallback') {
    showToast(t('msgSentFallback'), 5000);
  } else if (result.mode === 'failed') {
    showToast(t('msgSentFailed'), 4000);
  }
  // mode === 'sent' → Telegram закроет апку, ничего больше не делаем
}
