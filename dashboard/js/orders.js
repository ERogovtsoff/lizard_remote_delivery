// Раздел «Заказы» в панели: заказы и обращения, перемещение по статусам.
// Смена статуса пишет в БД и (через outbox) уведомляет клиента — бот доставит.
import * as api from './api.js';
import { escapeHtml, customerName, formatTime, formatFullDate, makeId } from './utils.js';

// Статусы заказов с подписью и текстом клиенту (синхронно с ботом).
const ORDER_STATUS = {
  new:              { label: '🆕 Новый',          client: null, color: 'gray',   next: 'Возьмите заказ в работу и проверьте наличие/цену товара.' },
  in_progress:      { label: '✋ В работе',        client: 'Взяли ваш заказ в работу 🙌 Скоро вернёмся с деталями.', color: 'blue',   next: 'Подтвердите цену и наличие, затем запросите оплату.' },
  awaiting_payment: { label: '💳 Ждёт оплаты',     client: 'Всё подтвердили! Пришлём реквизиты для оплаты — и сразу выкупаем.', color: 'orange', next: 'Отправьте клиенту реквизиты (кнопка «Запросить оплату»). После оплаты отметьте «Оплачен».' },
  paid:             { label: '✅ Оплачен',         client: 'Оплату получили, спасибо! 🎉 Начинаем выкуп.', color: 'green',  next: 'Выкупите товар на POIZON/Taobao.' },
  purchasing:       { label: '🛒 Выкупаем',        client: 'Выкупаем ваш товар. Следующий шаг — отправка в Беларусь.', color: 'purple', next: 'После выкупа переведите в «В пути» и укажите трек-номер.' },
  shipping:         { label: '🚚 В пути',          client: 'Заказ уже едет к нам 🚚 Дорога обычно занимает 3–4 недели. Напишем сразу, как он приедет.', color: 'cyan',   next: 'Когда заказ приедет — переведите в «Готов к выдаче».' },
  ready:            { label: '📦 Готов к выдаче',  client: 'Ваш заказ приехал! 🎁 Договоримся, когда вам удобно примерить и забрать.', color: 'teal',   next: 'Договоритесь о встрече/примерке. После выдачи — «Выдан».' },
  completed:        { label: '🎉 Выдан',           client: 'Готово! Спасибо, что выбрали нас 💛 Будем рады видеть снова.', color: 'done',   next: null },
  cancelled:        { label: '❌ Отменён',         client: 'Заказ отменили. Если что-то пошло не так — напишите, всё поправим.', color: 'red',    next: null },
};
// Порядок статусов для «следующего шага» и защиты от пропуска
const ORDER_FLOW = ['new', 'in_progress', 'awaiting_payment', 'paid', 'purchasing', 'shipping', 'ready', 'completed'];

const INQUIRY_STATUS = {
  new:         { label: '🆕 Новое',   client: null },
  in_progress: { label: '✋ В работе', client: 'Получили ваше сообщение 🙌 Скоро ответим!' },
  closed:      { label: '✅ Закрыто',  client: 'Спасибо за обращение! 💛 Если появятся вопросы — пишите в любой момент.' },
};

let orders = [];
let inquiries = [];
let customersById = {};
let activeTab = 'orders';      // orders | inquiries
let activeId = null;
let managerUsername = '';
let productsById = {};
let statusBusy = false;        // защита от спама кнопок статуса
let convoTimer = null;         // автообновление переписки в открытой карточке
let searchQuery = '';          // строка поиска по списку
let statusFilter = 'active';   // active | all | <конкретный статус>
let unreadOrders = new Set();  // id заказов с непрочитанными входящими
let unreadInquiries = new Set(); // id обращений с непрочитанными
let onlyMine = false;          // фильтр «только мои» (назначенные мне)
let listView = 'list';         // list | board (канбан)

// Активен ли заказ/обращение (можно ли писать клиенту)
function isOrderActive(status) { return status !== 'completed' && status !== 'cancelled'; }
function isInquiryActive(status) { return status !== 'closed'; }

// Заготовки сообщений-действий для статусов (#2). Менеджер дополняет и отправляет.
const STATUS_TEMPLATES = {
  awaiting_payment: 'Для оформления заказа нужно внести оплату.\nРеквизиты: \nСумма к оплате: \nПосле оплаты пришлите, пожалуйста, чек 🙏',
  shipping: 'Ваш заказ передан в доставку 📦\nТрек-номер: \nОриентировочный срок: ',
  ready: 'Ваш заказ готов к выдаче 🎉\nКак вам удобнее забрать?',
};

// Если для статуса есть заготовка — подставляет её в поле ответа менеджера.
function applyStatusTemplate(status, orderId) {
  const tpl = STATUS_TEMPLATES[status];
  if (!tpl) return;
  const input = document.getElementById('convoInput');
  if (input && !input.value.trim()) {
    input.value = tpl;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    input.focus();
    setDetailMsg('Подставлена заготовка — дополните и отправьте клиенту');
  }
}

