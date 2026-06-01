// Раздел «Клиенты» — все пользователи, их активность, метрики и быстрый
// переход в Telegram-чат напрямую. Связь с разделом «Заказы»: клик по строке
// клиента открывает его последний заказ/обращение в нужной вкладке.

import * as api from './api.js';
import { escapeHtml, customerName, formatTime, formatFullDate } from './utils.js';

let customers = [];                // массив объектов customers
let aggregates = new Map();        // tg_id → { ordersTotal, ordersActive, lastOrderAt, lastInquiryAt }
let lastIncoming = new Map();      // tg_id → ISO дата последнего входящего сообщения
let unreadCustomers = new Set();   // tg_id с непрочитанным
let search = '';
let sortBy = 'lastActivity';       // lastActivity | created | spent | ordersTotal
let filter = 'all';                // all | active | returning | newcomers | unread

// VIP-порог в USD (можно поменять). Клиент выкупил суммарно больше — получает значок ⭐.
const VIP_THRESHOLD_USD = 200;

export async function loadCustomersSection() {
  const sec = document.getElementById('sectionCustomers');
  if (!sec) return;
  sec.innerHTML = '<div class="cust-loading">Загрузка клиентов…</div>';

  try {
    const [list, aggs, last, unread] = await Promise.all([
      api.loadAllCustomers().catch(() => []),
      api.loadCustomerAggregates().catch(() => new Map()),
      api.loadLastIncomingMessages().catch(() => new Map()),
      api.loadUnreadContexts().catch(() => ({ orderIds: new Set(), inquiryIds: new Set() })),
    ]);
    customers = list || [];
    aggregates = aggs;
    lastIncoming = last;
    // unread знаем по контекстам — выведем в tg_id через известные нам orders/inquiries.
    // Но проще: загрузим непрочитанные сообщения и возьмём customer_tg_id напрямую.
    unreadCustomers = await api.loadUnreadCustomers().catch(() => new Set());
  } catch (e) {
    console.error('loadCustomersSection failed:', e);
    sec.innerHTML = '<div class="cust-loading">Не удалось загрузить клиентов</div>';
    return;
  }
  renderCustomersSection();
}

function renderCustomersSection() {
  const sec = document.getElementById('sectionCustomers');
  const items = applyCustomerFilters(customers);
  const html = `
    <div class="cust-header">
      <h2>Клиенты <span class="cust-total">${customers.length}</span></h2>
      <div class="cust-summary">${renderCustomerSummary()}</div>
    </div>
    <div class="cust-controls">
      <input type="text" id="custSearch" class="list-search" placeholder="Поиск: имя, username, ID…" value="${escapeHtml(search)}">
      <select id="custFilter" class="list-filter">
        <option value="all" ${filter === 'all' ? 'selected' : ''}>Все</option>
        <option value="active" ${filter === 'active' ? 'selected' : ''}>С активными заказами</option>
        <option value="returning" ${filter === 'returning' ? 'selected' : ''}>Постоянные</option>
        <option value="newcomers" ${filter === 'newcomers' ? 'selected' : ''}>Новые (нет покупок)</option>
        <option value="unread" ${filter === 'unread' ? 'selected' : ''}>С непрочитанными</option>
      </select>
      <select id="custSort" class="list-filter">
        <option value="lastActivity" ${sortBy === 'lastActivity' ? 'selected' : ''}>Последняя активность</option>
        <option value="created" ${sortBy === 'created' ? 'selected' : ''}>Дата регистрации</option>
        <option value="spent" ${sortBy === 'spent' ? 'selected' : ''}>Сумма выкупа</option>
        <option value="ordersTotal" ${sortBy === 'ordersTotal' ? 'selected' : ''}>Кол-во заказов</option>
      </select>
    </div>
    <div class="cust-grid">
      ${items.length ? items.map(renderCustomerCard).join('') : '<div class="empty-hint">Ничего не найдено</div>'}
    </div>
  `;
  sec.innerHTML = html;

  document.getElementById('custSearch').oninput = (e) => {
    search = e.target.value;
    const pos = e.target.selectionStart;
    renderCustomersSection();
    const ni = document.getElementById('custSearch');
    if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (_) {} }
  };
  document.getElementById('custFilter').onchange = (e) => { filter = e.target.value; renderCustomersSection(); };
  document.getElementById('custSort').onchange = (e) => { sortBy = e.target.value; renderCustomersSection(); };

  sec.querySelectorAll('.cust-card .copy-id').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      try {
        await navigator.clipboard.writeText(id);
        const orig = btn.innerHTML;
        btn.innerHTML = 'скопировано ✓';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
      } catch (_) {}
    };
  });
  // Клик по карточке — открыть последний заказ/обращение клиента в разделе Заказы
  sec.querySelectorAll('.cust-card').forEach(card => {
    card.onclick = (e) => {
      // Не перехватываем клики по ссылкам/кнопкам внутри карточки
      if (e.target.closest('a, button')) return;
      const tg = card.getAttribute('data-tg');
      jumpToCustomerLastItem(Number(tg));
    };
  });
}

