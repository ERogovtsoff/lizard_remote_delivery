// Корзина: список позиций с возможностью править количество, удалять и оформить заказ.
import { t, getLang, localizedProduct } from '../i18n.js';
import { escapeHtml, formatPrice } from '../utils.js';
import { state, changeCartQty, removeFromCart, cartKey, clearLocalCart } from '../state.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { showConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { haptic, openBotChat } from '../tg.js';

export async function renderCart() {
  const page = document.getElementById('page-cart');
  page.innerHTML = `
    <h2>${escapeHtml(t('cartTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('cartSub'))}</p>
    <div id="cartList"></div>
    <div class="empty-state" id="cartEmpty" style="display:none">
      <div class="icon">🛒</div>
      <h3>${escapeHtml(t('cartEmptyTitle'))}</h3>
      <p>${escapeHtml(t('cartEmptyText'))}</p>
      <div class="empty-state-links">
        <a class="empty-state-link" id="cartEmptyCatalog">${escapeHtml(t('cartEmptyLinkCatalog'))}</a>
        <span class="empty-state-link-sep">${escapeHtml(t('orJoin'))}</span>
        <a class="empty-state-link" id="cartEmptyOrder">${escapeHtml(t('cartEmptyLinkOrder'))}</a>
      </div>
    </div>
    <div id="cartTotalBox"></div>
  `;

  // Ссылки в empty-state
  const catLink = document.getElementById('cartEmptyCatalog');
  const ordLink = document.getElementById('cartEmptyOrder');
  if (catLink) catLink.onclick = () => router.navigate('catalog');
  if (ordLink) ordLink.onclick = () => router.navigate('chat');

  const products = await api.loadProducts();
  const map = new Map(products.map(p => [p.id, p]));

  function render() {
    const list = document.getElementById('cartList');
    const empty = document.getElementById('cartEmpty');
    const totalBox = document.getElementById('cartTotalBox');
    list.innerHTML = '';

    if (state.cart.length === 0) {
      empty.style.display = 'block';
      totalBox.innerHTML = '';
      return;
    }
    empty.style.display = 'none';

    let totalUsd = 0, totalByn = 0;
    const lang = getLang();
    const cur = state.settings.currency;

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
        <img class="cart-item-clickable" src="${escapeHtml(mainImg)}" alt="">
        <div class="cart-item-info">
          <div class="cart-item-name cart-item-clickable">${escapeHtml(p.name)}</div>
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
      // Клик по картинке или названию — открыть детальную страницу товара
      row.querySelectorAll('.cart-item-clickable').forEach(el => {
        el.onclick = () => router.navigate('detail', { productId: prod.id, source: 'cart' });
      });

      row.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = () => {
          const act = btn.getAttribute('data-act');
          if (act === 'inc') { changeCartQty(item.productId, item.size, 1); render(); haptic('light'); }
          else if (act === 'dec') { changeCartQty(item.productId, item.size, -1); render(); haptic('light'); }
          else if (act === 'rm') {
            showConfirm({
              icon: '🗑️',
              title: t('confirmRemoveCartTitle'),
              text: t('confirmRemoveCartText'),
              yes: t('confirmYes'), no: t('confirmNo'), danger: true,
              onYes: () => { removeFromCart(item.productId, item.size); render(); haptic('warning'); }
            });
          }
        };
      });
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
    document.getElementById('checkoutBtn').onclick = () => checkout(totalUsd, totalByn);
  }
  render();
}

async function checkout(totalUsd, totalByn) {
  const cur = state.settings.currency;
  const items = state.cart.map(c => ({ productId: c.productId, size: c.size, qty: c.qty }));

  // Блокируем кнопку checkout на время отправки — защита от двойного клика
  const btn = document.getElementById('checkoutBtn');
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }

  // Retry: 3 попытки с задержками 0/400/1200 мс. Большинство ошибок при оформлении —
  // временные (гонка с ensureCustomer, сетевые сбои Supabase). Простое повторение спасает.
  let order = null;
  let lastError = null;
  const delays = [0, 400, 1200];
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      order = await api.addOrder({
        items, total_usd: totalUsd, total_byn: totalByn, currency: cur,
      });
      break;
    } catch (e) {
      lastError = e;
      console.warn('[checkout] addOrder attempt failed, retrying:', e?.message || e);
    }
  }

  // Восстанавливаем кнопку
  if (btn) { btn.disabled = false; btn.style.opacity = ''; }

  if (!order) {
    console.error('[checkout] all attempts failed:', lastError);
    showToast(t('orderFailed'), 4000);
    return;
  }

  // Чистим корзину, фидбек
  clearLocalCart();
  haptic('success');

  // Тост + переход в историю до сворачивания апки
  showToast(t('orderPlaced'), 3000);
  router.navigate('history');

  // Открываем чат с ботом и сворачиваем апку
  if (order.dbId) {
    setTimeout(() => openBotChat('order_' + order.dbId), 600);
  }
}