// Загружает и рисует историю статусов в блок #statusHistory.
async function loadAndRenderHistory(context) {
  const box = document.getElementById('statusHistory');
  if (!box) return;
  try {
    const rows = await api.loadStatusHistory(context);
    if (!rows || !rows.length) { box.innerHTML = '<div class="sh-empty">Изменений пока нет</div>'; return; }
    const label = (s) => (ORDER_STATUS[s] && ORDER_STATUS[s].label) || (INQUIRY_STATUS[s] && INQUIRY_STATUS[s].label) || s || '—';
    box.innerHTML = rows.map(r => {
      const who = r.changed_by ? `@${escapeHtml(r.changed_by)}` : 'система';
      const when = `${escapeHtml(formatFullDate(r.created_at))} ${escapeHtml(formatTime(r.created_at))}`;
      const from = r.old_status ? `${escapeHtml(label(r.old_status))} → ` : '';
      return `<div class="sh-row"><span class="sh-status">${from}${escapeHtml(label(r.new_status))}</span><span class="sh-meta">${who} · ${when}</span></div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="sh-empty">Не удалось загрузить историю</div>';
  }
}

// Сводка сверху (#9): сколько заказов в ключевых статусах + сумма «в работе».
function renderSummary() {
  if (activeTab !== 'orders') {
    const newInq = inquiries.filter(q => q.status === 'new').length;
    const inWork = inquiries.filter(q => q.status === 'in_progress').length;
    return `<div class="list-summary">
      <span class="sum-chip">Новых: <b>${newInq}</b></span>
      <span class="sum-chip">В работе: <b>${inWork}</b></span>
    </div>`;
  }
  const active = orders.filter(o => isOrderActive(o.status));
  const awaitingPay = orders.filter(o => o.status === 'awaiting_payment').length;
  const unpaidSum = active.filter(o => !o.is_paid).reduce((s, o) => s + (Number(o.total_usd) || 0), 0);
  return `<div class="list-summary">
    <span class="sum-chip">Активных: <b>${active.length}</b></span>
    <span class="sum-chip">Ждут оплаты: <b>${awaitingPay}</b></span>
    <span class="sum-chip">В работе: <b>$${unpaidSum.toFixed(0)}</b></span>
  </div>`;
}

// Краткая статистика по клиенту для карточки (#9): сколько заказов, на сумму, свой/новый.
function customerStatsHtml(customerTgId) {
  const cust = customersById[customerTgId];
  const myOrders = orders.filter(o => String(o.customer_tg_id) === String(customerTgId));
  const completed = myOrders.filter(o => o.status === 'completed').length;
  const totalUsd = cust && cust.purchases_total != null ? Number(cust.purchases_total) : 0;
  const isReturning = completed > 0 || totalUsd > 0;
  const tag = isReturning
    ? '<span class="cust-tag returning">💛 постоянный</span>'
    : '<span class="cust-tag new">🆕 новый клиент</span>';
  const spent = totalUsd > 0 ? ` · выкуплено на $${totalUsd}` : '';
  return `<div class="cust-stats">${tag}<span class="cust-stats-meta">заказов: ${myOrders.length}${spent}</span></div>`;
}

// ===== Реквизиты оплаты (#3) — хранятся локально в браузере панели =====
const REQUISITES_KEY = 'lizard_payment_requisites';
function getPaymentRequisites() {
  try { return localStorage.getItem(REQUISITES_KEY) || ''; } catch (_) { return ''; }
}
function setPaymentRequisites(text) {
  try { localStorage.setItem(REQUISITES_KEY, text); } catch (_) {}
}
function openRequisitesModal() {
  const old = document.getElementById('reqModal');
  if (old) old.remove();
  const modal = document.createElement('div');
  modal.id = 'reqModal';
  modal.className = 'qp-modal';
  modal.innerHTML = `
    <div class="qp-card">
      <div class="qp-head">Реквизиты для оплаты</div>
      <p class="req-hint">Эти реквизиты подставляются в сообщение по кнопке «Запросить оплату». Сумма добавляется автоматически.</p>
      <textarea id="reqText" rows="5" class="req-textarea" placeholder="Например:\nКарта 1234 5678 9012 3456 (Иван И.)\nЕРИП: ...\nИли по номеру телефона +375...">${escapeHtml(getPaymentRequisites())}</textarea>
      <div class="qp-actions">
        <button class="btn-primary" id="reqSave">Сохранить</button>
        <button class="btn-light" id="reqCancel">Отмена</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('reqCancel').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('reqSave').onclick = () => {
    setPaymentRequisites(document.getElementById('reqText').value);
    modal.remove();
    setDetailMsg('Реквизиты сохранены ✓');
  };
}

// Человекочитаемый возраст: «2 дня», «5 ч», «10 мин».
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

// Рендер одной строки заказа (используется и в списке, и в канбан-доске).
function orderRowHtml(it) {
  const cust = customersById[it.customer_tg_id];
  const name = customerName(cust, it.customer_tg_id);
  const active = String(it.id) === String(activeId) ? ' active' : '';
  const st = ORDER_STATUS[it.status] || { label: it.status };
  const sumLabel = it.currency === 'BYN' ? `${it.total_byn} BYN` : `$${it.total_usd}`;
  const unread = unreadOrders.has(String(it.id)) ? '<span class="unread-dot" title="Есть непрочитанное сообщение"></span>' : '';
  const age = isOrderActive(it.status) ? `<span class="row-age">⏱ ${timeAgo(it.status_changed_at || it.updated_at)}</span>` : '';
  const assign = it.assigned_to ? `<span class="row-assign">👤 ${escapeHtml(it.assigned_to)}</span>` : '';
  // В канбане статус-пилюля не нужна (есть заголовок колонки)
  const statusLine = listView === 'board'
    ? `<div class="order-row-status">${age} ${assign}</div>`
    : `<div class="order-row-status"><span class="status-pill status-${st.color || 'gray'}">${escapeHtml(st.label)}</span> ${age} ${assign}</div>`;
  return `<div class="order-row${active}${unread ? ' has-unread' : ''}" data-id="${it.id}">
    <div class="order-row-top">
      <span class="order-row-id">${unread}Заказ №${it.id}</span>
      <span class="order-row-sum">${escapeHtml(sumLabel)}</span>
    </div>
    <div class="order-row-name">${escapeHtml(name)}</div>
    ${statusLine}
  </div>`;
}

// Навешивает копирование Telegram ID клиента по кнопке в карточке.
function setupCopyId() {
  document.querySelectorAll('.copy-id').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute('data-id');
      try {
        await navigator.clipboard.writeText(id);
        const orig = btn.innerHTML;
        btn.innerHTML = 'скопировано ✓';
        setTimeout(() => { btn.innerHTML = orig; }, 1500);
      } catch (_) {
        // Фолбэк: выделение текста, если clipboard API недоступен
        const r = document.createRange();
        r.selectNodeContents(btn);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    };
  });
}

// Применяет к списку текущий поиск и фильтр статуса.
function applyListFilters(items) {
  // Фильтр статуса
  if (statusFilter === 'active') {
    items = items.filter(it => activeTab === 'orders' ? isOrderActive(it.status) : isInquiryActive(it.status));
  } else if (statusFilter !== 'all') {
    items = items.filter(it => it.status === statusFilter);
  }
  // Поиск по номеру, имени, Telegram ID
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    items = items.filter(it => {
      const cust = customersById[it.customer_tg_id];
      const name = customerName(cust, it.customer_tg_id).toLowerCase();
      const num = activeTab === 'orders' ? String(it.id) : String(it.number || '');
      const tgId = String(it.customer_tg_id);
      return name.includes(q) || num.includes(q) || tgId.includes(q);
    });
  }
  // Фильтр «только мои» (#8)
  if (onlyMine) {
    items = items.filter(it => it.assigned_to === managerUsername);
  }
  // Сортировка: залежавшиеся сверху (давний status_changed_at = выше) для активных.
  // Для «все/конкретный статус» — по дате создания (свежие сверху).
  if (statusFilter === 'active') {
    items.sort((a, b) => {
      const ta = new Date(a.status_changed_at || a.updated_at || a.created_at).getTime();
      const tb = new Date(b.status_changed_at || b.updated_at || b.created_at).getTime();
      return ta - tb;   // меньшее время (давнее) — выше
    });
  } else {
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  return items;
}

export function initOrders(mgrUsername) {
  managerUsername = mgrUsername;
}

export async function loadOrdersSection() {
  try {
    [orders, inquiries] = await Promise.all([
      api.loadOrders().catch(() => []),
      api.loadInquiries().catch(() => []),
    ]);
    // Имена клиентов и товары (для позиций заказа)
    const ids = [...new Set([
      ...orders.map(o => o.customer_tg_id),
      ...inquiries.map(q => q.customer_tg_id),
    ])];
    customersById = await api.loadCustomers(ids).catch(() => ({}));
    try {
      const prods = await api.loadProducts();
      productsById = {};
      prods.forEach(p => { productsById[p.id] = p; });
    } catch (_) {}
    // Первичная инициализация набора известных ID (без звука при первой загрузке)
    initKnownIds();
    await loadUnread();
  } catch (e) {
    console.error('loadOrdersSection failed:', e);
  }
  renderOrdersList();
  updateNavBadges();
}

// Подгружает, какие заказы/обращения имеют непрочитанные сообщения от клиента.
async function loadUnread() {
  try {
    const u = await api.loadUnreadContexts();
    unreadOrders = u.orderIds;
    unreadInquiries = u.inquiryIds;
  } catch (_) {}
}

// Лёгкое обновление списка заказов/обращений без сброса открытой карточки.
export async function refreshList() {
  try {
    [orders, inquiries] = await Promise.all([
      api.loadOrders().catch(() => orders),
      api.loadInquiries().catch(() => inquiries),
    ]);
    detectNew();        // проверяем, появилось ли что-то новое → звук + индикатор
    await loadUnread(); // обновляем индикаторы «ждёт ответа»
    renderOrdersList();
    updateNavBadges();
  } catch (e) {
    console.error('refreshList failed:', e);
  }
}

// ============ УВЕДОМЛЕНИЯ О НОВОМ ============

let knownOrderIds = new Set();
let knownInquiryIds = new Set();
let knownReady = false;

function initKnownIds() {
  knownOrderIds = new Set(orders.map(o => String(o.id)));
  knownInquiryIds = new Set(inquiries.map(q => String(q.id)));
  knownReady = true;
}

function detectNew() {
  if (!knownReady) { initKnownIds(); return; }
  let newCount = 0;
  for (const o of orders) {
    if (!knownOrderIds.has(String(o.id))) { knownOrderIds.add(String(o.id)); newCount++; }
  }
  for (const q of inquiries) {
    if (!knownInquiryIds.has(String(q.id))) { knownInquiryIds.add(String(q.id)); newCount++; }
  }
  if (newCount > 0) {
    playBeep();
    showToast(newCount === 1 ? 'Новое обращение или заказ!' : `${newCount} новых обращений/заказов!`);
  }
}

// Короткий звуковой сигнал через Web Audio API (без внешних файлов).
let audioCtx = null;
function playBeep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch (e) { /* звук недоступен — не критично */ }
}

// Всплывающее уведомление
function showToast(text) {
  let toast = document.getElementById('dashToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dashToast';
    toast.className = 'dash-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = '🔔 ' + text;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), 4000);
}

// Бейджи на вкладках навигации с числом активных
function updateNavBadges() {
  const activeOrders = orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;
  const activeInq = inquiries.filter(q => q.status !== 'closed').length;
  const tabOrders = document.querySelector('.nav-tab[data-section="orders"]');
  if (tabOrders) {
    let badge = tabOrders.querySelector('.nav-badge');
    const total = activeOrders + activeInq;
    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        tabOrders.appendChild(badge);
      }
      badge.textContent = total;
    } else if (badge) {
      badge.remove();
    }
  }
}


