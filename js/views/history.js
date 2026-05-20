// История: заказы и обращения клиента.
//
// Заказы — со своим статусом (воронка выкупа) и суммой в валюте заказа.
// Обращения (inquiry) — запросы на подбор и вопросы по товарам, со статусом
// new/in_progress/closed. Клиент видит, на каком этапе его обращение.
//
// Цена/сумма заказа всегда в валюте, в которой он был оформлен (payload.currency),
// независимо от текущей настройки клиента.
import { t, getLang, localizedProduct } from '../i18n.js';
import { escapeHtml, formatPrice, formatDate } from '../utils.js';
import { api } from '../api/index.js';

export async function renderHistory() {
  const page = document.getElementById('page-history');
  page.innerHTML = `
    <h2>${escapeHtml(t('historyTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('historySubFull'))}</p>
    <div id="historyList"></div>
    <div class="empty-state" id="historyEmpty" style="display:none">
      <div class="icon">📋</div>
      <h3>${escapeHtml(t('historyEmptyTitle'))}</h3>
      <p>${escapeHtml(t('historyEmptyText'))}</p>
    </div>
  `;

  const items = await api.loadHistory();
  const products = await api.loadProducts();
  const map = new Map(products.map(p => [p.id, p]));
  const lang = getLang();

  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');

  if (items.length === 0) {
    empty.style.display = 'block';
    return;
  }
  const sorted = [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
  sorted.forEach(h => list.appendChild(buildItem(h, map, lang)));
}

// Статус заказа → человекочитаемая подпись
function orderStatusLabel(status) {
  return ({
    new:              t('osNew'),
    in_progress:      t('osInProgress'),
    awaiting_payment: t('osAwaitingPayment'),
    paid:             t('osPaid'),
    purchasing:       t('osPurchasing'),
    shipping:         t('osShipping'),
    ready:            t('osReady'),
    completed:        t('osCompleted'),
    cancelled:        t('osCancelled'),
  })[status] || status;
}

// Статус обращения → подпись
function inquiryStatusLabel(status) {
  return ({
    new:         t('isNew'),
    in_progress: t('isInProgress'),
    closed:      t('isClosed'),
  })[status] || status;
}

function buildItem(h, productsMap, lang) {
  const el = document.createElement('div');
  el.className = 'history-item';
  const date = formatDate(h.date, lang);

  let typeChip = '';
  let statusChip = '';
  let body = '';

  if (h.type === 'order') {
    typeChip = `<span class="history-type order">${escapeHtml(t('typeOrder'))}</span>`;
    if (h.status) {
      statusChip = `<span class="history-status-badge status-${escapeHtml(h.status)}">${escapeHtml(orderStatusLabel(h.status))}</span>`;
    }

    const orderCur = h.payload?.currency || 'USD';
    const orderTotal = orderCur === 'USD' ? h.payload?.total_usd : h.payload?.total_byn;
    const items = h.payload?.items || [];
    items.forEach(it => {
      const prod = productsMap.get(it.productId);
      if (!prod) return;
      const p = localizedProduct(prod, orderCur);
      const sz = it.size ? ` (${escapeHtml(it.size)})` : '';
      body += `<div>• ${escapeHtml(p.name)}${sz} × ${it.qty}</div>`;
    });
    body += `<div class="history-total-line">${escapeHtml(t('cartTotal'))}: ${escapeHtml(formatPrice(orderTotal || 0, orderCur, lang))}</div>`;
    if (h.status === 'shipping' && h.eta) {
      body += `<div class="label">${escapeHtml(t('eta'))}: ${escapeHtml(formatDate(h.eta, lang))}</div>`;
    }
  } else if (h.type === 'inquiry') {
    const isProductQ = h.payload?.inquiryType === 'product_question';
    typeChip = `<span class="history-type inquiry">${escapeHtml(isProductQ ? t('typeProductQuestion') : t('typeRequest'))}</span>`;
    if (h.status) {
      statusChip = `<span class="history-status-badge inq-${escapeHtml(h.status)}">${escapeHtml(inquiryStatusLabel(h.status))}</span>`;
    }
    // Тело: для вопроса по товару — название товара; для запроса — общий текст
    if (isProductQ && h.payload?.productId) {
      const prod = productsMap.get(h.payload.productId);
      if (prod) {
        const cur = h.payload?.currency || 'USD';
        const p = localizedProduct(prod, cur);
        body += `<div>${escapeHtml(t('inquiryAboutProduct'))}: ${escapeHtml(p.name)}</div>`;
      } else {
        body += `<div>${escapeHtml(t('inquiryAboutProduct'))}</div>`;
      }
    } else {
      body += `<div>${escapeHtml(t('inquiryRequestBody'))}</div>`;
    }
  }

  el.innerHTML = `
    <div class="history-item-head">
      <div>${typeChip}${statusChip}</div>
      <span class="history-date">${escapeHtml(date)}</span>
    </div>
    <div class="history-body">${body}</div>
  `;
  return el;
}