function applyCustomerFilters(list) {
  let items = list.slice();
  const q = search.trim().toLowerCase();
  if (q) {
    items = items.filter(c => {
      const name = customerName(c, c.tg_id).toLowerCase();
      const uname = (c.username || '').toLowerCase();
      return name.includes(q) || uname.includes(q) || String(c.tg_id).includes(q);
    });
  }
  if (filter === 'active') {
    items = items.filter(c => (aggregates.get(c.tg_id) || {}).ordersActive > 0);
  } else if (filter === 'returning') {
    items = items.filter(c => Number(c.purchases_total) > 0 || ((aggregates.get(c.tg_id) || {}).ordersTotal || 0) > 0);
  } else if (filter === 'newcomers') {
    items = items.filter(c => !Number(c.purchases_total) && !((aggregates.get(c.tg_id) || {}).ordersTotal || 0));
  } else if (filter === 'unread') {
    items = items.filter(c => unreadCustomers.has(c.tg_id));
  }
  items.sort((a, b) => {
    if (sortBy === 'created') return new Date(b.created_at) - new Date(a.created_at);
    if (sortBy === 'spent') return Number(b.purchases_total) - Number(a.purchases_total);
    if (sortBy === 'ordersTotal') return ((aggregates.get(b.tg_id) || {}).ordersTotal || 0) - ((aggregates.get(a.tg_id) || {}).ordersTotal || 0);
    // lastActivity по умолчанию: max из lastOrderAt, lastInquiryAt, lastIncoming
    const ta = lastActivityTs(a);
    const tb = lastActivityTs(b);
    return tb - ta;
  });
  return items;
}

function lastActivityTs(c) {
  const agg = aggregates.get(c.tg_id) || {};
  const dates = [agg.lastOrderAt, agg.lastInquiryAt, lastIncoming.get(c.tg_id), c.updated_at]
    .filter(Boolean).map(d => new Date(d).getTime());
  return dates.length ? Math.max(...dates) : 0;
}

function renderCustomerSummary() {
  const total = customers.length;
  const withOrders = customers.filter(c => ((aggregates.get(c.tg_id) || {}).ordersTotal || 0) > 0).length;
  const vip = customers.filter(c => Number(c.purchases_total) >= VIP_THRESHOLD_USD).length;
  const totalSpent = customers.reduce((s, c) => s + (Number(c.purchases_total) || 0), 0);
  return `
    <span class="sum-chip">Всего: <b>${total}</b></span>
    <span class="sum-chip">С покупками: <b>${withOrders}</b></span>
    <span class="sum-chip">VIP (от $${VIP_THRESHOLD_USD}): <b>${vip}</b></span>
    <span class="sum-chip">Общий оборот: <b>$${totalSpent.toFixed(0)}</b></span>
  `;
}