function renderOrdersList() {
  const list = document.getElementById('ordersList');
  if (!list) return;

  const countOrders = orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;
  const countInq = inquiries.filter(q => q.status !== 'closed').length;

  // Применяем поиск и фильтр статуса
  let items = activeTab === 'orders' ? orders.slice() : inquiries.slice();
  items = applyListFilters(items);

  // Варианты фильтра статуса зависят от вкладки
  const statusFilterOpts = activeTab === 'orders'
    ? [['active', 'Активные'], ['all', 'Все'],
       ...Object.entries(ORDER_STATUS).map(([k, v]) => [k, v.label])]
    : [['active', 'Активные'], ['all', 'Все'],
       ...Object.entries(INQUIRY_STATUS).map(([k, v]) => [k, v.label])];

  let html = `
    <div class="orders-tabs">
      <button class="orders-tab ${activeTab === 'orders' ? 'active' : ''}" data-tab="orders">
        Заказы${countOrders ? ` <span class="tab-badge">${countOrders}</span>` : ''}
      </button>
      <button class="orders-tab ${activeTab === 'inquiries' ? 'active' : ''}" data-tab="inquiries">
        Обращения${countInq ? ` <span class="tab-badge">${countInq}</span>` : ''}
      </button>
    </div>
    <button class="new-order-btn" id="newOrderBtn">➕ Новый заказ</button>
    ${renderSummary()}
    <div class="list-controls">
      <input type="text" class="list-search" id="listSearch" placeholder="Поиск: номер, имя, ID…" value="${escapeHtml(searchQuery)}">
      <select class="list-filter" id="listFilter">
        ${statusFilterOpts.map(([k, label]) =>
          `<option value="${k}" ${statusFilter === k ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
      </select>
    </div>
    <div class="list-toolbar">
      <label class="mine-check"><input type="checkbox" id="onlyMineChk" ${onlyMine ? 'checked' : ''}> Только мои</label>
      ${activeTab === 'orders' ? `
      <div class="view-switch">
        <button class="view-btn ${listView === 'list' ? 'active' : ''}" data-view="list" title="Список">≡</button>
        <button class="view-btn ${listView === 'board' ? 'active' : ''}" data-view="board" title="Доска по статусам">▦</button>
      </div>` : ''}
    </div>
    <div class="orders-items">`;

  if (!items.length) {
    const emptyMsg = (searchQuery || statusFilter !== 'active')
      ? 'Ничего не найдено по фильтрам'
      : (activeTab === 'orders' ? 'Заказов пока нет' : 'Обращений пока нет');
    html += `<div class="empty-hint">${emptyMsg}</div>`;
  } else if (activeTab === 'orders' && listView === 'board') {
    // Канбан-режим: группировка по статусам (только для активных статусов воронки)
    const boardStatuses = ['new', 'in_progress', 'awaiting_payment', 'paid', 'purchasing', 'shipping', 'ready'];
    const byStatus = {};
    boardStatuses.forEach(s => byStatus[s] = []);
    items.forEach(it => { if (byStatus[it.status]) byStatus[it.status].push(it); });
    html += `<div class="board-cols">` + boardStatuses.map(s => {
      const list = byStatus[s];
      if (!list.length) return '';
      const st = ORDER_STATUS[s];
      return `<div class="board-col">
        <div class="board-col-head status-${st.color}">${escapeHtml(st.label)} <span class="board-col-count">${list.length}</span></div>
        <div class="board-col-items">${list.map(it => orderRowHtml(it)).join('')}</div>
      </div>`;
    }).filter(Boolean).join('') + `</div>`;
  } else {
    html += items.map(it => {
      if (activeTab === 'orders') return orderRowHtml(it);
      const cust = customersById[it.customer_tg_id];
      const name = customerName(cust, it.customer_tg_id);
      const active = String(it.id) === String(activeId) ? ' active' : '';
      const st = INQUIRY_STATUS[it.status] || { label: it.status };
      const typeLabel = it.type === 'product_question' ? 'Вопрос о товаре' : 'Запрос на подбор';
      const unread = unreadInquiries.has(String(it.id)) ? '<span class="unread-dot" title="Есть непрочитанное сообщение"></span>' : '';
      return `<div class="order-row${active}${unread ? ' has-unread' : ''}" data-id="${it.id}">
        <div class="order-row-top">
          <span class="order-row-id">${unread}Обращение №${it.number || ''}</span>
        </div>
        <div class="order-row-name">${escapeHtml(name)}</div>
        <div class="order-row-status">${escapeHtml(typeLabel)} · ${escapeHtml(st.label)}</div>
      </div>`;
    }).join('');
  }
  html += `</div>`;
  list.innerHTML = html;

  const newBtn = document.getElementById('newOrderBtn');
  if (newBtn) newBtn.onclick = startBlankOrder;

  // Поиск (сохраняем фокус: не перерисовываем весь список на каждый символ грубо,
  // но т.к. список лёгкий — просто перерисовываем и возвращаем фокус)
  const searchInput = document.getElementById('listSearch');
  if (searchInput) {
    searchInput.oninput = () => {
      searchQuery = searchInput.value;
      const pos = searchInput.selectionStart;
      renderOrdersList();
      const ni = document.getElementById('listSearch');
      if (ni) { ni.focus(); try { ni.setSelectionRange(pos, pos); } catch (_) {} }
    };
  }
  const filterSel = document.getElementById('listFilter');
  if (filterSel) filterSel.onchange = () => { statusFilter = filterSel.value; renderOrdersList(); };
  const mineChk = document.getElementById('onlyMineChk');
  if (mineChk) mineChk.onchange = () => { onlyMine = mineChk.checked; renderOrdersList(); };
  list.querySelectorAll('.view-btn').forEach(b => {
    b.onclick = () => { listView = b.getAttribute('data-view'); renderOrdersList(); };
  });

  list.querySelectorAll('.orders-tab').forEach(t => {
    t.onclick = () => { activeTab = t.getAttribute('data-tab'); activeId = null; statusFilter = 'active'; searchQuery = ''; renderOrdersList(); clearDetail(); };
  });
  list.querySelectorAll('.order-row').forEach(el => {
    el.onclick = () => openDetail(el.getAttribute('data-id'));
  });
}

function clearDetail() {
  document.getElementById('orderDetailEmpty').style.display = 'flex';
  document.getElementById('orderDetail').style.display = 'none';
  document.body.classList.remove('mobile-detail');   // вернуться к списку на мобиле
}

function openDetail(id) {
  activeId = id;
  renderOrdersList();
  document.getElementById('orderDetailEmpty').style.display = 'none';
  const box = document.getElementById('orderDetail');
  box.style.display = 'flex';
  document.body.classList.add('mobile-detail');       // показать карточку на мобиле

  if (activeTab === 'orders') renderOrderDetail(id);
  else renderInquiryDetail(id);
}

// Возврат к списку (кнопка «назад» на мобиле)
function backToList() {
  activeId = null;
  document.body.classList.remove('mobile-detail');
  renderOrdersList();
}

function renderOrderDetail(id) {
  const o = orders.find(x => String(x.id) === String(id));
  if (!o) return;
  const box = document.getElementById('orderDetail');
  const cust = customersById[o.customer_tg_id];
  const name = customerName(cust, o.customer_tg_id);
  const st = ORDER_STATUS[o.status] || { label: o.status };

  // Позиции заказа
  const items = (o.order_items || []).map(it => {
    const p = productsById[it.product_id];
    const pname = p ? (p.name_ru || p.name_en || it.product_id) : it.product_id;
    const sz = it.size ? `, ${escapeHtml(it.size)}` : '';
    return `<div class="detail-item editable-item" data-item-id="${it.id}">
      <span class="di-name">${escapeHtml(pname)}${sz}</span>
      <span class="di-controls">
        <button class="di-qty-btn" data-act="dec" data-item-id="${it.id}" title="Меньше">−</button>
        <span class="di-qty">${it.qty}</span>
        <button class="di-qty-btn" data-act="inc" data-item-id="${it.id}" title="Больше">+</button>
        <span class="di-price">$${it.price_usd_snapshot}</span>
        <button class="di-del" data-item-id="${it.id}" title="Удалить позицию">✕</button>
      </span>
    </div>`;
  }).join('') || '<div class="detail-item muted">Позиции не указаны</div>';

  // Кнопки статусов: следующий шаг + отмена + произвольный переход
  const curIdx = ORDER_FLOW.indexOf(o.status);
  const nextStatus = (curIdx >= 0 && curIdx < ORDER_FLOW.length - 1) ? ORDER_FLOW[curIdx + 1] : null;

  let statusButtons = '';
  if (nextStatus) {
    statusButtons += `<button class="btn-primary" data-status="${nextStatus}">→ ${escapeHtml(ORDER_STATUS[nextStatus].label)}</button>`;
  }
  if (o.status !== 'cancelled' && o.status !== 'completed') {
    statusButtons += `<button class="btn-danger" data-status="cancelled">${escapeHtml(ORDER_STATUS.cancelled.label)}</button>`;
  }

  // Полный селектор статуса
  const statusOptions = Object.entries(ORDER_STATUS).map(([key, s]) =>
    `<option value="${key}" ${o.status === key ? 'selected' : ''}>${s.label}</option>`).join('');

  box.innerHTML = `
    <div class="detail-top">
      <button class="mobile-back" id="mobileBack"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>К списку</button>
      <div class="detail-head-compact">
        <h2>Заказ №${o.id}</h2>
        <span class="detail-status-badge">${escapeHtml(st.label)}</span>
        <span class="detail-head-sum">$${o.total_usd} / ${o.total_byn} BYN</span>
      </div>
      <div class="detail-quickstatus">
        <div class="status-actions">${statusButtons}</div>
      </div>
      <div class="detail-assign-row">
        ${o.assigned_to
          ? `<span class="assign-badge">👤 ${escapeHtml(o.assigned_to)}</span>`
          : `<button class="btn-take" id="takeOrderBtn">✋ Взять в работу</button>`}
        <span class="status-age" title="Время в текущем статусе">⏱ в статусе ${timeAgo(o.status_changed_at || o.updated_at)}</span>
        ${o.is_paid ? '<span class="paid-badge">💳 оплачен</span>' : ''}
      </div>
      ${st.next ? `<div class="next-step">➡️ <b>Дальше:</b> ${escapeHtml(st.next)}</div>` : ''}
      <details class="detail-collapse">
        <summary>Детали заказа, статус, заметка</summary>
        <div class="detail-meta">
          <div><b>Клиент:</b> ${escapeHtml(name)}</div>
          ${customerStatsHtml(o.customer_tg_id)}
          <div><b>ID:</b> <button class="copy-id" data-id="${o.customer_tg_id}" title="Копировать ID">${o.customer_tg_id} 📋</button></div>
          <div><b>Создан:</b> ${escapeHtml(formatFullDate(o.created_at))} ${escapeHtml(formatTime(o.created_at))}</div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">Состав заказа</div>
          ${items}
          <button class="btn-light" id="addToOrderBtn" style="margin-top:10px">➕ Добавить позицию</button>
          <div class="order-form" id="addItemsForm" style="display:none;margin-top:10px">
            <div id="orderItems"></div>
            <button class="btn-light" id="addOrderItem">+ Ещё позиция</button>
            <button class="btn-light" id="addNewProductBtn2">🆕 Нет в каталоге — создать товар</button>
            <div class="order-form-total" id="orderFormTotal"></div>
            <div class="order-form-actions">
              <button class="btn-primary" id="saveAddItems">Добавить в заказ</button>
              <button class="btn-light" id="cancelAddItems">Отмена</button>
            </div>
          </div>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">Сменить статус (полный список)</div>
          <div class="status-manual">
            <select id="orderStatusSelect">${statusOptions}</select>
            <button class="btn-light" id="orderStatusApply">Применить</button>
          </div>
          <label class="notify-check">
            <input type="checkbox" id="orderNotify" checked> Уведомить клиента в Telegram
          </label>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">Заметка менеджера</div>
          <textarea id="orderNote" rows="2" placeholder="Внутренняя заметка (клиент не видит)">${escapeHtml(o.manager_note || '')}</textarea>
          <button class="btn-light" id="orderNoteSave">Сохранить заметку</button>
        </div>
        <div class="detail-section">
          <div class="detail-section-title">Оплата и доставка</div>
          <label class="paid-check">
            <input type="checkbox" id="orderPaid" ${o.is_paid ? 'checked' : ''}> Заказ оплачен
            ${o.paid_at ? `<span class="paid-date">(${escapeHtml(formatFullDate(o.paid_at))})</span>` : ''}
          </label>
          <button class="btn-light" id="requestPaymentBtn" style="margin-bottom:8px">💳 Запросить оплату</button>
          <div class="track-row">
            <input type="text" id="orderTrack" placeholder="Трек-номер посылки" value="${escapeHtml(o.tracking_number || '')}">
            <button class="btn-light" id="orderTrackSave">Сохранить</button>
          </div>
          <label class="notify-check" style="margin-top:6px">
            <input type="checkbox" id="trackNotify" checked> Отправить трек клиенту
          </label>
        </div>
        ${o.cancel_reason ? `<div class="detail-section"><div class="cancel-reason">❌ Причина отмены: ${escapeHtml(o.cancel_reason)}</div></div>` : ''}
        <div class="detail-section">
          <div class="detail-section-title">История статусов</div>
          <div class="status-history" id="statusHistory">загрузка…</div>
        </div>
      </details>
      <div class="detail-status-msg" id="detailStatusMsg"></div>
    </div>

    <div class="convo-section">
      <div class="convo-messages" id="convoMessages"></div>
      ${renderComposer(isOrderActive(o.status))}
    </div>
  `;

  // Кнопка «назад» (мобильная)
  const mb = document.getElementById('mobileBack');
  if (mb) mb.onclick = backToList;
  setupCopyId();

  // Взять в работу (#8)
  const takeBtn = document.getElementById('takeOrderBtn');
  if (takeBtn) takeBtn.onclick = async () => {
    takeBtn.disabled = true;
    try {
      await api.assignManager({ order_id: o.id }, managerUsername);
      o.assigned_to = managerUsername;
      const inArr = orders.find(x => String(x.id) === String(o.id));
      if (inArr) inArr.assigned_to = managerUsername;
      renderOrderDetail(o.id);
      renderOrdersList();
    } catch (e) { console.error(e); setDetailMsg('Ошибка назначения', true); takeBtn.disabled = false; }
  };

  // Отметка оплаты (#4)
  const paidChk = document.getElementById('orderPaid');
  if (paidChk) paidChk.onchange = async () => {
    try {
      await api.setPaid(o.id, paidChk.checked);
      o.is_paid = paidChk.checked;
      o.paid_at = paidChk.checked ? new Date().toISOString() : null;
      const inArr = orders.find(x => String(x.id) === String(o.id));
      if (inArr) { inArr.is_paid = o.is_paid; inArr.paid_at = o.paid_at; }
      setDetailMsg('Отметка оплаты сохранена ✓');
      renderOrderDetail(o.id);
    } catch (e) { console.error(e); setDetailMsg('Ошибка', true); paidChk.checked = !paidChk.checked; }
  };

  // Трек-номер (#4) — сохранить и опционально отправить клиенту
  const trackSave = document.getElementById('orderTrackSave');
  if (trackSave) trackSave.onclick = async () => {
    const track = document.getElementById('orderTrack').value.trim();
    trackSave.disabled = true;
    try {
      await api.setTrackingNumber(o.id, track);
      o.tracking_number = track;
      const notify = document.getElementById('trackNotify')?.checked;
      if (track && notify) {
        await api.sendReply(o.customer_tg_id,
          `Ваш заказ №${o.id} отправлен 📦\nТрек-номер для отслеживания: ${track}`,
          managerUsername, { order_id: o.id });
      }
      setDetailMsg('Трек сохранён ✓' + (track && notify ? ' Клиент уведомлён.' : ''));
    } catch (e) { console.error(e); setDetailMsg('Ошибка сохранения трека', true); }
    finally { trackSave.disabled = false; }
  };

  // Запросить оплату (#3): реквизиты из настроек + сумма → в поле ответа
  const reqPayBtn = document.getElementById('requestPaymentBtn');
  if (reqPayBtn) reqPayBtn.onclick = () => {
    const reqs = getPaymentRequisites();
    if (!reqs.trim()) {
      if (confirm('Реквизиты не заданы. Открыть настройки реквизитов?')) openRequisitesModal();
      return;
    }
    const sum = o.currency === 'BYN' ? `${o.total_byn} BYN` : `$${o.total_usd}`;
    const text = `Заказ №${o.id} подтверждён ✅\nСумма к оплате: ${sum}\n\nРеквизиты для оплаты:\n${reqs}\n\nПосле оплаты пришлите, пожалуйста, чек 🙏`;
    const input = document.getElementById('convoInput');
    if (input) {
      input.value = text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      input.focus();
      setDetailMsg('Сообщение об оплате готово — проверьте и отправьте');
    }
  };

  // История статусов (#3)
  loadAndRenderHistory({ order_id: o.id });

  // Кнопки быстрого статуса
  box.querySelectorAll('[data-status]').forEach(btn => {
    btn.onclick = () => changeOrderStatus(o, btn.getAttribute('data-status'));
  });
  document.getElementById('orderStatusApply').onclick = () => {
    changeOrderStatus(o, document.getElementById('orderStatusSelect').value);
  };
  document.getElementById('orderNoteSave').onclick = async () => {
    const note = document.getElementById('orderNote').value;
    try {
      await api.setOrderNote(o.id, note);
      o.manager_note = note;
      setDetailMsg('Заметка сохранена ✓');
    } catch (e) { setDetailMsg('Ошибка сохранения заметки', true); }
  };

  // Редактирование/удаление позиций заказа
  box.querySelectorAll('.di-qty-btn').forEach(btn => {
    btn.onclick = async () => {
      const itemId = btn.getAttribute('data-item-id');
      const act = btn.getAttribute('data-act');
      const item = (o.order_items || []).find(x => String(x.id) === String(itemId));
      if (!item) return;
      const newQty = act === 'inc' ? item.qty + 1 : item.qty - 1;
      if (newQty < 1) return;
      btn.disabled = true;
      try {
        await api.updateOrderItemQty(itemId, newQty, o.id);
        await loadOrdersSection();
        openDetail(String(o.id));
      } catch (e) { console.error(e); setDetailMsg('Ошибка изменения количества', true); btn.disabled = false; }
    };
  });
  box.querySelectorAll('.di-del').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Удалить позицию из заказа?')) return;
      const itemId = btn.getAttribute('data-item-id');
      btn.disabled = true;
      try {
        await api.deleteOrderItem(itemId, o.id);
        await loadOrdersSection();
        openDetail(String(o.id));
      } catch (e) { console.error(e); setDetailMsg('Ошибка удаления позиции', true); btn.disabled = false; }
    };
  });

  // Добавление позиций в существующий заказ (#9)
  const addBtn = document.getElementById('addToOrderBtn');
  if (addBtn) {
    addBtn.onclick = () => {
      orderDraft = { existingOrder: o, items: [{ product_id: '', size: '', qty: 1 }] };
      addBtn.style.display = 'none';
      const details = document.querySelector('.detail-collapse');
      if (details) details.open = true;
      document.getElementById('addItemsForm').style.display = 'block';
      renderOrderForm();
      document.getElementById('addOrderItem').onclick = () => { orderDraft.items.push({ product_id:'', size:'', qty:1 }); renderOrderForm(); };
      document.getElementById('addNewProductBtn2').onclick = openQuickProductModal;
      document.getElementById('cancelAddItems').onclick = () => {
        orderDraft = null;
        document.getElementById('addItemsForm').style.display = 'none';
        addBtn.style.display = '';
      };
      document.getElementById('saveAddItems').onclick = () => saveAddItems(o);
    };
  }

  // Переписка + композер
  setupConvo({ order_id: o.id }, o.customer_tg_id, isOrderActive(o.status));
}

async function saveAddItems(order) {
  if (!orderDraft) return;
  const items = orderDraft.items.filter(it => it.product_id).map(it => {
    const p = productsById[it.product_id];
    return { product_id: it.product_id, size: it.size || '', qty: it.qty || 1,
             price_usd: p ? p.price_usd : 0, price_byn: p ? p.price_byn : 0 };
  });
  if (!items.length) { setDetailMsg('Выберите товар для добавления', true); return; }
  const btn = document.getElementById('saveAddItems');
  btn.disabled = true;
  setDetailMsg('Добавляем…');
  try {
    await api.addOrderItems(order.id, items);
    orderDraft = null;
    await loadOrdersSection();
    openDetail(String(order.id));
    setDetailMsg('Позиции добавлены ✓');
  } catch (e) {
    console.error(e);
    setDetailMsg('Ошибка добавления', true);
    btn.disabled = false;
  }
}

async function changeOrderStatus(order, status) {
  if (statusBusy) return;                          // защита от спама
  if (status === order.status) { setDetailMsg('Этот статус уже установлен'); return; }
  // Подтверждение + причина для необратимой отмены
  let cancelReason = null;
  if (status === 'cancelled') {
    if (!confirm(`Отменить заказ №${order.id}?`)) return;
    cancelReason = prompt('Причина отмены (необязательно):\nнапр. нет в наличии / клиент отказался / дубль', '') || '';
  } else {
    // #10 Защита от пропуска этапов: если перескакиваем вперёд больше чем на 1 шаг
    const fromIdx = ORDER_FLOW.indexOf(order.status);
    const toIdx = ORDER_FLOW.indexOf(status);
    if (fromIdx >= 0 && toIdx > fromIdx + 1) {
      const skipped = ORDER_FLOW.slice(fromIdx + 1, toIdx).map(s => ORDER_STATUS[s].label).join(', ');
      if (!confirm(`Вы пропускаете этапы: ${skipped}.\nВсё равно перейти к «${ORDER_STATUS[status].label}»?`)) return;
    }
    // #11 Напоминание про трек при переходе в «В пути»
    if (status === 'shipping' && !order.tracking_number) {
      if (!confirm('Трек-номер не указан. Перейти в «В пути» без трека?\n(можно добавить трек позже в деталях заказа)')) return;
    }
  }
  const oldStatus = order.status;
  statusBusy = true;
  // Блокируем все кнопки статуса визуально
  document.querySelectorAll('.status-actions button, #orderStatusApply').forEach(b => b.disabled = true);
  const notify = document.getElementById('orderNotify')?.checked;
  const clientMsg = (notify && ORDER_STATUS[status]) ? ORDER_STATUS[status].client : null;
  const fullMsg = clientMsg ? `${clientMsg}\n\nЗаказ №${order.id}` : null;
  setDetailMsg('Меняем статус…');
  try {
    await api.setOrderStatus(order.id, status, fullMsg, order.customer_tg_id, managerUsername, oldStatus, cancelReason);
    order.status = status;
    order.status_changed_at = new Date().toISOString();
    if (cancelReason != null) order.cancel_reason = cancelReason;
    const inArr = orders.find(x => String(x.id) === String(order.id));
    if (inArr) { inArr.status = status; inArr.status_changed_at = order.status_changed_at; }
    setDetailMsg('Статус обновлён ✓' + (fullMsg ? ' Клиент уведомлён.' : ''));
    renderOrdersList();
    renderOrderDetail(order.id);     // перерисовка покажет новый статус и доступность переписки
    // Заготовка действия для нового статуса (#2): подставляем в поле ответа
    applyStatusTemplate(status, order.id);
  } catch (e) {
    console.error(e);
    setDetailMsg('Ошибка смены статуса', true);
    document.querySelectorAll('.status-actions button, #orderStatusApply').forEach(b => b.disabled = false);
  } finally {
    statusBusy = false;
  }
}

function renderInquiryDetail(id) {
  const q = inquiries.find(x => String(x.id) === String(id));
  if (!q) return;
  const box = document.getElementById('orderDetail');
  const cust = customersById[q.customer_tg_id];
  const name = customerName(cust, q.customer_tg_id);
  const st = INQUIRY_STATUS[q.status] || { label: q.status };
  const typeLabel = q.type === 'product_question' ? 'Вопрос о товаре' : 'Запрос на подбор';

  let prodLine = '';
  if (q.product_id && productsById[q.product_id]) {
    const p = productsById[q.product_id];
    prodLine = `<div><b>Товар:</b> ${escapeHtml(p.name_ru || p.name_en || q.product_id)}</div>`;
  }

  const statusButtons = Object.entries(INQUIRY_STATUS)
    .filter(([key]) => key !== q.status)
    .map(([key, s]) => {
      const cls = key === 'closed' ? 'btn-light' : 'btn-primary';
      return `<button class="${cls}" data-status="${key}">${escapeHtml(s.label)}</button>`;
    }).join('');

  box.innerHTML = `
    <div class="detail-top">
      <button class="mobile-back" id="mobileBack"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>К списку</button>
      <div class="detail-head-compact">
        <h2>Обращение №${q.number || ''}</h2>
        <span class="detail-status-badge">${escapeHtml(st.label)}</span>
        <span class="detail-head-sum">${escapeHtml(typeLabel)}</span>
      </div>
      <div class="detail-quickstatus">
        <div class="status-actions">${statusButtons}</div>
        <button class="btn-primary btn-create-order" id="inqCreateOrder">➕ Создать заказ</button>
      </div>
      <div class="detail-assign-row">
        ${q.assigned_to
          ? `<span class="assign-badge">👤 ${escapeHtml(q.assigned_to)}</span>`
          : `<button class="btn-take" id="takeInqBtn">✋ Взять в работу</button>`}
        <span class="status-age" title="Время в текущем статусе">⏱ в статусе ${timeAgo(q.status_changed_at || q.updated_at)}</span>
      </div>
      <details class="detail-collapse">
        <summary>Детали обращения и оформление заказа</summary>
        <div class="detail-meta">
          <div><b>Клиент:</b> ${escapeHtml(name)}</div>
          ${customerStatsHtml(q.customer_tg_id)}
          <div><b>ID:</b> <button class="copy-id" data-id="${q.customer_tg_id}" title="Копировать ID">${q.customer_tg_id} 📋</button></div>
          <div><b>Тип:</b> ${escapeHtml(typeLabel)}</div>
          ${prodLine}
          <div><b>Создано:</b> ${escapeHtml(formatFullDate(q.created_at))} ${escapeHtml(formatTime(q.created_at))}</div>
        </div>
        <label class="notify-check">
          <input type="checkbox" id="inqNotify" checked> Уведомлять клиента в Telegram при смене статуса
        </label>
        <div class="detail-section">
          <div class="order-form" id="orderForm" style="display:none">
            <div class="detail-section-title">Состав заказа</div>
            <div id="orderItems"></div>
            <button class="btn-light" id="addOrderItem">+ Добавить позицию</button>
            <button class="btn-light" id="addNewProductBtn">🆕 Нет в каталоге — создать товар</button>
            <div class="order-form-total" id="orderFormTotal"></div>
            <div class="order-form-actions">
              <button class="btn-primary" id="saveOrder">Создать заказ</button>
              <button class="btn-light" id="cancelOrderForm">Отмена</button>
            </div>
          </div>
        </div>
        ${q.cancel_reason ? `<div class="detail-section"><div class="cancel-reason">❌ Причина: ${escapeHtml(q.cancel_reason)}</div></div>` : ''}
        <div class="detail-section">
          <div class="detail-section-title">История статусов</div>
          <div class="status-history" id="statusHistory">загрузка…</div>
        </div>
      </details>
      <div class="detail-status-msg" id="detailStatusMsg"></div>
    </div>

    <div class="convo-section">
      <div class="convo-messages" id="convoMessages"></div>
      ${renderComposer(isInquiryActive(q.status))}
    </div>
  `;

  box.querySelectorAll('[data-status]').forEach(btn => {
    btn.onclick = () => changeInquiryStatus(q, btn.getAttribute('data-status'));
  });

  // Создание заказа из обращения
  document.getElementById('inqCreateOrder').onclick = () => startOrderForm(q);
  const mbq = document.getElementById('mobileBack');
  if (mbq) mbq.onclick = backToList;
  setupCopyId();

  // Взять в работу (#8)
  const takeBtn = document.getElementById('takeInqBtn');
  if (takeBtn) takeBtn.onclick = async () => {
    takeBtn.disabled = true;
    try {
      await api.assignManager({ inquiry_id: q.id }, managerUsername);
      q.assigned_to = managerUsername;
      const inArr = inquiries.find(x => String(x.id) === String(q.id));
      if (inArr) inArr.assigned_to = managerUsername;
      renderInquiryDetail(q.id);
      renderOrdersList();
    } catch (e) { console.error(e); setDetailMsg('Ошибка назначения', true); takeBtn.disabled = false; }
  };

  // История статусов (#3)
  loadAndRenderHistory({ inquiry_id: q.id });

  setupConvo({ inquiry_id: q.id }, q.customer_tg_id, isInquiryActive(q.status));
}

async function changeInquiryStatus(q, status) {
  if (statusBusy) return;
  const oldStatus = q.status;
  statusBusy = true;
  document.querySelectorAll('.status-actions button').forEach(b => b.disabled = true);
  const notify = document.getElementById('inqNotify')?.checked;
  const clientMsg = (notify && INQUIRY_STATUS[status]) ? INQUIRY_STATUS[status].client : null;
  setDetailMsg('Меняем статус…');
  try {
    await api.setInquiryStatus(q.id, status, clientMsg, q.customer_tg_id, managerUsername, oldStatus);
    // Обновляем статус и в самом объекте, и в массиве (на случай если это разные ссылки)
    q.status = status;
    q.status_changed_at = new Date().toISOString();
    const inArr = inquiries.find(x => String(x.id) === String(q.id));
    if (inArr) { inArr.status = status; inArr.status_changed_at = q.status_changed_at; }
    setDetailMsg('Статус обновлён ✓' + (clientMsg ? ' Клиент уведомлён.' : ''));
    renderOrdersList();
    renderInquiryDetail(q.id);
  } catch (e) {
    console.error(e);
    setDetailMsg('Ошибка смены статуса', true);
    document.querySelectorAll('.status-actions button').forEach(b => b.disabled = false);
  } finally {
    statusBusy = false;
  }
}

function setDetailMsg(text, isError) {
  const el = document.getElementById('detailStatusMsg');
  if (!el) return;
  el.textContent = text;
  el.className = 'detail-status-msg' + (isError ? ' error' : '');
}

// ============ ПЕРЕПИСКА ВНУТРИ КАРТОЧКИ ============

let convoContext = null;     // { order_id } | { inquiry_id }
let convoCustomerId = null;
let convoActive = false;
let convoAttachment = null;  // { url, name } прикреплённый файл

// Разметка композера (поле ввода внизу). disabled — если статус неактивный.
function renderComposer(active) {
  if (!active) {
    return `<div class="convo-locked">
      🔒 Переписка доступна только в активном статусе. Чтобы написать клиенту — верните заявку в работу.
    </div>`;
  }
  return `
    <div class="convo-composer" id="convoComposer">
      <div class="convo-attach-preview" id="convoAttachPreview" style="display:none"></div>
      <div class="emoji-panel" id="emojiPanel" style="display:none"></div>
      <div class="convo-composer-row">
        <label class="convo-attach-btn" title="Прикрепить файл">
          <input type="file" id="convoFile" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </label>
        <button class="convo-emoji-btn" id="convoEmojiBtn" type="button" title="Эмодзи">😊</button>
        <button class="convo-emoji-btn" id="convoTplBtn" type="button" title="Шаблоны ответов">📝</button>
        <textarea id="convoInput" placeholder="Напишите ответ клиенту…" rows="1"></textarea>
        <button class="convo-send" id="convoSend" title="Отправить">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>`;
}

// Популярные эмодзи для быстрой вставки
const EMOJI_LIST = ['😊','👍','🙌','💛','🎉','✅','🔥','😍','🙏','👌','🤝','💪','✨','🛍','📦','🚚','⏱','💳','❤️','😅','🤔','👋','🙂','😉','💯','⭐','📸','🎁','💬','✏️'];

function setupEmojiPanel() {
  const btn = document.getElementById('convoEmojiBtn');
  const panel = document.getElementById('emojiPanel');
  const input = document.getElementById('convoInput');
  if (!btn || !panel || !input) return;
  panel.innerHTML = EMOJI_LIST.map(e => `<button type="button" class="emoji-item">${e}</button>`).join('');
  btn.onclick = (ev) => {
    ev.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  };
  panel.querySelectorAll('.emoji-item').forEach(el => {
    el.onclick = () => {
      // Вставляем эмодзи в позицию курсора
      const start = input.selectionStart || input.value.length;
      const end = input.selectionEnd || input.value.length;
      input.value = input.value.slice(0, start) + el.textContent + input.value.slice(end);
      input.focus();
      const pos = start + el.textContent.length;
      input.setSelectionRange(pos, pos);
      panel.style.display = 'none';
    };
  });
  // Клик вне панели закрывает её
  document.addEventListener('click', (ev) => {
    if (panel.style.display !== 'none' && !panel.contains(ev.target) && ev.target !== btn) {
      panel.style.display = 'none';
    }
  });
}

async function setupConvo(context, customerTgId, active) {
  convoContext = context;
  convoCustomerId = customerTgId;
  convoActive = active;
  convoAttachment = null;
  // Сбрасываем состояние переписки предыдущей карточки
  serverMsgs = [];
  pendingOut = [];

  await refreshConvo();

  // Помечаем входящие этого заказа/обращения прочитанными и снимаем индикатор
  try {
    await api.markContextRead(context);
    if (context.order_id != null) unreadOrders.delete(String(context.order_id));
    if (context.inquiry_id != null) unreadInquiries.delete(String(context.inquiry_id));
    renderOrdersList();
  } catch (_) {}

  // Автообновление переписки каждые 5с, пока карточка открыта
  if (convoTimer) clearInterval(convoTimer);
  convoTimer = setInterval(refreshConvo, 5000);

  if (!active) return;

  setupEmojiPanel();
  const tplBtn = document.getElementById('convoTplBtn');
  if (tplBtn) tplBtn.onclick = (e) => { e.stopPropagation(); openTemplatesPicker(); };

  const input = document.getElementById('convoInput');
  const sendBtn = document.getElementById('convoSend');
  const fileInput = document.getElementById('convoFile');

  if (sendBtn) sendBtn.onclick = sendConvoMessage;
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendConvoMessage(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      const preview = document.getElementById('convoAttachPreview');
      preview.style.display = 'block';
      preview.textContent = '⏳ Загружаем файл…';
      try {
        const url = await api.uploadFile(f);
        convoAttachment = { url, name: f.name };
        preview.innerHTML = `📎 ${escapeHtml(f.name)} <button class="convo-attach-del" id="convoAttachDel">✕</button>`;
        document.getElementById('convoAttachDel').onclick = () => {
          convoAttachment = null;
          preview.style.display = 'none';
          fileInput.value = '';
        };
      } catch (e) {
        console.error(e);
        preview.textContent = '⚠️ Не удалось загрузить файл';
        convoAttachment = null;
      }
    });
  }
}

let serverMsgs = [];   // последние сообщения из БД
let pendingOut = [];   // оптимистичные (неподтверждённые) исходящие [{tempId,text,hasAttachment,ts,state}]
let convoLoading = false;  // защита от параллельных refreshConvo

async function refreshConvo() {
  const box = document.getElementById('convoMessages');
  if (!box || !convoContext) return;
  if (convoLoading) return;        // не запускаем второй параллельный заход
  convoLoading = true;
  let msgs = [];
  try {
    if (convoContext.order_id) msgs = await api.loadOrderMessages(convoContext.order_id, convoCustomerId);
    else if (convoContext.inquiry_id) msgs = await api.loadInquiryMessages(convoContext.inquiry_id, convoCustomerId);
  } catch (e) {
    if (serverMsgs.length === 0 && pendingOut.length === 0) {
      box.innerHTML = '<div class="convo-empty">Не удалось загрузить переписку</div>';
    }
    convoLoading = false;
    return;
  }
  serverMsgs = msgs || [];

  // Подтверждаем pending: исходящее серверное сообщение считается «той же»
  // оптимистичной копией, если совпадает текст/наличие вложения И создано
  // не раньше момента отправки (защита от ложного совпадения со старым).
  if (pendingOut.length > 0) {
    pendingOut = pendingOut.filter(p => {
      const confirmed = serverMsgs.some(m => {
        if (m.direction !== 'out') return false;
        const sameText = (m.text || '') === (p.text || '');
        const sameAtt = (!!m.attachment_url === p.hasAttachment);
        const created = new Date(m.created_at).getTime();
        // допускаем небольшой зазор времён (5с) на случай рассинхрона часов
        const fresh = created >= (p.ts - 5000);
        return sameText && sameAtt && fresh;
      });
      return !confirmed;
    });
  }
  renderConvoFromCache();
  convoLoading = false;
}

// Рисует переписку: серверные сообщения + ещё не подтверждённые pending снизу.
function renderConvoFromCache() {
  const box = document.getElementById('convoMessages');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;

  let html = '';
  if (serverMsgs.length === 0 && pendingOut.length === 0) {
    box.innerHTML = '<div class="convo-empty">Сообщений пока нет. Можете написать первым.</div>';
    return;
  }
  html += serverMsgs.map(renderConvoMsg).join('');
  // Оптимистичные (неподтверждённые) — снизу, с пометкой состояния
  html += pendingOut.map(renderPendingMsg).join('');
  box.innerHTML = html;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderPendingMsg(p) {
  let status, cls;
  if (p.state === 'error') { status = '⚠️ не отправлено'; cls = 'cmsg-pending-error'; }
  else if (p.state === 'queued') { status = 'отправляется…'; cls = 'cmsg-pending'; }
  else { status = 'отправка…'; cls = 'cmsg-pending'; }
  const att = p.hasAttachment ? '<div class="cmsg-text">📎 Вложение</div>' : '';
  const txt = p.text ? `<div class="cmsg-text">${escapeHtml(p.text)}</div>` : '';
  return `<div class="cmsg cmsg-out ${cls}"><div class="cmsg-bubble">${att}${txt}<div class="cmsg-meta">@${escapeHtml(managerUsername)} · ${status}</div></div></div>`;
}

function renderConvoMsg(m) {
  const out = m.direction === 'out';
  const isBot = m.sender === 'bot';
  let cls = out ? 'cmsg cmsg-out' : 'cmsg cmsg-in';
  if (isBot) cls += ' cmsg-bot';
  let inner = '';
  if (m.attachment_url) {
    if (m.attachment_type === 'photo') {
      inner += `<a href="${escapeHtml(m.attachment_url)}" target="_blank" rel="noopener"><img class="cmsg-photo" src="${escapeHtml(m.attachment_url)}" loading="lazy"></a>`;
    } else {
      inner += `<a class="cmsg-file" href="${escapeHtml(m.attachment_url)}" target="_blank" rel="noopener">📎 Вложение</a>`;
    }
  }
  if (m.text) inner += `<div class="cmsg-text">${escapeHtml(m.text)}</div>`;
  if (!inner) inner = `<div class="cmsg-text cmsg-muted">📎 вложение (не удалось загрузить)</div>`;
  let who = '';
  if (out) who = isBot ? '🤖 авто' : (m.manager_username ? '@' + escapeHtml(m.manager_username) : 'менеджер');
  const meta = `<div class="cmsg-meta">${who ? who + ' · ' : ''}${escapeHtml(formatTime(m.created_at))} ✓</div>`;
  return `<div class="${cls}"><div class="cmsg-bubble">${inner}${meta}</div></div>`;
}

async function sendConvoMessage() {
  const input = document.getElementById('convoInput');
  const sendBtn = document.getElementById('convoSend');
  if (!input || !convoActive) return;
  const text = input.value.trim();
  if (!text && !convoAttachment) return;

  const attachmentUrl = convoAttachment ? convoAttachment.url : null;
  const tempId = 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  // Сразу очищаем поле и показываем сообщение как «отправляется» —
  // мгновенная реакция, менеджер видит, что сообщение принято к отправке.
  input.value = '';
  input.style.height = 'auto';
  convoAttachment = null;
  const preview = document.getElementById('convoAttachPreview');
  if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
  const fileInput = document.getElementById('convoFile');
  if (fileInput) fileInput.value = '';

  pendingOut.push({ tempId, text, hasAttachment: !!attachmentUrl, ts: Date.now(), state: 'sending' });
  renderConvoFromCache();   // дорисовать pending

  try {
    await api.sendReply(convoCustomerId, text, managerUsername, convoContext, attachmentUrl);
    // Помечаем «в очереди у бота» — ждём подтверждения из БД
    const p = pendingOut.find(x => x.tempId === tempId);
    if (p) p.state = 'queued';
    renderConvoFromCache();
    // Ускоренный поллинг: несколько частых проверок, чтобы реальное
    // сообщение появилось быстро, а не через обычные 5с.
    fastConfirmPoll();
  } catch (e) {
    console.error('sendConvoMessage failed:', e);
    const p = pendingOut.find(x => x.tempId === tempId);
    if (p) p.state = 'error';
    renderConvoFromCache();
  } finally {
    input.focus();
  }
}

// Несколько быстрых проверок переписки подряд после отправки.
let fastPollActive = false;
async function fastConfirmPoll() {
  if (fastPollActive) return;
  fastPollActive = true;
  for (let i = 0; i < 5 && pendingOut.length > 0; i++) {
    await new Promise(r => setTimeout(r, 1200));
    await refreshConvo();
  }
  fastPollActive = false;
}

// Останавливаем автообновление переписки при уходе из раздела
export function stopConvo() {
  if (convoTimer) { clearInterval(convoTimer); convoTimer = null; }
}

// ============ СОЗДАНИЕ ЗАКАЗА ИЗ ОБРАЩЕНИЯ ============

let orderDraft = null;   // { inquiry, items: [{product_id, size, qty}] }

function startOrderForm(inquiry) {
  orderDraft = { inquiry, items: [{ product_id: '', size: '', qty: 1 }] };
  document.getElementById('inqCreateOrder').style.display = 'none';
  // Раскрываем свёрнутую секцию деталей, чтобы форма была видна
  const details = document.querySelector('.detail-collapse');
  if (details) details.open = true;
  document.getElementById('orderForm').style.display = 'block';
  renderOrderForm();
  document.getElementById('addOrderItem').onclick = () => {
    orderDraft.items.push({ product_id: '', size: '', qty: 1 });
    renderOrderForm();
  };
  const addNewBtn = document.getElementById('addNewProductBtn');
  if (addNewBtn) addNewBtn.onclick = openQuickProductModal;
  document.getElementById('cancelOrderForm').onclick = () => {
    orderDraft = null;
    document.getElementById('orderForm').style.display = 'none';
    document.getElementById('inqCreateOrder').style.display = '';
  };
  document.getElementById('saveOrder').onclick = saveOrderDraft;
}

function renderOrderForm() {
  const box = document.getElementById('orderItems');
  const prods = Object.values(productsById);
  box.innerHTML = orderDraft.items.map((it, i) => {
    // Опции с ценой и наличием прямо в тексте
    const opts = prods.map(p => {
      const price = p.price_usd ? `$${p.price_usd}` : '';
      const hidden = p.is_active === false ? ' • скрыт' : '';
      const stockTotal = p.stock ? Object.values(p.stock).reduce((s, n) => s + (Number(n) || 0), 0) : 0;
      const stockInfo = (p.sizes && p.sizes.length) ? ` • ${stockTotal} шт` : '';
      const label = `${p.name_ru || p.name_en || p.id} — ${price}${stockInfo}${hidden}`;
      return `<option value="${escapeHtml(p.id)}" ${it.product_id === p.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    const prod = productsById[it.product_id];
    const sizes = (prod && prod.sizes) || [];
    const sizeOpts = sizes.length
      ? `<select class="oi-size" data-i="${i}"><option value="">размер</option>` +
        sizes.map(s => {
          const st = prod.stock && prod.stock[s] != null ? ` (${prod.stock[s]})` : '';
          return `<option value="${escapeHtml(s)}" ${it.size === s ? 'selected' : ''}>${escapeHtml(s)}${st}</option>`;
        }).join('') + `</select>`
      : `<input class="oi-size-text" data-i="${i}" placeholder="размер" value="${escapeHtml(it.size || '')}">`;

    // Превью выбранного товара (фото + цена)
    let preview = '';
    if (prod) {
      const img = (prod.images && prod.images[0]) || '';
      preview = `<div class="oi-preview">
        <div class="oi-preview-img">${img ? `<img src="${escapeHtml(img)}" alt="">` : '🖼'}</div>
        <div class="oi-preview-info">
          <div class="oi-preview-name">${escapeHtml(prod.name_ru || prod.name_en || prod.id)}</div>
          <div class="oi-preview-price">$${prod.price_usd || 0} · ${prod.price_byn || 0} BYN${prod.is_active === false ? ' · <span class="oi-hidden-tag">скрыт</span>' : ''}</div>
        </div>
      </div>`;
    }

    return `<div class="order-item-row-wrap">
      <div class="order-item-row">
        <select class="oi-product" data-i="${i}"><option value="">— выберите товар —</option>${opts}</select>
        ${sizeOpts}
        <input type="number" class="oi-qty" data-i="${i}" value="${it.qty || 1}" min="1" title="кол-во">
        <button class="oi-del" data-i="${i}" title="Убрать позицию">✕</button>
      </div>
      ${preview}
    </div>`;
  }).join('');

  box.querySelectorAll('.oi-product').forEach(sel => {
    sel.onchange = () => { orderDraft.items[+sel.dataset.i].product_id = sel.value; orderDraft.items[+sel.dataset.i].size = ''; renderOrderForm(); };
  });
  box.querySelectorAll('.oi-size').forEach(sel => {
    sel.onchange = () => { orderDraft.items[+sel.dataset.i].size = sel.value; };
  });
  box.querySelectorAll('.oi-size-text').forEach(inp => {
    inp.oninput = () => { orderDraft.items[+inp.dataset.i].size = inp.value; };
  });
  box.querySelectorAll('.oi-qty').forEach(inp => {
    inp.oninput = () => { orderDraft.items[+inp.dataset.i].qty = Math.max(1, parseInt(inp.value) || 1); updateOrderTotal(); };
  });
  box.querySelectorAll('.oi-del').forEach(btn => {
    btn.onclick = () => { orderDraft.items.splice(+btn.dataset.i, 1); if (!orderDraft.items.length) orderDraft.items.push({ product_id:'', size:'', qty:1 }); renderOrderForm(); };
  });
  updateOrderTotal();
}

