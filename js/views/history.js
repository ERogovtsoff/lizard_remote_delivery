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
import { addToCart } from '../state.js';
import { haptic } from '../tg.js';
import { showToast } from '../components/toast.js';
import { createSkeletonList } from '../components/skeleton.js';

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

  // 2. Грузим свежие данные. Если кэша не было — показываем скелетон-заглушку.
  if (!historyCache) {
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    list.appendChild(createSkeletonList(3));
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
    // Кнопка повтора заказа (для любого, кроме отменённого)
    if (h.status !== 'cancelled') {
      body += `<button class="reorder-btn" data-reorder="1">${escapeHtml(t('reorder'))}</button>`;
    }
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

  // Таймлайн статусов (раскрывается по тапу)
  const timeline = buildTimeline(h, lang);

  el.innerHTML = `
    <div class="history-item-head clickable-head">
      <div>${typeChip}${statusChip}</div>
      <div class="history-head-right">
        <span class="history-date">${escapeHtml(date)}</span>
        <span class="history-expand-chevron">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </div>
    </div>
    <div class="history-body">${body}</div>
    <div class="history-timeline"><div class="history-timeline-inner">${timeline}</div></div>
  `;

  // Раскрытие таймлайна по тапу на заголовок (плавно через grid)
  const head = el.querySelector('.clickable-head');
  const timelineEl = el.querySelector('.history-timeline');
  const chevron = el.querySelector('.history-expand-chevron');
  if (head && timelineEl) {
    head.onclick = () => {
      const open = timelineEl.classList.toggle('open');
      if (chevron) chevron.classList.toggle('expanded', open);
    };
  }

  // Повтор заказа
  if (h.type === 'order') {
    const reorderBtn = el.querySelector('[data-reorder]');
    if (reorderBtn) {
      reorderBtn.onclick = (e) => { e.stopPropagation(); reorderItems(h.payload?.items || [], productsMap); };
    }
  }
  return el;
}

// Вертикальный таймлайн статусов. Для заказа — воронка из этапов, для обращения — 3 шага.
function buildTimeline(h, lang) {
  let steps, current, labelFn;
  if (h.type === 'order') {
    if (h.status === 'cancelled') {
      // Для отменённого показываем только факт отмены
      return `<div class="timeline-step done"><span class="timeline-dot"></span><span class="timeline-label">${escapeHtml(orderStatusLabel('cancelled'))}</span></div>`;
    }
    steps = ['new', 'in_progress', 'awaiting_payment', 'paid', 'purchasing', 'shipping', 'ready', 'completed'];
    labelFn = orderStatusLabel;
    current = (h.status === 'completed') ? steps.length - 1 : steps.indexOf(h.status);
  } else {
    steps = ['new', 'in_progress', 'closed'];
    labelFn = inquiryStatusLabel;
    current = steps.indexOf(h.status);
  }
  if (current < 0) current = 0;

  // Описание «что это значит» берём из i18n по ключу статуса
  const descMap = (h.type === 'order') ? t('orderStatusDesc') : t('inquiryStatusDesc');

  return steps.map((step, i) => {
    let cls = 'timeline-step';
    if (i < current) cls += ' done';
    else if (i === current) cls += ' current';
    else cls += ' future';
    // Пояснение показываем только у текущего этапа — чтобы не перегружать таймлайн
    const desc = (i === current && descMap && descMap[step])
      ? `<div class="timeline-desc">${escapeHtml(descMap[step])}</div>`
      : '';
    return `<div class="${cls}"><span class="timeline-dot"></span><div class="timeline-content"><span class="timeline-label">${escapeHtml(labelFn(step))}</span>${desc}</div></div>`;
  }).join('');
}

// Повтор заказа: добавляем доступные позиции в корзину, предупреждаем о недоступных.
function reorderItems(items, productsMap) {
  let added = 0;
  const unavailable = [];

  for (const it of items) {
    const prod = productsMap.get(it.productId);
    // Товар удалён или скрыт
    if (!prod || prod.is_active === false) {
      unavailable.push(prod ? localizedProduct(prod, 'USD').name : it.productId);
      continue;
    }
    // Проверяем остаток по размеру
    const stock = sizeStockFor(prod, it.size);
    if (stock <= 0) {
      unavailable.push(localizedProduct(prod, 'USD').name + (it.size ? ` (${it.size})` : ''));
      continue;
    }
    // Добавляем с учётом остатка (не больше доступного)
    const qty = Math.min(it.qty || 1, stock === Infinity ? (it.qty || 1) : stock);
    for (let i = 0; i < qty; i++) {
      addToCart(it.productId, it.size || null);
    }
    added++;
  }

  if (added > 0) {
    haptic('success');
    if (unavailable.length > 0) {
      showToast(t('reorderPartial'), 3500);
    } else {
      showToast(t('reorderDone'));
    }
    window.dispatchEvent(new CustomEvent('cart:changed'));
    router.navigate('cart');
  } else {
    showToast(t('reorderNone'), 3500);
  }
}

// Доступное количество размера (Infinity если stock не задан)
function sizeStockFor(prod, size) {
  if (!prod.stock || Object.keys(prod.stock).length === 0) return Infinity;
  if (size == null) {
    const vals = Object.values(prod.stock);
    return vals.length ? vals.reduce((a, b) => a + (Number(b) || 0), 0) : Infinity;
  }
  return Number(prod.stock[size]) || 0;
}
