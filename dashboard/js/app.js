// Главная логика панели управления.
// Разделы: «Заказы» (с перепиской внутри карточек) и «Каталог».
import { CONFIG } from './config.js';
import * as api from './api.js';
import * as catalog from './catalog.js';
import * as orders from './orders.js';
import * as customers from './customers.js';
import * as analytics from './analytics.js';
import * as search from './search.js';
import * as health from './health.js';
import { openHelpModal, maybeShowOnboarding } from './help.js';
import { escapeHtml } from './utils.js';

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
  setupMobileShell();
  setupHealthMonitor();
  // Показать чек-лист новичка (только если ни разу не видел)
  setTimeout(() => maybeShowOnboarding(currentManager), 500);
  // Кнопка управления менеджерами — только для суперадмина
  const mgrBtn = document.getElementById('managersBtn');
  if (mgrBtn) mgrBtn.style.display = currentManager.is_superadmin ? '' : 'none';
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
  document.querySelectorAll('.nav-tab, .mobile-nav-tab').forEach(tab => {
    tab.onclick = () => switchSection(tab.getAttribute('data-section'));
  });
}

function switchSection(section) {
  if (section === currentSection) return;
  currentSection = section;
  // При смене раздела всегда показываем список (снимаем мобильный режим деталей)
  document.body.classList.remove('mobile-detail');
  // Закрываем drawer, если был открыт
  closeMobileDrawer();
  // Синхронизируем active-state на десктопных И мобильных табах
  document.querySelectorAll('.nav-tab, .mobile-nav-tab').forEach(t =>
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

// ============ МОБИЛЬНЫЙ DRAWER + ВЕРХНИЕ КНОПКИ ============

function setupMobileShell() {
  const drawer = document.getElementById('mobileDrawer');
  const openBtn = document.getElementById('mobileMenuBtn');
  const closeBtn = document.getElementById('mobileDrawerClose');
  const backdrop = document.getElementById('mobileDrawerBackdrop');
  const searchBtn = document.getElementById('mobileSearchBtn');

  if (openBtn) openBtn.onclick = openMobileDrawer;
  if (closeBtn) closeBtn.onclick = closeMobileDrawer;
  if (backdrop) backdrop.onclick = closeMobileDrawer;
  if (searchBtn) searchBtn.onclick = () => search.openGlobalSearch();

  // Делегирование действий внутри drawer
  if (drawer) {
    drawer.querySelectorAll('[data-action]').forEach(btn => {
      btn.onclick = () => handleDrawerAction(btn.getAttribute('data-action'));
    });
  }
}

function openMobileDrawer() {
  // Перед открытием синхронизируем имя менеджера и состояние кнопки темы
  const nameSpan = document.getElementById('managerNameMobile');
  if (nameSpan && currentManager) {
    nameSpan.textContent = '@' + currentManager.username + (currentManager.is_superadmin ? ' · админ' : '');
  }
  syncDrawerThemeButton();
  // Видимость пункта «Менеджеры» только для суперадмина
  const mgrBtn = document.getElementById('drawerManagers');
  if (mgrBtn) mgrBtn.style.display = (currentManager && currentManager.is_superadmin) ? '' : 'none';
  // Состояние дежурства — переиспользуем кнопку из подвала, синхронизируем зеркало
  syncMobileDutyBtn();
  document.getElementById('mobileDrawer').classList.add('open');
  document.body.classList.add('drawer-open');
}

function closeMobileDrawer() {
  const d = document.getElementById('mobileDrawer');
  if (d) d.classList.remove('open');
  document.body.classList.remove('drawer-open');
}

function handleDrawerAction(action) {
  closeMobileDrawer();
  switch (action) {
    case 'requisites': orders.openRequisitesModal(); break;
    case 'templates':  orders.openTemplatesEditor(); break;
    case 'managers':   openManagersModal(); break;
    case 'audit':      orders.openAuditLog(); break;
    case 'health':     openHealthModal(); break;
    case 'help':       openHelpModal(); break;
    case 'theme':      toggleTheme(); break;
    case 'logout':     logout(); break;
  }
}

function syncDrawerThemeButton() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  const ic = document.getElementById('drawerThemeIc');
  const lbl = document.getElementById('drawerThemeLbl');
  if (ic) ic.textContent = cur === 'dark' ? '☀️' : '🌙';
  if (lbl) lbl.textContent = cur === 'dark' ? 'Светлая тема' : 'Тёмная тема';
}

function syncMobileDutyBtn() {
  // Мобильная кнопка дежурства — копия состояния десктопной, но отдельный обработчик
  const desktopBtn = document.getElementById('dutyBtn');
  const mobileBtn = document.getElementById('dutyBtnMobile');
  if (!desktopBtn || !mobileBtn) return;
  mobileBtn.textContent = desktopBtn.textContent;
  mobileBtn.className = desktopBtn.className.replace('duty-toggle', 'duty-toggle');
  // Прокидываем клик: при клике на мобиле — кликаем на десктопную (она содержит логику)
  mobileBtn.onclick = () => desktopBtn.click();
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
  if (reqBtn) reqBtn.onclick = () => orders.openRequisitesModal();
  const tplBtn = document.getElementById('templatesBtn');
  if (tplBtn) tplBtn.onclick = () => orders.openTemplatesEditor();
  const auditBtn = document.getElementById('auditBtn');
  if (auditBtn) auditBtn.onclick = () => orders.openAuditLog();
  const managersBtn = document.getElementById('managersBtn');
  if (managersBtn) managersBtn.onclick = () => openManagersModal();
  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) helpBtn.onclick = () => openHelpModal();
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

// Состояние ожидания регистрации chat_id после открытия Telegram.
// Если true — фоновая задача опрашивает БД каждые 3 сек, ждёт chat_id.
let _dutyWaitingForChatId = false;
let _dutyPollTimer = null;

async function setupDutyToggle() {
  const btn = document.getElementById('dutyBtn');
  if (!btn) return;
  if (!currentManager) return;
  const status = await api.loadMyDutyStatus(currentManager.username).catch(() => null);
  applyDutyView(btn, status);
  btn.onclick = async () => {
    if (!status) {
      alert('Дежурство недоступно: менеджер не найден в базе.');
      return;
    }
    if (status.is_superadmin) {
      alert('Суперадмин всегда получает уведомления — отдельно включать дежурство не нужно.');
      return;
    }
    btn.disabled = true;
    const desired = !status.is_on_duty;
    try {
      // Если хотим встать на дежурство, а chat_id нет — нужно сначала зарегистрировать
      // chat_id, иначе уведомления физически не дойдут. Открываем Telegram через
      // deep-link, дальше Telegram сам пришлёт /start duty боту, бот сохранит chat_id.
      if (desired && !status.chat_id) {
        await openTelegramForDutyRegistration(btn, status);
        return;
      }
      // Обычное переключение — chat_id уже есть или мы хотим выключить дежурство.
      const updated = await api.setMyDutyStatus(currentManager.username, desired);
      status.is_on_duty = updated;
      applyDutyView(btn, status);
    } catch (e) {
      console.error(e);
      alert('Не удалось переключить дежурство: ' + (e.message || ''));
    } finally {
      btn.disabled = false;
    }
  };
}

// Открывает Telegram-бот через deep-link для тихой регистрации chat_id.
// Параллельно запускает опрос, ждёт появления chat_id у текущего менеджера
// и автоматически включает дежурство, как только он появится.
async function openTelegramForDutyRegistration(btn, status) {
  const url = `https://t.me/${CONFIG.BOT_USERNAME}?start=duty`;
  // Открываем в новой вкладке/окне; если у пользователя установлен Telegram Desktop —
  // он откроет приложение. На мобильном — приложение Telegram.
  window.open(url, '_blank', 'noopener');

  _dutyWaitingForChatId = true;
  applyDutyView(btn, status); // покажет состояние «ожидание»

  if (_dutyPollTimer) clearInterval(_dutyPollTimer);
  let attempts = 0;
  _dutyPollTimer = setInterval(async () => {
    attempts++;
    // Ограничим: до 5 минут (100 попыток × 3 сек). Если за это время не зашёл — отменяем.
    if (attempts > 100) {
      clearInterval(_dutyPollTimer);
      _dutyPollTimer = null;
      _dutyWaitingForChatId = false;
      applyDutyView(btn, status);
      return;
    }
    try {
      const fresh = await api.loadMyDutyStatus(currentManager.username);
      if (fresh && fresh.chat_id) {
        // chat_id появился — выключаем ожидание, включаем дежурство, обновляем UI
        clearInterval(_dutyPollTimer);
        _dutyPollTimer = null;
        _dutyWaitingForChatId = false;
        try {
          await api.setMyDutyStatus(currentManager.username, true);
          status.chat_id = fresh.chat_id;
          status.is_on_duty = true;
        } catch (e) {
          console.error(e);
        }
        applyDutyView(btn, status);
      }
    } catch (_) { /* ignore — повторим через интервал */ }
  }, 3000);
}

function applyDutyView(btn, status) {
  btn.classList.remove('duty-on', 'duty-off', 'duty-warn');
  // Суперадмин: всегда «онлайн», кнопка информационная
  if (status && status.is_superadmin) {
    btn.textContent = '🟢 На дежурстве (суперадмин)';
    btn.classList.add('duty-on');
    return;
  }
  // Менеджер не нашёлся в БД (странно, но возможно)
  if (!status) {
    btn.textContent = '⚠️ Дежурство недоступно';
    btn.classList.add('duty-warn');
    return;
  }
  // Ожидание регистрации (открыт Telegram, ждём `/start duty`)
  if (_dutyWaitingForChatId) {
    btn.textContent = '⏳ Откройте Telegram и нажмите «Запустить»…';
    btn.title = 'Ожидаем подключения. Как только откроете бота — дежурство включится автоматически.';
    btn.classList.add('duty-warn');
    return;
  }
  if (status.is_on_duty) {
    btn.textContent = '🟢 На дежурстве';
    btn.title = 'Уведомления в Telegram включены. Клик — снять с дежурства.';
    btn.classList.add('duty-on');
  } else {
    btn.textContent = '⚪ Не на дежурстве';
    btn.title = 'Уведомления в Telegram отключены. Клик — встать на дежурство.';
    btn.classList.add('duty-off');
  }
  // Зеркало для мобильной кнопки в drawer (если есть)
  syncMobileDutyBtn();
}

// ============ УПРАВЛЕНИЕ МЕНЕДЖЕРАМИ ============
// Доступно только суперадмину. CRUD + переключение дежурства любого менеджера.

async function openManagersModal() {
  if (!currentManager || !currentManager.is_superadmin) {
    alert('Только суперадмин может управлять менеджерами.');
    return;
  }
  const old = document.getElementById('mgrsModal');
  if (old) { old.remove(); return; }

  const modal = document.createElement('div');
  modal.id = 'mgrsModal';
  modal.className = 'qp-modal';
  modal.innerHTML = `
    <div class="qp-card mgrs-card">
      <div class="qp-head">👥 Менеджеры</div>
      <p class="req-hint">
        Менеджеры с дежурством получают уведомления в Telegram-боте. После добавления
        менеджер должен войти в админ-панель и встать на дежурство — Telegram откроется
        автоматически, и подключение завершится за один клик.
      </p>
      <div id="mgrsList" class="mgrs-list">Загрузка…</div>

      <div class="mgrs-add">
        <div class="mgrs-add-title">+ Добавить менеджера</div>
        <div class="mgrs-add-row">
          <input type="text" id="newMgrUsername" placeholder="@username (или просто username)">
          <span class="mgrs-or">или</span>
          <input type="number" id="newMgrTgId" placeholder="Telegram ID (число)">
          <button class="btn-primary" id="newMgrAdd">Добавить</button>
        </div>
        <div class="mgrs-add-hint">Достаточно указать одно из двух (или оба). Telegram ID удобен, если username скрыт.</div>
      </div>

      <div class="qp-actions">
        <button class="btn-light" id="mgrsClose">Закрыть</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('mgrsClose').onclick = () => modal.remove();

  async function refreshList() {
    const box = document.getElementById('mgrsList');
    box.innerHTML = 'Загрузка…';
    let rows;
    try { rows = await api.loadManagers(); } catch (e) { console.error(e); box.innerHTML = 'Ошибка загрузки'; return; }
    if (!rows || !rows.length) {
      box.innerHTML = '<div class="sh-empty">Менеджеров пока нет. Добавьте первого.</div>';
      return;
    }
    box.innerHTML = rows.map(m => {
      const who = m.username ? `@${m.username}` : (m.tg_id ? `id ${m.tg_id}` : '—');
      const hasChat = m.chat_id ? '🟢' : '⚠️';
      const chatHint = m.chat_id ? 'готов получать уведомления' : 'ещё не подключился — попросите его открыть админ-панель и встать на дежурство';
      const dutyClass = m.is_on_duty ? 'mgr-duty-on' : 'mgr-duty-off';
      const dutyLabel = m.is_on_duty ? '🟢 на дежурстве' : '⚪ не дежурит';
      const key = m.username ? `username=${m.username}` : `tg_id=${m.tg_id}`;
      return `
        <div class="mgr-row" data-key="${escapeHtml(key)}">
          <div class="mgr-row-main">
            <div class="mgr-who">${escapeHtml(who)}</div>
            <div class="mgr-meta" title="${escapeHtml(chatHint)}">${hasChat} ${escapeHtml(chatHint)}</div>
          </div>
          <button class="mgr-duty-btn ${dutyClass}" data-act="duty">${escapeHtml(dutyLabel)}</button>
          <button class="mgr-del-btn" data-act="del" title="Удалить">✕</button>
        </div>
      `;
    }).join('');

    box.querySelectorAll('.mgr-row').forEach(row => {
      const key = row.getAttribute('data-key');
      const m = parseMgrKey(key, rows);
      row.querySelector('[data-act="duty"]').onclick = async () => {
        try {
          await api.setManagerDuty(m, !m.is_on_duty, currentManager.username);
          await refreshList();
        } catch (e) { console.error(e); alert('Ошибка переключения дежурства: ' + e.message); }
      };
      row.querySelector('[data-act="del"]').onclick = async () => {
        const who = m.username ? `@${m.username}` : `id ${m.tg_id}`;
        if (!confirm(`Удалить менеджера ${who}?\nЗаказы, назначенные на него, останутся без исполнителя.`)) return;
        try {
          await api.deleteManager(m, currentManager.username);
          await refreshList();
        } catch (e) { console.error(e); alert('Ошибка удаления: ' + e.message); }
      };
    });
  }

  function parseMgrKey(key, rows) {
    const [k, v] = key.split('=');
    return rows.find(m => String(m[k]) === v) || (k === 'tg_id' ? { tg_id: Number(v) } : { username: v });
  }

  document.getElementById('newMgrAdd').onclick = async () => {
    const username = (document.getElementById('newMgrUsername').value || '').trim();
    const tgIdStr = (document.getElementById('newMgrTgId').value || '').trim();
    if (!username && !tgIdStr) { alert('Укажите username или Telegram ID'); return; }
    try {
      await api.addManager({
        username: username || undefined,
        tg_id: tgIdStr ? Number(tgIdStr) : undefined,
      }, currentManager.username);
      document.getElementById('newMgrUsername').value = '';
      document.getElementById('newMgrTgId').value = '';
      await refreshList();
    } catch (e) { console.error(e); alert('Не удалось добавить: ' + e.message); }
  };

  await refreshList();
}
// ============ МОНИТОРИНГ СОСТОЯНИЯ СЕРВИСОВ ============

function setupHealthMonitor() {
  // Запускаем периодический опрос
  health.startHealthMonitor();
  // Подписываемся на изменения состояния — обновляем иконки
  health.onStatusChange(updateHealthIcons);
  // Привязываем кнопки (мобильную и десктопную)
  const mobileBtn = document.getElementById('healthIndicator');
  if (mobileBtn) mobileBtn.onclick = openHealthModal;
  const desktopBtn = document.getElementById('healthBtn');
  if (desktopBtn) desktopBtn.onclick = openHealthModal;
}

function updateHealthIcons() {
  const overall = health.getOverallStatus();
  const icon = overall === 'ok' ? '🟢' : overall === 'down' ? '🔴' : '🟡';
  const dotMobile = document.getElementById('healthDot');
  if (dotMobile) dotMobile.textContent = icon;
  const dotDesktop = document.getElementById('healthBtnDot');
  if (dotDesktop) dotDesktop.textContent = icon;
  const dotDrawer = document.getElementById('drawerHealthIc');
  if (dotDrawer) dotDrawer.textContent = icon;
  // Если хотя бы один компонент упал — добавим пульсацию иконке
  const mobileBtn = document.getElementById('healthIndicator');
  const desktopBtn = document.getElementById('healthBtn');
  for (const btn of [mobileBtn, desktopBtn]) {
    if (!btn) continue;
    btn.classList.toggle('health-alarm', overall === 'down');
  }
}

const HEALTH_LABELS = {
  db:      { icon: '🗄️', name: 'База данных',           hint: 'Supabase PostgreSQL — где хранятся заказы, клиенты, обращения' },
  storage: { icon: '📁', name: 'Файловое хранилище',     hint: 'Supabase Storage — куда сохраняются фото и документы' },
  bot:     { icon: '🤖', name: 'Telegram-бот',           hint: 'Бот, через которого клиенты пишут менеджерам' },
  app:     { icon: '📱', name: 'Клиентское приложение',  hint: 'Mini App, в котором клиенты делают заказы' },
};

function openHealthModal() {
  const old = document.getElementById('healthModal');
  if (old) { old.remove(); return; }

  const modal = document.createElement('div');
  modal.id = 'healthModal';
  modal.className = 'qp-modal';
  modal.innerHTML = `
    <div class="qp-card health-card">
      <div class="qp-head">📡 Состояние сервисов</div>
      <p class="req-hint">
        Проверка идёт автоматически раз в минуту. Если что-то отвалится — дежурным менеджерам прилетит уведомление в Telegram.
      </p>
      <div id="healthList" class="health-list"></div>
      <div class="qp-actions">
        <button class="btn-light" id="healthRefresh">🔄 Проверить сейчас</button>
        <button class="btn-primary" id="healthClose">Закрыть</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('healthClose').onclick = () => modal.remove();

  const refreshBtn = document.getElementById('healthRefresh');
  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⏳ Проверяем…';
    try {
      await health.forceCheck();
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 Проверить сейчас';
    }
  };

  // Подписка на обновления, пока модалка открыта
  const unsubscribe = health.onStatusChange(renderHealthList);
  // Снимаем подписку при закрытии модалки
  const origRemove = modal.remove.bind(modal);
  modal.remove = () => { unsubscribe(); origRemove(); };

  renderHealthList(health.getState());
}