function updateOrderTotal() {
  let usd = 0, byn = 0;
  orderDraft.items.forEach(it => {
    const p = productsById[it.product_id];
    if (p) { usd += (Number(p.price_usd) || 0) * (it.qty || 1); byn += (Number(p.price_byn) || 0) * (it.qty || 1); }
  });
  const el = document.getElementById('orderFormTotal');
  if (el) el.textContent = `Итого: $${usd.toFixed(2)} / ${byn.toFixed(2)} BYN`;
}

async function saveOrderDraft() {
  if (!orderDraft) return;
  const items = orderDraft.items
    .filter(it => it.product_id)
    .map(it => {
      const p = productsById[it.product_id];
      return {
        product_id: it.product_id,
        size: it.size || '',
        qty: it.qty || 1,
        price_usd: p ? p.price_usd : 0,
        price_byn: p ? p.price_byn : 0,
      };
    });
  if (!items.length) { setDetailMsg('Добавьте хотя бы одну позицию с товаром', true); return; }

  const btn = document.getElementById('saveOrder');
  btn.disabled = true;
  setDetailMsg('Создаём заказ…');
  try {
    const inq = orderDraft.inquiry;
    const order = await api.createOrder(inq.customer_tg_id, items, 'USD', inq.id);
    // Закрываем обращение БЕЗ отбивки (диалог продолжается в заказе)
    await api.setInquiryStatus(inq.id, 'closed', null, inq.customer_tg_id, managerUsername);
    inq.status = 'closed';
    // Уведомляем клиента о созданном заказе (через outbox с привязкой к заказу)
    const notice = `Мы оформили для вас заказ №${order.id} 🎉 Дальше будем держать вас в курсе по его статусу.`;
    await api.sendReply(inq.customer_tg_id, notice, managerUsername, { order_id: order.id });
    setDetailMsg('Заказ №' + order.id + ' создан ✓');
    orderDraft = null;
    // Обновляем списки и открываем созданный заказ
    await loadOrdersSection();
    activeTab = 'orders';
    openDetail(String(order.id));
  } catch (e) {
    console.error(e);
    setDetailMsg('Ошибка создания заказа', true);
    btn.disabled = false;
  }
}

