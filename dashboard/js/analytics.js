// Раздел «Аналитика» — простые метрики для понимания, как идут дела.
// Никакой БД-нагрузки: считаем по уже загружаемым orders/inquiries/customers.

import * as api from './api.js';
import { escapeHtml, formatFullDate, exportToCsv } from './utils.js';

let allOrders = [];
let allInquiries = [];
let allCustomers = [];
let periodDays = 30;     // 7 | 30 | 90 | 365

export async function loadAnalyticsSection() {
  const sec = document.getElementById('sectionAnalytics');
  if (!sec) return;
  sec.innerHTML = '<div class="cust-loading">Считаем метрики…</div>';
  try {
    const [orders, inquiries, customers] = await Promise.all([
      api.loadOrders().catch(() => []),
      api.loadInquiries().catch(() => []),
      api.loadAllCustomers().catch(() => []),
    ]);
    allOrders = orders || [];
    allInquiries = inquiries || [];
    allCustomers = customers || [];
  } catch (e) {
    console.error(e);
    sec.innerHTML = '<div class="cust-loading">Не удалось загрузить данные</div>';
    return;
  }
  renderAnalytics();
}

function renderAnalytics() {
  const sec = document.getElementById('sectionAnalytics');
  const cutoff = Date.now() - periodDays * 24 * 60 * 60 * 1000;
  const ordersInPeriod = allOrders.filter(o => new Date(o.created_at).getTime() >= cutoff);
  const completedInPeriod = ordersInPeriod.filter(o => o.status === 'completed');
  const cancelledInPeriod = ordersInPeriod.filter(o => o.status === 'cancelled');
  const inquiriesInPeriod = allInquiries.filter(q => new Date(q.created_at).getTime() >= cutoff);
  const newCustomersInPeriod = allCustomers.filter(c => c.created_at && new Date(c.created_at).getTime() >= cutoff);

  const totalRevenue = completedInPeriod.reduce((s, o) => s + (Number(o.total_usd) || 0), 0);
  const inProgressRevenue = allOrders
    .filter(o => o.status !== 'completed' && o.status !== 'cancelled' && !o.is_paid)
    .reduce((s, o) => s + (Number(o.total_usd) || 0), 0);
  const avgCheck = completedInPeriod.length ? (totalRevenue / completedInPeriod.length) : 0;
  // Конверсия обращение → заказ: для обращений в периоде, у которых есть заказ от того же клиента
  // с created_at >= created_at обращения. Грубая, но рабочая метрика.
  const conversion = inquiriesInPeriod.length
    ? (inquiriesInPeriod.filter(q => allOrders.some(o => o.customer_tg_id === q.customer_tg_id && new Date(o.created_at) >= new Date(q.created_at))).length / inquiriesInPeriod.length * 100)
    : 0;
  // Среднее время на каждом этапе — по status_history (приближённо: возраст в текущем статусе для каждого статуса)
  const stageStats = computeStageStats(ordersInPeriod);

  sec.innerHTML = `
    <div class="an-header">
      <h2>Аналитика</h2>
      <div class="an-controls">
        <label>Период:
          <select id="anPeriod">
            <option value="7"  ${periodDays === 7   ? 'selected' : ''}>7 дней</option>
            <option value="30" ${periodDays === 30  ? 'selected' : ''}>30 дней</option>
            <option value="90" ${periodDays === 90  ? 'selected' : ''}>90 дней</option>
            <option value="365" ${periodDays === 365 ? 'selected' : ''}>Год</option>
          </select>
        </label>
      </div>
    </div>

    <div class="an-tiles">
      <div class="an-tile">
        <div class="an-tile-label">Новых заказов</div>
        <div class="an-tile-value">${ordersInPeriod.length}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Завершённых</div>
        <div class="an-tile-value">${completedInPeriod.length}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Отменённых</div>
        <div class="an-tile-value">${cancelledInPeriod.length}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Выручка (выкуплено)</div>
        <div class="an-tile-value">$${totalRevenue.toFixed(0)}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Средний чек</div>
        <div class="an-tile-value">$${avgCheck.toFixed(0)}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Сейчас в работе (неоплачено)</div>
        <div class="an-tile-value">$${inProgressRevenue.toFixed(0)}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Новых клиентов</div>
        <div class="an-tile-value">${newCustomersInPeriod.length}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Обращений</div>
        <div class="an-tile-value">${inquiriesInPeriod.length}</div>
      </div>
      <div class="an-tile">
        <div class="an-tile-label">Конверсия обр.→заказ</div>
        <div class="an-tile-value">${conversion.toFixed(0)}%</div>
      </div>
    </div>

    <div class="an-row">
      <div class="an-block">
        <div class="an-block-title">Заказы по дням</div>
        <div class="an-chart" id="anChart">${renderDailyChart(ordersInPeriod)}</div>
      </div>
      <div class="an-block">
        <div class="an-block-title">Среднее время на этапе</div>
        <div class="an-stages">${renderStageStats(stageStats)}</div>
      </div>
    </div>

    <div class="an-block">
      <div class="an-block-title">Топ-товары (по числу заказанных позиций)</div>
      <div class="an-toptable" id="anTopProducts">${renderTopProducts(ordersInPeriod)}</div>
    </div>
  `;

  document.getElementById('anPeriod').onchange = (e) => {
    periodDays = Number(e.target.value);
    renderAnalytics();
  };
}

