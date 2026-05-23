// Раздел «Заказы» в панели: заказы и обращения, перемещение по статусам.
// Смена статуса пишет в БД и (через outbox) уведомляет клиента — бот доставит.
import * as api from './api.js';
import { escapeHtml, customerName, formatTime, formatFullDate } from './utils.js';

// Статусы заказов с подписью и текстом клиенту (синхронно с ботом).
const ORDER_STATUS = {
  new:              { label: '🆕 Новый',          client: null },
  in_progress:      { label: '✋ В работе',        client: 'Взяли ваш заказ в работу 🙌 Скоро вернёмся с деталями.' },
  awaiting_payment: { label: '💳 Ждёт оплаты',     client: 'Всё подтвердили! Пришлём реквизиты для оплаты — и сразу выкупаем.' },
  paid:             { label: '✅ Оплачен',         client: 'Оплату получили, спасибо! 🎉 Начинаем выкуп.' },
  purchasing:       { label: '🛒 Выкупаем',        client: 'Выкупаем ваш товар. Следующий шаг — отправка в Беларусь.' },
  shipping:         { label: '🚚 В пути',          client: 'Заказ уже едет к нам 🚚 Дорога обычно занимает 3–4 недели. Напишем сразу, как он приедет.' },
  ready:            { label: '📦 Готов к выдаче',  client: 'Ваш заказ приехал! 🎁 Договоримся, когда вам удобно примерить и забрать.' },
  completed:        { label: '🎉 Выдан',           client: 'Готово! Спасибо, что выбрали нас 💛 Будем рады видеть снова.' },
  cancelled:        { label: '❌ Отменён',         client: 'Заказ отменили. Если что-то пошло не так — напишите, всё поправим.' },
};
// Порядок статусов для «следующего шага»
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
  } catch (e) {
    console.error('loadOrdersSection failed:', e);
  }
  renderOrdersList();
}

function renderOrdersList() {
  const list = document.getElementById('ordersList');
  if (!list) return;

  const items = activeTab === 'orders' ? orders : inquiries;
  const countOrders = orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;
  const countInq = inquiries.filter(q => q.status !== 'closed').length;

  let html = `
    <div class="orders-tabs">
      <button class="orders-tab ${activeTab === 'orders' ? 'active' : ''}" data-tab="orders">
        Заказы${countOrders ? ` <span class="tab-badge">${countOrders}</span>` : ''}
      </button>
      <button class="orders-tab ${activeTab === 'inquiries' ? 'active' : ''}" data-tab="inquiries">
        Обращения${countInq ? ` <span class="tab-badge">${countInq}</span>` : ''}
      </button>
    </div>
    <div class="orders-items">`;

  if (!items.length) {
    html += `<div class="empty-hint">${activeTab === 'orders' ? 'Заказов пока нет' : 'Обращений пока нет'}</div>`;
  } else {
    html += items.map(it => {
      const cust = customersById[it.customer_tg_id];
      const name = customerName(cust, it.customer_tg_id);
      const active = String(it.id) === String(activeId) ? ' active' : '';
      if (activeTab === 'orders') {
        const st = ORDER_STATUS[it.status] || { label: it.status };
        const sumLabel = it.currency === 'BYN' ? `${it.total_byn} BYN` : `$${it.total_usd}`;
        return `<div class="order-row${active}" data-id="${it.id}">
          <div class="order-row-top">
            <span class="order-row-id">Заказ №${it.id}</span>
            <span class="order-row-sum">${escapeHtml(sumLabel)}</span>
          </div>
          <div class="order-row-name">${escapeHtml(name)}</div>
          <div class="order-row-status">${escapeHtml(st.label)}</div>
        </div>`;
      } else {
        const st = INQUIRY_STATUS[it.status] || { label: it.status };
        const typeLabel = it.type === 'product_question' ? 'Вопрос о товаре' : 'Запрос на подбор';
        return `<div class="order-row${active}" data-id="${it.id}">
          <div class="order-row-top">
            <span class="order-row-id">Обращение №${it.number || ''}</span>
          </div>
          <div class="order-row-name">${escapeHtml(name)}</div>
          <div class="order-row-status">${escapeHtml(typeLabel)} · ${escapeHtml(st.label)}</div>
        </div>`;
      }
    }).join('');
  }
  html += `</div>`;
  list.innerHTML = html;

  list.querySelectorAll('.orders-tab').forEach(t => {
    t.onclick = () => { activeTab = t.getAttribute('data-tab'); activeId = null; renderOrdersList(); clearDetail(); };
  });
  list.querySelectorAll('.order-row').forEach(el => {
    el.onclick = () => openDetail(el.getAttribute('data-id'));
  });
}