// Сводка при входе: сколько незакрытых обращений/заказов ждут.
export function announcePendingOnLogin() {
  const activeOrders = orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;
  const activeInq = inquiries.filter(q => q.status !== 'closed').length;
  const total = activeOrders + activeInq;
  if (total > 0) {
    showToast(`Ждут внимания: ${activeOrders} заказов, ${activeInq} обращений`);
    playBeep();
  }
}

// ============ СОЗДАНИЕ ЗАКАЗА С НУЛЯ (без обращения) ============

function startBlankOrder() {
  activeId = null;
  activeTab = 'orders';
  renderOrdersList();
  document.getElementById('orderDetailEmpty').style.display = 'none';
  const box = document.getElementById('orderDetail');
  box.style.display = 'flex';
  document.body.classList.add('mobile-detail');
  orderDraft = { inquiry: null, items: [{ product_id: '', size: '', qty: 1 }], blankCustomer: '' };

  box.innerHTML = `
    <button class="mobile-back" id="mobileBack"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>К списку</button>
    <div class="detail-head"><h2>Новый заказ</h2></div>
    <div class="detail-section">
      <label class="blank-cust-label">Telegram ID клиента
        <input type="text" id="blankCustomerId" placeholder="например 123456789" inputmode="numeric">
      </label>
      <div class="field-hint">ID можно увидеть в карточке клиента или в сообщениях бота. Клиент должен был хотя бы раз написать боту.</div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Состав заказа</div>
      <div class="order-form" id="orderForm" style="display:block">
        <div id="orderItems"></div>
        <button class="btn-light" id="addOrderItem">+ Добавить позицию</button>
        <button class="btn-light" id="addNewProductBtn">🆕 Нет в каталоге — создать товар</button>
        <div class="order-form-total" id="orderFormTotal"></div>
        <div class="order-form-actions">
          <button class="btn-primary" id="saveBlankOrder">Создать заказ</button>
        </div>
      </div>
    </div>
    <div class="detail-status-msg" id="detailStatusMsg"></div>
  `;

  document.getElementById('mobileBack').onclick = backToList;
  document.getElementById('blankCustomerId').oninput = (e) => { orderDraft.blankCustomer = e.target.value.trim(); };
  document.getElementById('addOrderItem').onclick = () => { orderDraft.items.push({ product_id:'', size:'', qty:1 }); renderOrderForm(); };
  document.getElementById('addNewProductBtn').onclick = openQuickProductModal;
  document.getElementById('saveBlankOrder').onclick = saveBlankOrder;
  renderOrderForm();
}

