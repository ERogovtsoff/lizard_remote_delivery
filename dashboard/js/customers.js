// Раздел «Клиенты» — все пользователи, их активность, метрики и быстрый
// переход в Telegram-чат напрямую. Связь с разделом «Заказы»: клик по строке
// клиента открывает его последний заказ/обращение в нужной вкладке.

import * as api from './api.js';
import { CONFIG } from './config.js';
import { escapeHtml, customerName, formatTime, formatFullDate, exportToCsv } from './utils.js';

let customers = [];                // массив объектов customers
let aggregates = new Map();        // tg_id → { ordersTotal, ordersActive, lastOrderAt, lastInquiryAt }
let lastIncoming = new Map();      // tg_id → ISO дата последнего входящего сообщения
let unreadCustomers = new Set();   // tg_id с непрочитанным
let search = '';
let sortBy = 'lastActivity';       // lastActivity | created | spent | ordersTotal
let filter = 'all';                // all | active | returning | newcomers | unread

// VIP-порог в USD (можно поменять). Клиент выкупил суммарно больше — получает значок ⭐.
const VIP_THRESHOLD_USD = 200;
// «Новый» = зарегистрирован за последние N дней И ещё не делал покупок.
// Без этого ограничения клиент годами оставался бы «новым».
const NEWCOMER_WINDOW_DAYS = 7;

