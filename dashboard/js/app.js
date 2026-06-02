// Главная логика панели управления.
// Разделы: «Заказы» (с перепиской внутри карточек) и «Каталог».
import { CONFIG } from './config.js';
import * as api from './api.js';
import * as catalog from './catalog.js';
import * as orders from './orders.js';
import * as customers from './customers.js';
import * as analytics from './analytics.js';
import * as search from './search.js';

let currentManager = null;
let currentSection = 'orders';
let refreshTimer = null;

// ============ АВТОРИЗАЦИЯ ============

function loadAuth() {
  try {
    const raw = localStorage.getItem(CONFIG.AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveAuth(mgr) {
  try { localStorage.setItem(CONFIG.AUTH_KEY, JSON.stringify(mgr)); } catch {}
}
function clearAuth() {
  try { localStorage.removeItem(CONFIG.AUTH_KEY); } catch {}
}

async function attemptLogin(username) {
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = 'Проверяем…';
  try {
    const mgr = await api.checkManager(username);
    if (!mgr) {
      errEl.textContent = 'Этот пользователь не найден среди менеджеров.';
      btn.disabled = false;
      btn.textContent = 'Войти';
      return;
    }
    currentManager = mgr;
    saveAuth(mgr);
    showApp();
  } catch (e) {
    console.error(e);
    errEl.textContent = 'Ошибка соединения. Попробуйте ещё раз.';
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

function logout() {
  clearAuth();
  currentManager = null;
  if (refreshTimer) clearInterval(refreshTimer);
  orders.stopConvo();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  document.getElementById('loginUsername').value = '';
  const btn = document.getElementById('loginBtn');
  btn.disabled = false;
  btn.textContent = 'Войти';
}

// ============ ПРИЛОЖЕНИЕ ============

function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('managerName').textContent = '@' + currentManager.username
    + (currentManager.is_superadmin ? ' · админ' : '');
  catalog.setupCatalog();
  orders.initOrders(currentManager.username);
  setupSectionTabs();
  setupDutyToggle();
  currentSection = 'orders';
  // Явно выставляем видимость стартового раздела (на случай повторного входа)
  document.getElementById('ordersSide').style.display = '';
  document.getElementById('catalogSide').style.display = 'none';
  document.getElementById('sectionOrders').style.display = '';
  document.getElementById('sectionCatalog').style.display = 'none';
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.getAttribute('data-section') === 'orders'));
  orders.loadOrdersSection().then(() => {
    orders.announcePendingOnLogin();
  });
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (currentSection === 'orders') orders.refreshList();
  }, CONFIG.REFRESH_INTERVAL);
}

function setupSectionTabs() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.onclick = () => switchSection(tab.getAttribute('data-section'));
  });
}

function switchSection(section) {
  if (section === currentSection) return;
  currentSection = section;
  // При смене раздела всегда показываем список (снимаем мобильный режим деталей)
  document.body.classList.remove('mobile-detail');
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.getAttribute('data-section') === section));

  document.getElementById('ordersSide').style.display = section === 'orders' ? '' : 'none';
  document.getElementById('catalogSide').style.display = section === 'catalog' ? '' : 'none';
  document.getElementById('sectionOrders').style.display = section === 'orders' ? '' : 'none';
  document.getElementById('sectionCatalog').style.display = section === 'catalog' ? '' : 'none';
  const secCust = document.getElementById('sectionCustomers');
  if (secCust) secCust.style.display = section === 'customers' ? '' : 'none';
  const secAn = document.getElementById('sectionAnalytics');
  if (secAn) secAn.style.display = section === 'analytics' ? '' : 'none';
  // Сайдбар скрываем на полноэкранных разделах
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.classList.toggle('compact', section === 'customers' || section === 'analytics');

  if (section === 'orders') orders.loadOrdersSection();
  if (section === 'catalog') { orders.stopConvo(); catalog.loadCatalog(); }
  if (section === 'customers') { orders.stopConvo(); customers.loadCustomersSection(); }
  if (section === 'analytics') { orders.stopConvo(); analytics.loadAnalyticsSection(); }
}

// ============ ИНИЦИАЛИЗАЦИЯ ============