function renderHealthList(state) {
  const box = document.getElementById('healthList');
  if (!box) return;
  const order = ['db', 'storage', 'bot', 'app'];
  box.innerHTML = order.map(c => {
    const info = HEALTH_LABELS[c];
    const s = state[c];
    const icon = s.status === 'ok' ? '🟢' : s.status === 'down' ? '🔴' : '⚪';
    const label = s.status === 'ok' ? 'Работает' : s.status === 'down' ? 'Недоступен' : 'Проверяется…';
    const cls = s.status === 'ok' ? 'health-ok' : s.status === 'down' ? 'health-down' : 'health-unknown';
    const latency = s.latency_ms != null ? `${s.latency_ms} мс` : '—';
    const checked = s.checked_at
      ? new Date(s.checked_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '—';
    const error = s.error ? `<div class="health-error">${escapeHtml(s.error)}</div>` : '';
    return `
      <div class="health-row ${cls}">
        <div class="health-row-main">
          <div class="health-row-name">${info.icon} ${info.name}</div>
          <div class="health-row-hint">${info.hint}</div>
          ${error}
        </div>
        <div class="health-row-meta">
          <div class="health-row-status">${icon} ${label}</div>
          <div class="health-row-detail">⏱ ${latency} · ${checked}</div>
        </div>
      </div>`;
  }).join('');
}