function renderCustomerCard(c) {
  const name = customerName(c, c.tg_id);
  const initials = (name.match(/[a-zA-Zа-яА-Я0-9]/g) || []).slice(0, 2).join('').toUpperCase() || '?';
  const agg = aggregates.get(c.tg_id) || { ordersTotal: 0, ordersActive: 0 };
  const spent = Number(c.purchases_total) || 0;
  const spentByn = Number(c.purchases_total_byn) || 0;
  const isVip = spent >= VIP_THRESHOLD_USD;
  const isReturning = spent > 0 || agg.ordersTotal > 0;
  const isNewcomer = !isReturning;
  const hasUnread = unreadCustomers.has(c.tg_id);
  const lastTs = lastActivityTs(c);
  const tags = [];
  if (isVip) tags.push('<span class="cust-tag vip">⭐ VIP</span>');
  if (isReturning && !isVip) tags.push('<span class="cust-tag returning">💛 постоянный</span>');
  if (isNewcomer) tags.push('<span class="cust-tag new">🆕 новый</span>');
  if (agg.ordersActive > 0) tags.push(`<span class="cust-tag active">🔥 в работе: ${agg.ordersActive}</span>`);
  if (hasUnread) tags.push('<span class="cust-tag unread">✉️ ждёт ответа</span>');
  if (c.cart_reminder_sent_at) tags.push('<span class="cust-tag cart">🛒 брошенная корзина</span>');

  const tgLink = c.username
    ? `<a class="cust-tg-link" href="https://t.me/${escapeHtml(c.username)}" target="_blank" rel="noopener" title="Открыть чат в Telegram">@${escapeHtml(c.username)} →</a>`
    : `<span class="cust-tg-none">нет username</span>`;

  const lastAct = lastTs ? timeAgo(new Date(lastTs).toISOString()) : '—';
  const reg = c.created_at ? formatFullDate(c.created_at) : '—';

  return `<div class="cust-card${hasUnread ? ' has-unread' : ''}" data-tg="${c.tg_id}">
    <div class="cust-card-top">
      <div class="cust-avatar">${c.photo_url ? `<img src="${escapeHtml(c.photo_url)}" alt="">` : escapeHtml(initials)}</div>
      <div class="cust-card-main">
        <div class="cust-name">${escapeHtml(name)}</div>
        <div class="cust-link-row">${tgLink}<button class="copy-id" data-id="${c.tg_id}" title="Копировать ID">${c.tg_id} 📋</button></div>
      </div>
    </div>
    <div class="cust-tags">${tags.join('')}</div>
    <div class="cust-card-stats">
      <div><span class="cust-stat-label">Заказов</span><span class="cust-stat-val">${agg.ordersTotal}${agg.ordersActive ? ` <span class="cust-stat-active">· ${agg.ordersActive} акт.</span>` : ''}</span></div>
      <div><span class="cust-stat-label">Выкуплено</span><span class="cust-stat-val">$${spent.toFixed(0)}${spentByn ? ` · ${spentByn.toFixed(0)} BYN` : ''}</span></div>
      <div><span class="cust-stat-label">Активность</span><span class="cust-stat-val">${lastAct}</span></div>
      <div><span class="cust-stat-label">Регистрация</span><span class="cust-stat-val">${escapeHtml(reg)}</span></div>
    </div>
  </div>`;
}

// Найти последний заказ/обращение клиента и открыть его в разделе «Заказы».
async function jumpToCustomerLastItem(tgId) {
  const agg = aggregates.get(tgId);
  if (!agg) return;
  // Грузим свежие списки и берём самый недавний по customer_tg_id
  try {
    const [orders, inquiries] = await Promise.all([
      api.loadOrders().catch(() => []),
      api.loadInquiries().catch(() => []),
    ]);
    const mineO = orders.filter(o => o.customer_tg_id === tgId)
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    const mineQ = inquiries.filter(q => q.customer_tg_id === tgId)
      .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
    const lastO = mineO[0];
    const lastQ = mineQ[0];
    let pickOrder = false;
    if (lastO && lastQ) pickOrder = new Date(lastO.updated_at || lastO.created_at) >= new Date(lastQ.updated_at || lastQ.created_at);
    else pickOrder = !!lastO;
    if (!lastO && !lastQ) {
      alert('У клиента нет заказов или обращений — пока ему можно написать только в Telegram.');
      return;
    }
    // Переключаемся в раздел Заказы и открываем нужную карточку
    window.dispatchEvent(new CustomEvent('switch-section', { detail: { section: 'orders' } }));
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('open-item', {
        detail: pickOrder
          ? { tab: 'orders', id: String(lastO.id) }
          : { tab: 'inquiries', id: String(lastQ.id) }
      }));
    }, 50);
  } catch (e) { console.error(e); }
}

// Те же утилиты, что в orders.js — дублируем минимально, чтобы не плодить зависимости.
function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} дн`;
}
