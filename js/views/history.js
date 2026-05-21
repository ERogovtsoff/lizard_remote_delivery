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
import { router } from '../router.js';

// In-memory кэш истории на время сессии апки. При повторном открытии показываем
// сразу закэшированное, а свежие данные подгружаем в фоне (stale-while-revalidate).
let historyCache = null;

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
      <a class="empty-state-link" id="historyEmptyLink">${escapeHtml(t('catalogEmptyLink'))}</a>
    </div>
    <div class="empty-state" id="historyError" style="display:none">
      <div class="icon">📡</div>
      <h3>${escapeHtml(t('loadErrorTitle'))}</h3>
      <p>${escapeHtml(t('loadErrorText'))}</p>
      <button class="primary-btn retry-btn" id="historyRetry">${escapeHtml(t('retry'))}</button>
    </div>
  `;

  const retryBtn = document.getElementById('historyRetry');
  if (retryBtn) retryBtn.onclick = () => renderHistory();

  const emptyLink = document.getElementById('historyEmptyLink');
  if (emptyLink) emptyLink.onclick = () => router.navigate('catalog');

  const lang = getLang();
  let products = [];
  try {
    products = await api.loadProducts();
  } catch (_) {
    products = [];   // каталог не критичен для истории — продолжаем без него
  }
  const map = new Map(products.map(p => [p.id, p]));

  // 1. Если есть кэш — рисуем мгновенно (без пустого экрана)
  if (historyCache) {
    paintHistory(historyCache, map, lang);
  }

  // 2. Грузим свежие данные. Если кэша не было — показываем «Загрузка…».
  if (!historyCache) {
    const list = document.getElementById('historyList');
    list.innerHTML = `<div class="history-loading">${escapeHtml(t('loading'))}</div>`;
  }

  try {
    const items = await api.loadHistory();
    historyCache = items;
    document.getElementById('historyError').style.display = 'none';
    paintHistory(items, map, lang);
  } catch (e) {
    console.error('[history] load failed:', e);
    // Если есть кэш — оставляем его показанным, ошибку не навязываем.
    if (!historyCache) {
      const list = document.getElementById('historyList');
      if (list) list.innerHTML = '';
      document.getElementById('historyEmpty').style.display = 'none';
      document.getElementById('historyError').style.display = 'block';
    }
  }
}

// Сбросить кэш истории (например, после оформления нового заказа)
export function invalidateHistoryCache() { historyCache = null; }

function paintHistory(items, map, lang) {
  const list = document.getElementById('historyList');
  const empty = document.getElementById('historyEmpty');
  if (!list || !empty) return;
  list.innerHTML = '';

  if (!items || items.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
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

// Прогресс-полоска воронки заказа. Показывает 6 ключевых этапов и подсвечивает
// пройденные + текущий. Для отменённых заказов не показывается.
const PROGRESS_STEPS = ['in_progress', 'awaiting_payment', 'paid', 'purchasing', 'shipping', 'ready'];
function orderProgressHtml(status) {
  if (status === 'cancelled') return '';
  // completed — все этапы пройдены
  let currentIdx;
  if (status === 'completed') {
    currentIdx = PROGRESS_STEPS.length; // всё пройдено
  } else if (status === 'new') {
    currentIdx = 0; // ещё не начали двигаться по воронке
  } else {
    currentIdx = PROGRESS_STEPS.indexOf(status);
    if (currentIdx < 0) return '';
  }

  const dots = PROGRESS_STEPS.map((step, i) => {
    let cls = 'progress-step';
    if (i < currentIdx) cls += ' done';
    else if (i === currentIdx) cls += ' current';
    return `<div class="${cls}"><span class="progress-label">${escapeHtml(orderStatusLabel(step))}</span></div>`;
  }).join('');

  return `<div class="order-progress">${dots}</div>`;
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
    // Прогресс-полоска воронки заказа (кроме отменённых)
    body += orderProgressHtml(h.status);
  } else if (h.type === 'inquiry') {
    const isProductQ = h.payload?.inquiryType === 'product_question';
    const num = h.payload?.number ? ` №${h.payload.number}` : '';
    typeChip = `<span class="history-type inquiry">${escapeHtml((isProductQ ? t('typeProductQuestion') : t('typeRequest')) + num)}</span>`;
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