export async function loadCustomersSection() {
  const sec = document.getElementById('sectionCustomers');
  if (!sec) return;
  sec.innerHTML = '<div class="cust-loading">Загрузка клиентов…</div>';

  try {
    const [list, aggs, last] = await Promise.all([
      api.loadAllCustomers().catch(() => []),
      api.loadCustomerAggregates().catch(() => new Map()),
      api.loadLastIncomingMessages().catch(() => new Map()),
    ]);
    customers = list || [];
    aggregates = aggs;
    lastIncoming = last;
    // «Ждёт ответа»: клиенты, у которых есть АКТИВНЫЙ заказ/обращение,
    // где крайнее сообщение от клиента (внутри loadUnreadCustomers).
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
      <div class="cust-actions">
        <button class="btn-light" id="exportCustomersBtn">📥 Экспорт CSV</button>
      </div>
      <div class="cust-summary">${renderCustomerSummary()}</div>
    </div>
    <div class="cust-controls">
      <input type="text" id="custSearch" class="list-search" placeholder="Поиск: имя, username, ID…" value="${escapeHtml(search)}">
      <select id="custFilter" class="list-filter">
        <option value="all" ${filter === 'all' ? 'selected' : ''}>Все</option>
        <option value="active" ${filter === 'active' ? 'selected' : ''}>С активными заказами</option>
        <option value="returning" ${filter === 'returning' ? 'selected' : ''}>Постоянные</option>
        <option value="newcomers" ${filter === 'newcomers' ? 'selected' : ''}>Без покупок</option>
        <option value="recent" ${filter === 'recent' ? 'selected' : ''}>Новые за неделю</option>
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
      ${items.length ? items.map(renderCustomerCard).join('') : `
        <div class="empty-state">
          <div class="empty-icon">👥</div>
          <div class="empty-title">${customers.length ? 'Ничего не найдено' : 'Клиентов пока нет'}</div>
          <div class="empty-text">${customers.length ? 'Попробуйте сменить фильтр.' : 'Когда клиенты начнут оформлять заказы или писать в чат — они появятся тут.'}</div>
        </div>`}
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

  const exportBtn = document.getElementById('exportCustomersBtn');
  if (exportBtn) exportBtn.onclick = () => exportCustomers();

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
  } else if (filter === 'recent') {
    // Зарегистрированы за последние NEWCOMER_WINDOW_DAYS дней И не покупали
    const cutoff = Date.now() - NEWCOMER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    items = items.filter(c => {
      if (!c.created_at) return false;
      const reg = new Date(c.created_at).getTime();
      const hasPurchases = Number(c.purchases_total) > 0 || ((aggregates.get(c.tg_id) || {}).ordersTotal || 0) > 0;
      return reg >= cutoff && !hasPurchases;
    });
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
    <span class="sum-chip">Всего: <b>${total}</b> <span class="hb-tip" data-tip="Все клиенты, кто хоть раз обращался в чат или регистрировался в приложении.">ⓘ</span></span>
    <span class="sum-chip">С покупками: <b>${withOrders}</b> <span class="hb-tip" data-tip="Клиенты, у которых был хотя бы один заказ (даже не оплаченный).">ⓘ</span></span>
    <span class="sum-chip">VIP (от $${VIP_THRESHOLD_USD}): <b>${vip}</b> <span class="hb-tip" data-tip="VIP — клиенты, которые в сумме оплатили на $${VIP_THRESHOLD_USD} и больше.">ⓘ</span></span>
    <span class="sum-chip">Общий оборот: <b>$${totalSpent.toFixed(0)}</b> <span class="hb-tip" data-tip="Сумма всех оплаченных заказов всех клиентов за всё время.">ⓘ</span></span>
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
  // «Новый» = зарегистрирован недавно И ещё не покупал. Старые клиенты без
  // покупок больше не считаются «новыми» (это были бы «спящие», не новые).
  const regAt = c.created_at ? new Date(c.created_at).getTime() : 0;
  const isRecentlyRegistered = regAt && (Date.now() - regAt) <= NEWCOMER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const isNewcomer = !isReturning && isRecentlyRegistered;
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
    ${c.manager_note ? `<div class="cust-perm-note" title="${escapeHtml(c.manager_note)}">📌 ${escapeHtml(c.manager_note)}</div>` : ''}
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

// Экспорт текущего отфильтрованного списка в CSV (#16).
function exportCustomers() {
  const items = applyCustomerFilters(customers);
  const rows = items.map(c => {
    const agg = aggregates.get(c.tg_id) || {};
    const lastTs = lastActivityTs(c);
    return {
      tg_id: c.tg_id,
      username: c.username || '',
      name: customerName(c, c.tg_id),
      created_at: c.created_at,
      last_activity: lastTs ? new Date(lastTs).toISOString() : '',
      orders_total: agg.ordersTotal || 0,
      orders_active: agg.ordersActive || 0,
      spent_usd: Number(c.purchases_total) || 0,
      spent_byn: Number(c.purchases_total_byn) || 0,
      manager_note: c.manager_note || '',
    };
  });
  const columns = [
    { key: 'tg_id', label: 'Telegram ID' },
    { key: 'username', label: 'Username' },
    { key: 'name', label: 'Имя' },
    { key: 'created_at', label: 'Регистрация' },
    { key: 'last_activity', label: 'Последняя активность' },
    { key: 'orders_total', label: 'Всего заказов' },
    { key: 'orders_active', label: 'Активных' },
    { key: 'spent_usd', label: 'Выкуплено USD' },
    { key: 'spent_byn', label: 'Выкуплено BYN' },
    { key: 'manager_note', label: 'Заметка о клиенте' },
  ];
  const date = new Date().toISOString().slice(0, 10);
  exportToCsv(`customers-${date}.csv`, rows, columns);
}

// ============ ПРОФИЛЬ КЛИЕНТА (#13) ============

export async function openCustomerProfile(tgId) {
  const old = document.getElementById('custProfileModal');
  if (old) old.remove();
  const modal = document.createElement('div');
  modal.id = 'custProfileModal';
  modal.className = 'qp-modal';
  modal.innerHTML = `
    <div class="qp-card profile-card">
      <div class="profile-loading">Загрузка профиля…</div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  let data;
  try {
    data = await api.loadCustomerProfile(tgId);
  } catch (e) {
    modal.querySelector('.qp-card').innerHTML = '<div class="sh-empty">Не удалось загрузить</div>';
    return;
  }
  if (!data.customer) {
    modal.querySelector('.qp-card').innerHTML = '<div class="sh-empty">Клиент не найден</div>';
    return;
  }
  const c = data.customer;
  const name = customerName(c, c.tg_id);
  const initials = (name.match(/[a-zA-Zа-яА-Я0-9]/g) || []).slice(0, 2).join('').toUpperCase() || '?';
  const totalSpent = Number(c.purchases_total) || 0;
  const totalByn = Number(c.purchases_total_byn) || 0;
  const ordersTotal = data.orders.length;
  const ordersActive = data.orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;
  const ordersCompleted = data.orders.filter(o => o.status === 'completed').length;
  const tgLink = c.username
    ? `<a class="cust-tg-link" href="https://t.me/${escapeHtml(c.username)}" target="_blank" rel="noopener">@${escapeHtml(c.username)} →</a>`
    : '<span class="cust-tg-none">нет username</span>';
  const statusLabels = {
    new: '🆕', in_progress: '✋', awaiting_payment: '💳', paid: '✅',
    purchasing: '🛒', shipping: '🚚', ready: '📦', completed: '🎉', cancelled: '❌',
    closed: '✓',
  };

  modal.querySelector('.qp-card').innerHTML = `
    <div class="profile-head">
      <div class="cust-avatar profile-avatar">${c.photo_url ? `<img src="${escapeHtml(c.photo_url)}" alt="">` : escapeHtml(initials)}</div>
      <div class="profile-info">
        <div class="profile-name">${escapeHtml(name)}</div>
        <div class="profile-meta">${tgLink} · <button class="copy-id" data-id="${c.tg_id}">${c.tg_id} 📋</button></div>
        <div class="profile-meta">Зарегистрирован: ${escapeHtml(formatFullDate(c.created_at) || '—')}</div>
      </div>
      <button class="btn-light profile-close" id="profileClose">Закрыть</button>
    </div>

    <div class="profile-stats">
      <div><span class="cust-stat-label">Заказов всего</span><span class="cust-stat-val">${ordersTotal}</span></div>
      <div><span class="cust-stat-label">Завершённых</span><span class="cust-stat-val">${ordersCompleted}</span></div>
      <div><span class="cust-stat-label">Активных</span><span class="cust-stat-val">${ordersActive}</span></div>
      <div><span class="cust-stat-label">Выкуплено</span><span class="cust-stat-val">$${totalSpent.toFixed(0)}${totalByn ? ` · ${totalByn.toFixed(0)} BYN` : ''}</span></div>
    </div>

    <div class="profile-section">
      <div class="profile-section-title">📌 Постоянная заметка</div>
      <textarea id="profileNote" rows="3" placeholder="Например: «всегда платит на 3-й день», «любит примерять перед оплатой»">${escapeHtml(c.manager_note || '')}</textarea>
      <button class="btn-light" id="profileNoteSave">Сохранить заметку</button>
    </div>

    <div class="profile-section">
      <div class="profile-section-title">🔀 Объединение дубликата</div>
      <p class="req-hint">Если этот клиент — дубль другого аккаунта, можно перенести все его заказы, обращения и переписку на основной tg_id. После объединения этот клиент будет удалён.</p>
      <button class="btn-light" id="mergeBtn">Объединить с другим клиентом…</button>
    </div>

    <div class="profile-section">
      <div class="profile-section-title">История заказов (${data.orders.length})</div>
      <div class="profile-orders">
        ${data.orders.length ? data.orders.slice(0, 50).map(o => `
          <div class="profile-order-row" data-order-id="${o.id}">
            <span class="po-status">${statusLabels[o.status] || ''}</span>
            <span class="po-id">№${o.id}</span>
            <span class="po-sum">$${o.total_usd}</span>
            <span class="po-date">${escapeHtml(formatFullDate(o.created_at) || '')}</span>
          </div>
        `).join('') : '<div class="sh-empty">Заказов нет</div>'}
      </div>
    </div>

    <div class="profile-section">
      <div class="profile-section-title">Обращения (${data.inquiries.length})</div>
      <div class="profile-orders">
        ${data.inquiries.length ? data.inquiries.slice(0, 50).map(q => `
          <div class="profile-order-row" data-inquiry-id="${q.id}">
            <span class="po-status">${statusLabels[q.status] || ''}</span>
            <span class="po-id">№${q.number || ''}</span>
            <span class="po-sum">${q.type === 'product_question' ? '❓ товар' : '🔎 подбор'}</span>
            <span class="po-date">${escapeHtml(formatFullDate(q.created_at) || '')}</span>
          </div>
        `).join('') : '<div class="sh-empty">Обращений нет</div>'}
      </div>
    </div>
  `;

  document.getElementById('profileClose').onclick = () => modal.remove();
  // Сохранение заметки
  document.getElementById('profileNoteSave').onclick = async () => {
    const val = document.getElementById('profileNote').value;
    try {
      // Менеджер для audit — пытаемся достать из localStorage авторизации
      const mgr = (function(){ try { return JSON.parse(localStorage.getItem(CONFIG.AUTH_KEY) || '{}').username || ''; } catch (_) { return ''; } })();
      await api.setCustomerNote(c.tg_id, val, mgr);
      c.manager_note = val;
    } catch (e) { console.error(e); }
  };
  // Объединение дубликата (#17)
  const mergeBtn = document.getElementById('mergeBtn');
  if (mergeBtn) mergeBtn.onclick = async () => {
    const targetIdStr = prompt(`Введите Telegram ID основного клиента, в которого ПЕРЕНЕСТИ все заказы и переписку этого аккаунта (${c.tg_id}).\n\nЭтот клиент (${c.tg_id}) после объединения будет удалён.`);
    if (!targetIdStr) return;
    const targetId = Number(targetIdStr);
    if (!targetId || targetId === c.tg_id) { alert('Некорректный ID или совпадает с текущим'); return; }
    if (!confirm(`Точно объединить клиента ${c.tg_id} в ${targetId}?\nЭто действие нельзя отменить.`)) return;
    mergeBtn.disabled = true;
    try {
      const mgr = (function(){ try { return JSON.parse(localStorage.getItem(CONFIG.AUTH_KEY) || '{}').username || ''; } catch (_) { return ''; } })();
      await api.mergeCustomers(c.tg_id, targetId, mgr);
      alert('Клиенты объединены ✓');
      modal.remove();
      const sec = document.getElementById('sectionCustomers');
      if (sec && sec.style.display !== 'none') loadCustomersSection();
    } catch (e) {
      console.error(e);
      alert('Ошибка объединения: ' + e.message);
      mergeBtn.disabled = false;
    }
  };
  // Копирование ID
  modal.querySelectorAll('.copy-id').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(b.getAttribute('data-id'));
        const orig = b.innerHTML;
        b.innerHTML = 'скопировано ✓';
        setTimeout(() => { b.innerHTML = orig; }, 1500);
      } catch (_) {}
    };
  });
  // Клик по строке заказа/обращения — открыть его в разделе Заказы
  modal.querySelectorAll('.profile-order-row').forEach(row => {
    row.onclick = () => {
      const oid = row.getAttribute('data-order-id');
      const iid = row.getAttribute('data-inquiry-id');
      modal.remove();
      window.dispatchEvent(new CustomEvent('switch-section', { detail: { section: 'orders' } }));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('open-item', {
          detail: oid ? { tab: 'orders', id: oid } : { tab: 'inquiries', id: iid }
        }));
      }, 50);
    };
  });
}