async function saveBlankOrder() {
  if (!orderDraft) return;
  const cid = parseInt(orderDraft.blankCustomer);
  if (!cid) { setDetailMsg('Укажите корректный Telegram ID клиента', true); return; }
  const items = orderDraft.items.filter(it => it.product_id).map(it => {
    const p = productsById[it.product_id];
    return { product_id: it.product_id, size: it.size || '', qty: it.qty || 1,
             price_usd: p ? p.price_usd : 0, price_byn: p ? p.price_byn : 0 };
  });
  if (!items.length) { setDetailMsg('Добавьте хотя бы одну позицию', true); return; }

  const btn = document.getElementById('saveBlankOrder');
  btn.disabled = true;
  setDetailMsg('Создаём заказ…');
  try {
    // Заказ напрямую на клиента, статус in_progress (создан менеджером)
    const order = await api.createOrder(cid, items, 'USD', null, 'in_progress');
    const notice = `Мы оформили для вас заказ №${order.id} 🎉 Будем держать вас в курсе по статусу.`;
    await api.sendReply(cid, notice, managerUsername, { order_id: order.id });
    setDetailMsg('Заказ №' + order.id + ' создан ✓');
    orderDraft = null;
    await loadOrdersSection();
    activeTab = 'orders';
    openDetail(String(order.id));
  } catch (e) {
    console.error(e);
    setDetailMsg('Ошибка создания заказа', true);
    btn.disabled = false;
  }
}