function renderDailyChart(orders) {
  // Группируем по дням за весь период
  const days = [];
  for (let i = periodDays - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    days.push({ key: d.toISOString().slice(0, 10), label: `${d.getDate()}.${(d.getMonth()+1).toString().padStart(2,'0')}`, count: 0 });
  }
  const byKey = Object.fromEntries(days.map(d => [d.key, d]));
  orders.forEach(o => {
    const key = (o.created_at || '').slice(0, 10);
    if (byKey[key]) byKey[key].count++;
  });
  const max = Math.max(1, ...days.map(d => d.count));
  // Показываем подписи через каждые N дней, чтобы не сливались
  const labelEvery = periodDays > 60 ? 7 : (periodDays > 14 ? 3 : 1);
  return `<div class="an-bars">
    ${days.map((d, i) => `
      <div class="an-bar-col" title="${escapeHtml(d.label)}: ${d.count}">
        <div class="an-bar" style="height:${(d.count / max * 100).toFixed(1)}%">${d.count > 0 ? `<span class="an-bar-num">${d.count}</span>` : ''}</div>
        ${(i % labelEvery === 0 || i === days.length - 1) ? `<div class="an-bar-label">${escapeHtml(d.label)}</div>` : '<div class="an-bar-label">&nbsp;</div>'}
      </div>
    `).join('')}
  </div>`;
}

function computeStageStats(orders) {
  // Для каждого статуса — собрать длительности пребывания.
  // Из доступных данных приближённо считаем по status_changed_at:
  // - completed: completed_at - created_at = «общее время до завершения»
  // - cancelled: аналогично
  // - текущие активные: status_changed_at — сколько уже сидит в нынешнем статусе
  // Эта метрика прикидочная (точная — через status_history), но даёт ориентир.
  const stats = {};
  orders.forEach(o => {
    if (!o.status_changed_at) return;
    const ageDays = (Date.now() - new Date(o.status_changed_at).getTime()) / 86400000;
    if (!stats[o.status]) stats[o.status] = { sum: 0, n: 0 };
    stats[o.status].sum += ageDays;
    stats[o.status].n++;
  });
  return stats;
}

function renderStageStats(stats) {
  const labels = {
    new: '🆕 Новый', in_progress: '✋ В работе', awaiting_payment: '💳 Ждёт оплаты',
    paid: '✅ Оплачен', purchasing: '🛒 Выкупаем', shipping: '🚚 В пути',
    ready: '📦 Готов', completed: '🎉 Выдан', cancelled: '❌ Отменён',
  };
  const entries = Object.entries(stats).filter(([k]) => labels[k]);
  if (!entries.length) return '<div class="sh-empty">Нет данных</div>';
  return entries.map(([k, v]) => {
    const avg = v.sum / v.n;
    const label = avg < 1 ? `${(avg * 24).toFixed(0)} ч` : `${avg.toFixed(1)} дн`;
    return `<div class="an-stage-row">
      <span class="an-stage-label">${labels[k]}</span>
      <span class="an-stage-count">${v.n} шт</span>
      <span class="an-stage-time">${label}</span>
    </div>`;
  }).join('');
}

function renderTopProducts(orders) {
  // Считаем по order_items
  const counts = new Map();
  orders.forEach(o => {
    (o.order_items || []).forEach(it => {
      if (!counts.has(it.product_id)) counts.set(it.product_id, { qty: 0, revenue: 0 });
      const c = counts.get(it.product_id);
      c.qty += it.qty || 1;
      c.revenue += (Number(it.price_usd_snapshot) || 0) * (it.qty || 1);
    });
  });
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1].qty - a[1].qty).slice(0, 10);
  if (!sorted.length) return '<div class="sh-empty">Нет данных за период</div>';
  return `<table class="an-table">
    <thead><tr><th>Товар</th><th>Шт</th><th>Сумма $</th></tr></thead>
    <tbody>${sorted.map(([id, v]) => `
      <tr><td>${escapeHtml(id)}</td><td>${v.qty}</td><td>$${v.revenue.toFixed(0)}</td></tr>
    `).join('')}</tbody>
  </table>`;
}
