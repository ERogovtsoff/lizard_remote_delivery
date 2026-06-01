// Глобальный поиск (#2): ищет везде — заказы, обращения, клиенты, товары.
// Открывается по Ctrl+K (Cmd+K) или клику на 🔍 в шапке.

import * as api from './api.js';
import { escapeHtml, customerName } from './utils.js';

let cache = null;       // { orders, inquiries, customers, products }
let cacheTime = 0;

async function ensureCache() {
  // Кэшируем на 30 секунд, чтобы по каждому символу не дёргать БД
  if (cache && (Date.now() - cacheTime < 30000)) return cache;
  const [orders, inquiries, customers, products] = await Promise.all([
    api.loadOrders().catch(() => []),
    api.loadInquiries().catch(() => []),
    api.loadAllCustomers().catch(() => []),
    api.loadProducts(true).catch(() => []),
  ]);
  cache = { orders, inquiries, customers, products };
  cacheTime = Date.now();
  return cache;
}

export function invalidateSearchCache() {
  cache = null; cacheTime = 0;
}

export function openGlobalSearch() {
  const old = document.getElementById('searchModal');
  if (old) { old.remove(); return; }
  const modal = document.createElement('div');
  modal.id = 'searchModal';
  modal.className = 'search-modal';
  modal.innerHTML = `
    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Поиск: заказ №, имя, ID, username, товар, трек…" autocomplete="off">
      <button class="search-close" id="searchClose">✕</button>
      <div class="search-results" id="searchResults">
        <div class="search-hint">Начните вводить запрос. Поиск идёт по заказам, обращениям, клиентам и товарам.</div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const input = document.getElementById('searchInput');
  setTimeout(() => input.focus(), 50);

  const close = () => modal.remove();
  document.getElementById('searchClose').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  let activeIdx = -1;
  let currentResults = [];

  function render(q) {
    const box = document.getElementById('searchResults');
    if (!q || q.length < 1) { box.innerHTML = '<div class="search-hint">Начните вводить запрос…</div>'; currentResults = []; return; }
    if (!cache) { box.innerHTML = '<div class="search-hint">Загрузка данных…</div>'; return; }
    const ql = q.toLowerCase();
    const r = [];

    // Заказы
    for (const o of cache.orders) {
      const c = cache.customers.find(x => x.tg_id === o.customer_tg_id);
      const name = c ? customerName(c, o.customer_tg_id) : String(o.customer_tg_id);
      const track = (o.tracking_number || '').toLowerCase();
      if (String(o.id).includes(ql) || name.toLowerCase().includes(ql) || track.includes(ql) || String(o.customer_tg_id).includes(ql)) {
        r.push({ kind: 'order', id: o.id, label: `Заказ №${o.id}`, sub: `${name} · $${o.total_usd} · ${o.status}`, openTab: 'orders' });
      }
      if (r.length >= 50) break;
    }
    // Обращения
    for (const q2 of cache.inquiries) {
      const c = cache.customers.find(x => x.tg_id === q2.customer_tg_id);
      const name = c ? customerName(c, q2.customer_tg_id) : String(q2.customer_tg_id);
      if (String(q2.number || '').includes(ql) || name.toLowerCase().includes(ql) || String(q2.customer_tg_id).includes(ql)) {
        r.push({ kind: 'inquiry', id: q2.id, label: `Обращение №${q2.number || ''}`, sub: `${name} · ${q2.type === 'product_question' ? 'вопрос' : 'подбор'}`, openTab: 'inquiries' });
      }
      if (r.length >= 100) break;
    }
    // Клиенты
    for (const c of cache.customers) {
      const name = customerName(c, c.tg_id);
      const uname = (c.username || '').toLowerCase();
      if (name.toLowerCase().includes(ql) || uname.includes(ql) || String(c.tg_id).includes(ql)) {
        r.push({ kind: 'customer', id: c.tg_id, label: `👤 ${name}`, sub: c.username ? `@${c.username} · ${c.tg_id}` : String(c.tg_id) });
      }
      if (r.length >= 150) break;
    }
    // Товары
    for (const p of cache.products) {
      const n = (p.name_ru || p.name_en || '').toLowerCase();
      if (n.includes(ql) || (p.id || '').toLowerCase().includes(ql)) {
        r.push({ kind: 'product', id: p.id, label: `📦 ${p.name_ru || p.name_en || p.id}`, sub: `$${p.price_usd} · ${p.id}` });
      }
      if (r.length >= 200) break;
    }

    currentResults = r;
    activeIdx = r.length ? 0 : -1;
    if (!r.length) { box.innerHTML = '<div class="search-hint">Ничего не найдено</div>'; return; }

    box.innerHTML = r.map((it, i) => `
      <div class="search-item ${i === activeIdx ? 'active' : ''}" data-i="${i}">
        <div class="search-item-label">${escapeHtml(it.label)}</div>
        <div class="search-item-sub">${escapeHtml(it.sub)}</div>
      </div>
    `).join('');

    box.querySelectorAll('.search-item').forEach(el => {
      el.onclick = () => pick(Number(el.getAttribute('data-i')));
    });
  }

  function pick(i) {
    const it = currentResults[i];
    if (!it) return;
    close();
    if (it.kind === 'order') {
      window.dispatchEvent(new CustomEvent('switch-section', { detail: { section: 'orders' } }));
      setTimeout(() => window.dispatchEvent(new CustomEvent('open-item', { detail: { tab: 'orders', id: String(it.id) } })), 50);
    } else if (it.kind === 'inquiry') {
      window.dispatchEvent(new CustomEvent('switch-section', { detail: { section: 'orders' } }));
      setTimeout(() => window.dispatchEvent(new CustomEvent('open-item', { detail: { tab: 'inquiries', id: String(it.id) } })), 50);
    } else if (it.kind === 'customer') {
      window.dispatchEvent(new CustomEvent('open-customer-profile', { detail: { tg: it.id } }));
    } else if (it.kind === 'product') {
      // Открываем раздел Каталог и подсвечиваем товар
      window.dispatchEvent(new CustomEvent('switch-section', { detail: { section: 'catalog' } }));
    }
  }

  let debounceT = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => render(input.value.trim()), 100);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (!currentResults.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % currentResults.length;
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + currentResults.length) % currentResults.length;
      updateActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(activeIdx);
    }
  });

  function updateActive() {
    const items = document.querySelectorAll('.search-item');
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    const cur = items[activeIdx];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  // Загрузка кэша асинхронно — пока пользователь думает
  ensureCache().then(() => { if (document.getElementById('searchModal')) render(input.value.trim()); });
}

// Горячая клавиша Ctrl+K / Cmd+K
export function installGlobalSearchHotkey() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openGlobalSearch();
    }
  });
}