// ============ БЫСТРОЕ СОЗДАНИЕ ТОВАРА ИЗ КАРТОЧКИ (#6) ============

function openQuickProductModal() {
  // Снимаем старую модалку, если есть
  const old = document.getElementById('quickProdModal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'quickProdModal';
  modal.className = 'qp-modal';
  modal.innerHTML = `
    <div class="qp-card">
      <div class="qp-head">Новый товар в каталог</div>
      <label class="qp-label">Название (рус)<input type="text" id="qpNameRu"></label>
      <label class="qp-label">Название (eng)<input type="text" id="qpNameEn"></label>
      <div class="qp-row">
        <label class="qp-label">Цена USD<input type="number" id="qpPriceUsd" value="0"></label>
        <label class="qp-label">Цена BYN<input type="number" id="qpPriceByn" value="0"></label>
      </div>
      <label class="qp-label">Размеры через запятую (если есть)<input type="text" id="qpSizes" placeholder="напр. S, M, L или 40, 41"></label>
      <label class="qp-label">Фото (ссылка, опционально)<input type="text" id="qpImage" placeholder="https://..."></label>
      <div class="qp-upload-row">
        <label class="btn-light qp-upload-label">
          ⬆ Загрузить фото с устройства
          <input type="file" id="qpUpload" accept="image/*" multiple style="display:none">
        </label>
        <span class="qp-upload-status" id="qpUploadStatus"></span>
      </div>
      <div class="qp-thumbs" id="qpThumbs"></div>
      <div class="qp-actions">
        <button class="btn-primary" id="qpSave">Создать товар</button>
        <button class="btn-light" id="qpCancel">Отмена</button>
      </div>
      <div class="qp-status" id="qpStatus"></div>
    </div>`;
  document.body.appendChild(modal);

  // Загруженные через Storage картинки накапливаем здесь
  const uploadedImages = [];

  function renderQpThumbs() {
    const wrap = document.getElementById('qpThumbs');
    wrap.innerHTML = uploadedImages.map((u, i) =>
      `<div class="qp-thumb"><img src="${escapeHtml(u)}" alt=""><button class="qp-thumb-del" data-i="${i}">✕</button></div>`
    ).join('');
    wrap.querySelectorAll('.qp-thumb-del').forEach(b => {
      b.onclick = () => { uploadedImages.splice(+b.dataset.i, 1); renderQpThumbs(); };
    });
  }

  const uploadInput = document.getElementById('qpUpload');
  uploadInput.addEventListener('change', async () => {
    const files = Array.from(uploadInput.files || []);
    if (!files.length) return;
    const st = document.getElementById('qpUploadStatus');
    let done = 0;
    for (const f of files) {
      st.textContent = `Загрузка ${done + 1}/${files.length}…`;
      try {
        const url = await api.uploadFile(f);
        uploadedImages.push(url);
        done++;
        renderQpThumbs();
      } catch (e) {
        console.error(e);
        st.textContent = '⚠️ Ошибка загрузки';
        uploadInput.value = '';
        return;
      }
    }
    st.textContent = `Загружено: ${done} ✓`;
    uploadInput.value = '';
  });

  document.getElementById('qpCancel').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('qpSave').onclick = async () => {
    const nameRu = document.getElementById('qpNameRu').value.trim();
    const nameEn = document.getElementById('qpNameEn').value.trim();
    if (!nameRu && !nameEn) { qpSetStatus('Укажите название', true); return; }
    const sizesRaw = document.getElementById('qpSizes').value.trim();
    const sizes = sizesRaw ? sizesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const stock = {};
    sizes.forEach(s => { stock[s] = 99; });   // условный остаток, можно поправить в каталоге
    const img = document.getElementById('qpImage').value.trim();
    // Картинки: загруженные файлы + ссылка (если указана)
    const images = [...uploadedImages];
    if (img) images.push(img);
    const product = {
      id: makeId('p'),
      name_ru: nameRu, name_en: nameEn || nameRu,
      desc_ru: '', desc_en: '',
      price_usd: Number(document.getElementById('qpPriceUsd').value) || 0,
      price_byn: Number(document.getElementById('qpPriceByn').value) || 0,
      images,
      sizes, stock,
      is_active: true, badge_text: '', badge_color: 'accent',
    };
    const btn = document.getElementById('qpSave');
    btn.disabled = true;
    qpSetStatus('Создаём…');
    try {
      await api.saveProduct(product);
      // Добавляем в локальный каталог, чтобы сразу выбрать в форме
      productsById[product.id] = product;
      // Подставляем новый товар в первую пустую позицию черновика
      if (orderDraft && orderDraft.items) {
        const empty = orderDraft.items.find(it => !it.product_id);
        if (empty) empty.product_id = product.id;
        else orderDraft.items.push({ product_id: product.id, size: '', qty: 1 });
        renderOrderForm();
      }
      modal.remove();
    } catch (e) {
      console.error(e);
      qpSetStatus('Ошибка создания', true);
      btn.disabled = false;
    }
  };
}

function qpSetStatus(text, isError) {
  const el = document.getElementById('qpStatus');
  if (el) { el.textContent = text; el.className = 'qp-status' + (isError ? ' error' : ''); }
}

// ============ ШАБЛОНЫ ОТВЕТОВ С ПЕРЕМЕННЫМИ (#8) ============
// Хранятся локально. Поддерживают {имя}, {номер}, {сумма} — подставляются
// из текущего открытого заказа/обращения при вставке.

const TEMPLATES_KEY = 'lizard_reply_templates';
const DEFAULT_TEMPLATES = [
  { title: 'Приветствие', text: 'Здравствуйте, {имя}! 🙌 Уже смотрю ваш заказ №{номер}.' },
  { title: 'Подтверждение наличия', text: 'Хорошие новости — товар есть в наличии ✅ Сумма к оплате: {сумма}. Готовы оформить?' },
  { title: 'Напоминание об оплате', text: 'Напоминаю про оплату заказа №{номер} на сумму {сумма} 🙏 Как будете готовы — пришлите чек.' },
  { title: 'Заказ в пути', text: 'Ваш заказ №{номер} уже в пути 🚚 Дорога занимает 3–4 недели, держим вас в курсе.' },
  { title: 'Приехал, готов к выдаче', text: '{имя}, ваш заказ приехал! 🎁 Когда вам удобно забрать?' },
];

function getTemplates() {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_TEMPLATES.slice();
  } catch (_) { return DEFAULT_TEMPLATES.slice(); }
}
function saveTemplates(list) {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list)); } catch (_) {}
}

