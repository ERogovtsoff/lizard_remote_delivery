// История заказов и запросов.
//
// Правка: цена и сумма всегда отображаются в валюте, в которой был оформлен
// заказ (h.payload.currency), независимо от текущей настройки клиента.
// То есть если клиент оформил в USD, а потом переключился на BYN — в истории
// останется USD. Это корректное поведение с точки зрения учёта.
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

function statusLabel(status) {
  return ({
    processing: t('statusProcessing'),
    packing:    t('statusPacking'),
    shipping:   t('statusShipping'),
    delivered:  t('statusDelivered'),
    cancelled:  t('statusCancelled'),
  })[status] || status;
}

function buildItem(h, productsMap, lang) {
  const el = document.createElement('div');
  el.className = 'history-item';

  const date = formatDate(h.date, lang);
  let typeChip = '';
  if (h.type === 'order') typeChip = `<span class="history-type order">${escapeHtml(t('typeOrder'))}</span>`;
  else typeChip = `<span class="history-type request">${escapeHtml(t('typeRequest'))}</span>`;

  let statusChip = '';
  if (h.type === 'order' && h.status) {
    statusChip = `<span class="history-status-badge status-${escapeHtml(h.status)}">${escapeHtml(statusLabel(h.status))}</span>`;
    if (h.isPaid) statusChip += `<span class="history-status-badge status-paid">${escapeHtml(t('statusPaid'))}</span>`;
  }

  let body = '';
  if (h.type === 'request') {
    if (h.payload?.text) body += `<div>${escapeHtml(h.payload.text)}</div>`;
    if (h.payload?.photosCount) body += `<div class="label">${escapeHtml(t('photos'))}: ${h.payload.photosCount}</div>`;
  } else if (h.type === 'order') {
    // ВСЕГДА используем валюту заказа, а не текущую настройку клиента
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
