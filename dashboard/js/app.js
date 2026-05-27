// Главная логика панели управления.
// Разделы: «Заказы» (с перепиской внутри карточек) и «Каталог».
import { CONFIG } from './config.js';
import * as api from './api.js';
import * as catalog from './catalog.js';
import * as orders from './orders.js';

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

  if (section === 'orders') orders.loadOrdersSection();
  if (section === 'catalog') { orders.stopConvo(); catalog.loadCatalog(); }
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

  const saved = loadAuth();
  if (saved && saved.username) {
    currentManager = saved;
    showApp();
  } else {
    document.getElementById('login').style.display = 'flex';
  }
}

init();