function init() {
  document.getElementById('loginBtn').onclick = () => {
    attemptLogin(document.getElementById('loginUsername').value);
  };
  document.getElementById('loginUsername').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin(e.target.value);
  });
  document.getElementById('logoutBtn').onclick = logout;
  const reqBtn = document.getElementById('requisitesBtn');
  if (reqBtn) reqBtn.onclick = () => orders.showRequisitesModal();
  const tplBtn = document.getElementById('templatesBtn');
  if (tplBtn) tplBtn.onclick = () => orders.openTemplatesEditor();
  const auditBtn = document.getElementById('auditBtn');
  if (auditBtn) auditBtn.onclick = () => orders.openAuditLog();
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.onclick = toggleTheme;
  applyTheme(localStorage.getItem('lizard_theme') || 'light');
  const searchBtn = document.getElementById('globalSearchBtn');
  if (searchBtn) searchBtn.onclick = () => search.openGlobalSearch();
  search.installGlobalSearchHotkey();

  // Переход «Клиенты → конкретный заказ/обращение» через события из customers.js
  window.addEventListener('switch-section', (e) => switchSection(e.detail.section));
  window.addEventListener('open-item', (e) => {
    const { tab, id } = e.detail;
    orders.openItemFromOutside(tab, id);
  });
  window.addEventListener('open-customer-profile', (e) => {
    customers.openCustomerProfile(e.detail.tg);
  });

  const saved = loadAuth();
  if (saved && saved.username) {
    currentManager = saved;
    showApp();
  } else {
    document.getElementById('login').style.display = 'flex';
  }
}

init();

// ============ ТЁМНАЯ ТЕМА (#15) ============

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('lizard_theme', theme);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ============ ДЕЖУРСТВО ============
// Переключатель «получать уведомления в Telegram-боте». Хранится в managers.is_on_duty,
// откуда бот фильтрует кому слать notify_managers_brief.

async function setupDutyToggle() {
  const btn = document.getElementById('dutyBtn');
  if (!btn) return;
  if (!currentManager) return;
  const status = await api.loadMyDutyStatus(currentManager.username).catch(() => null);
  applyDutyView(btn, status);
  btn.onclick = async () => {
    if (status && status.is_superadmin) {
      alert('Суперадмин всегда получает уведомления — отдельно включать дежурство не нужно.');
      return;
    }
    btn.disabled = true;
    const desired = !(status && status.is_on_duty);
    try {
      const updated = await api.setMyDutyStatus(currentManager.username, desired);
      if (status) status.is_on_duty = updated;
      applyDutyView(btn, status);
    } catch (e) {
      console.error(e);
      alert('Не удалось переключить дежурство: ' + (e.message || ''));
    } finally {
      btn.disabled = false;
    }
  };
}

function applyDutyView(btn, status) {
  // Суперадмин: всегда «онлайн», кнопка информационная
  if (status && status.is_superadmin) {
    btn.textContent = '🟢 На дежурстве (суперадмин)';
    btn.classList.add('duty-on');
    btn.classList.remove('duty-off', 'duty-warn');
    return;
  }
  // Менеджер не нашёлся в БД (странно, но возможно)
  if (!status) {
    btn.textContent = '⚠️ Дежурство недоступно';
    btn.classList.add('duty-warn');
    btn.classList.remove('duty-on', 'duty-off');
    return;
  }
  // Менеджер без chat_id — уведомления физически не дойдут, надо написать боту /start
  if (!status.chat_id) {
    btn.textContent = '⚠️ Напишите /start боту в Telegram';
    btn.title = 'Чтобы получать уведомления, один раз отправьте /start боту в Telegram, потом обновите страницу';
    btn.classList.add('duty-warn');
    btn.classList.remove('duty-on', 'duty-off');
    return;
  }
  if (status.is_on_duty) {
    btn.textContent = '🟢 На дежурстве';
    btn.title = 'Уведомления в Telegram включены. Клик — снять с дежурства.';
    btn.classList.add('duty-on');
    btn.classList.remove('duty-off', 'duty-warn');
  } else {
    btn.textContent = '⚪ Не на дежурстве';
    btn.title = 'Уведомления в Telegram отключены. Клик — встать на дежурство.';
    btn.classList.add('duty-off');
    btn.classList.remove('duty-on', 'duty-warn');
  }
}