function clearDetail() {
  document.getElementById('orderDetailEmpty').style.display = 'flex';
  document.getElementById('orderDetail').style.display = 'none';
}

function openDetail(id) {
  activeId = id;
  renderOrdersList();
  document.getElementById('orderDetailEmpty').style.display = 'none';
  const box = document.getElementById('orderDetail');
  box.style.display = 'block';

  if (activeTab === 'orders') renderOrderDetail(id);
  else renderInquiryDetail(id);
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
    return `<div class="detail-item">
      <span>${escapeHtml(pname)}${sz} × ${it.qty}</span>
      <span>$${it.price_usd_snapshot}</span>
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
    <div class="detail-head">
      <h2>Заказ №${o.id}</h2>
      <span class="detail-status-badge">${escapeHtml(st.label)}</span>
    </div>
    <div class="detail-meta">
      <div><b>Клиент:</b> ${escapeHtml(name)}</div>
      <div><b>ID:</b> ${o.customer_tg_id}</div>
      <div><b>Сумма:</b> $${o.total_usd} / ${o.total_byn} BYN</div>
      <div><b>Создан:</b> ${escapeHtml(formatFullDate(o.created_at))} ${escapeHtml(formatTime(o.created_at))}</div>
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Состав заказа</div>
      ${items}
    </div>

    <div class="detail-section">
      <div class="detail-section-title">Сменить статус</div>
      <div class="status-actions">${statusButtons}</div>
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
    <div class="detail-status-msg" id="detailStatusMsg"></div>
  `;

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
}

async function changeOrderStatus(order, status) {
  if (status === order.status) { setDetailMsg('Этот статус уже установлен'); return; }
  const notify = document.getElementById('orderNotify')?.checked;
  const clientMsg = (notify && ORDER_STATUS[status]) ? ORDER_STATUS[status].client : null;
  const fullMsg = clientMsg ? `${clientMsg}\n\nЗаказ №${order.id}` : null;
  setDetailMsg('Меняем статус…');
  try {
    await api.setOrderStatus(order.id, status, fullMsg, order.customer_tg_id, managerUsername);
    order.status = status;
    setDetailMsg('Статус обновлён ✓' + (fullMsg ? ' Клиент уведомлён.' : ''));
    renderOrdersList();
    renderOrderDetail(order.id);
  } catch (e) {
    console.error(e);
    setDetailMsg('Ошибка смены статуса', true);
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
    <div class="detail-head">
      <h2>Обращение №${q.number || ''}</h2>
      <span class="detail-status-badge">${escapeHtml(st.label)}</span>
    </div>
    <div class="detail-meta">
      <div><b>Клиент:</b> ${escapeHtml(name)}</div>
      <div><b>ID:</b> ${q.customer_tg_id}</div>
      <div><b>Тип:</b> ${escapeHtml(typeLabel)}</div>
      ${prodLine}
      <div><b>Создано:</b> ${escapeHtml(formatFullDate(q.created_at))} ${escapeHtml(formatTime(q.created_at))}</div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Сменить статус</div>
      <div class="status-actions">${statusButtons}</div>
      <label class="notify-check">
        <input type="checkbox" id="inqNotify" checked> Уведомить клиента в Telegram
      </label>
    </div>
    <div class="detail-hint">Чтобы ответить клиенту текстом — перейдите в раздел «Чаты».</div>
    <div class="detail-status-msg" id="detailStatusMsg"></div>
  `;

  box.querySelectorAll('[data-status]').forEach(btn => {
    btn.onclick = () => changeInquiryStatus(q, btn.getAttribute('data-status'));
  });
}

async function changeInquiryStatus(q, status) {
  const notify = document.getElementById('inqNotify')?.checked;
  const clientMsg = (notify && INQUIRY_STATUS[status]) ? INQUIRY_STATUS[status].client : null;
  setDetailMsg('Меняем статус…');
  try {
    await api.setInquiryStatus(q.id, status, clientMsg, q.customer_tg_id, managerUsername);
    q.status = status;
    setDetailMsg('Статус обновлён ✓' + (clientMsg ? ' Клиент уведомлён.' : ''));
    renderOrdersList();
    renderInquiryDetail(q.id);
  } catch (e) {
    console.error(e);
    setDetailMsg('Ошибка смены статуса', true);
  }
}

function setDetailMsg(text, isError) {
  const el = document.getElementById('detailStatusMsg');
  if (!el) return;
  el.textContent = text;
  el.className = 'detail-status-msg' + (isError ? ' error' : '');
}