// Подставляет переменные шаблона из текущего контекста.
function fillTemplate(text) {
  let name = 'клиент', num = '', sum = '';
  // Текущий открытый заказ/обращение
  if (convoContext && convoContext.order_id != null) {
    const o = orders.find(x => String(x.id) === String(convoContext.order_id));
    if (o) {
      num = o.id;
      sum = o.currency === 'BYN' ? `${o.total_byn} BYN` : `$${o.total_usd}`;
      const c = customersById[o.customer_tg_id];
      name = customerName(c, o.customer_tg_id);
    }
  } else if (convoContext && convoContext.inquiry_id != null) {
    const q = inquiries.find(x => String(x.id) === String(convoContext.inquiry_id));
    if (q) {
      num = q.number || '';
      const c = customersById[q.customer_tg_id];
      name = customerName(c, q.customer_tg_id);
    }
  }
  return text.replace(/\{имя\}/g, name).replace(/\{номер\}/g, num).replace(/\{сумма\}/g, sum);
}

// Открывает панель выбора шаблона рядом с полем ответа (или модалку при отсутствии открытого чата).
export function openTemplatesPicker() {
  const input = document.getElementById('convoInput');
  if (!input) {
    // Нет открытого чата — просто открываем редактор шаблонов
    openTemplatesEditor();
    return;
  }
  const old = document.getElementById('tplPicker');
  if (old) { old.remove(); return; }
  const list = getTemplates();
  const picker = document.createElement('div');
  picker.id = 'tplPicker';
  picker.className = 'tpl-picker';
  picker.innerHTML = list.map((t, i) =>
    `<button class="tpl-item" data-i="${i}"><b>${escapeHtml(t.title)}</b><span>${escapeHtml(t.text)}</span></button>`
  ).join('') + `<button class="tpl-edit" id="tplEditBtn">✏️ Редактировать шаблоны</button>`;
  const composer = document.getElementById('convoComposer');
  (composer || input.parentElement).appendChild(picker);
  picker.querySelectorAll('.tpl-item').forEach(btn => {
    btn.onclick = () => {
      const t = list[+btn.dataset.i];
      input.value = fillTemplate(t.text);
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
      input.focus();
      picker.remove();
    };
  });
  document.getElementById('tplEditBtn').onclick = () => { picker.remove(); openTemplatesEditor(); };
}

// Редактор списка шаблонов.
export function openTemplatesEditor() {
  const old = document.getElementById('tplModal');
  if (old) old.remove();
  const list = getTemplates();
  const modal = document.createElement('div');
  modal.id = 'tplModal';
  modal.className = 'qp-modal';
  modal.innerHTML = `
    <div class="qp-card">
      <div class="qp-head">Шаблоны ответов</div>
      <p class="req-hint">Доступные переменные: {имя}, {номер}, {сумма} — подставляются автоматически при вставке в чат.</p>
      <div id="tplList"></div>
      <button class="btn-light" id="tplAdd">+ Добавить шаблон</button>
      <div class="qp-actions">
        <button class="btn-primary" id="tplSave">Сохранить</button>
        <button class="btn-light" id="tplCancel">Отмена</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  let draft = list.map(t => ({ ...t }));
  function renderTpls() {
    const box = document.getElementById('tplList');
    box.innerHTML = draft.map((t, i) => `
      <div class="tpl-edit-row">
        <input class="tpl-title" data-i="${i}" value="${escapeHtml(t.title)}" placeholder="Название">
        <textarea class="tpl-text" data-i="${i}" rows="2" placeholder="Текст с {имя}, {номер}, {сумма}">${escapeHtml(t.text)}</textarea>
        <button class="tpl-del" data-i="${i}">✕</button>
      </div>`).join('');
    box.querySelectorAll('.tpl-title').forEach(inp => inp.oninput = () => draft[+inp.dataset.i].title = inp.value);
    box.querySelectorAll('.tpl-text').forEach(inp => inp.oninput = () => draft[+inp.dataset.i].text = inp.value);
    box.querySelectorAll('.tpl-del').forEach(b => b.onclick = () => { draft.splice(+b.dataset.i, 1); renderTpls(); });
  }
  renderTpls();
  document.getElementById('tplAdd').onclick = () => { draft.push({ title: '', text: '' }); renderTpls(); };
  document.getElementById('tplCancel').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('tplSave').onclick = () => {
    saveTemplates(draft.filter(t => t.title.trim() || t.text.trim()));
    modal.remove();
  };
}

// Экспорт для кнопки реквизитов в подвале панели.
export function showRequisitesModal() { openRequisitesModal(); }
