// Точка входа: бутстрап, навешивание глобальных обработчиков, регистрация view.
import { CONFIG } from './config.js';
import { initTelegram, onThemeChanged, onViewportChanged, tg } from './tg.js';
import { applyTheme } from './theme.js';
import { setLang, applyI18N, t } from './i18n.js';
import { state, isOnboarded, cartTotalCount } from './state.js';
import { api } from './api/index.js';
import { router, registerView } from './router.js';
import { setupLightbox } from './components/lightbox.js';
import { setupOnboarding, renderOnboarding } from './views/onboarding.js';
import { renderHome } from './views/home.js';
import { renderChat, resetChat } from './views/chat.js';
import { renderCatalog } from './views/catalog.js';
import { renderFavorites } from './views/favorites.js';
import { renderCart } from './views/cart.js';
import { renderDetail } from './views/detail.js';
import { renderProfile } from './views/profile.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';
import { renderAdmin } from './views/admin.js';

function updateBadges() {
  const favBadge = document.getElementById('favBadge');
  const cartBadge = document.getElementById('cartBadge');
  const favCount = state.favorites.length;
  const cartCount = cartTotalCount();
  if (favBadge) {
    favBadge.textContent = String(favCount);
    favBadge.style.display = favCount > 0 ? 'flex' : 'none';
  }
  if (cartBadge) {
    cartBadge.textContent = String(cartCount);
    cartBadge.style.display = cartCount > 0 ? 'flex' : 'none';
  }
}

async function bootstrap() {
  initTelegram();

  // Применяем локальные настройки сразу — чтобы первая отрисовка не ждала сеть
  setLang(state.settings.lang);
  applyTheme(state.settings.theme);
  applyI18N();

  // Подтягиваем настройки клиента из API в фоне.
  // Если БД отдала отличные настройки — применим и перерисуем текущую страницу.
  // В local-режиме это мгновенно; в supabase — асинхронно (без блокировки UI).
  (async () => {
    try {
      const customer = await api.loadCustomer();
      const dbPrefs = customer?.preferences;
      if (!dbPrefs) return;
      const changed =
        dbPrefs.lang !== state.settings.lang ||
        dbPrefs.theme !== state.settings.theme ||
        dbPrefs.currency !== state.settings.currency;
      if (!changed) return;
      state.settings = { ...state.settings, ...dbPrefs };
      setLang(state.settings.lang);
      applyTheme(state.settings.theme);
      applyI18N();
      // Перерисуем текущую страницу, чтобы применились язык/валюта/тема
      const cur = router.current();
      if (cur) router.navigate(cur, router.lastContext());
    } catch (e) {
      console.warn('[bootstrap] customer load skipped:', e);
    }
  })();

  // Регистрируем view
  registerView('onboarding', renderOnboarding);
  registerView('home',       renderHome);
  registerView('chat',       () => { resetChat(); renderChat(); });
  registerView('catalog',    renderCatalog);
  registerView('favorites',  renderFavorites);
  registerView('cart',       renderCart);
  registerView('detail',     renderDetail);
  registerView('profile',    renderProfile);
  registerView('history',    renderHistory);
  registerView('settings',   renderSettings);
  registerView('admin',      renderAdmin);

  // Лайтбокс
  setupLightbox();

  // Онбординг
  setupOnboarding();

  // Шапка
  document.getElementById('headerLogo').onclick = () => router.navigate('home');
  document.getElementById('favBtn').onclick = () => router.navigate('favorites');
  document.getElementById('cartBtn').onclick = () => router.navigate('cart');

  // Нижняя навигация
  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => {
    b.onclick = () => router.navigate(b.getAttribute('data-nav'));
  });

  // Бейджи: обновляем после любого перехода и по событию из корзины/избранного
  const refreshBadges = () => updateBadges();
  window.addEventListener('cart:changed', refreshBadges);
  // Каждые 300мс — простой способ держать бейджи свежими без шин:
  setInterval(refreshBadges, 300);
  refreshBadges();

  // Правка #4: тап в любое место мини-аппа закрывает экранную клавиатуру.
  // Если цель клика внутри — поля ввода, label (включая скрепку с скрытым file input),
  // или кнопки (отправка, прикрепить) — клавиатуру не закрываем.
  // Используем явный walk вверх, потому что Element.closest() на SVG-детях
  // (наша иконка скрепки — SVG) не всегда работает в старых WebView Telegram.
  const KEEP_FOCUS_SELECTOR = 'input, textarea, select, label, button, a, [contenteditable="true"]';
  function shouldKeepFocus(el) {
    let n = el;
    while (n && n !== document.body) {
      if (n.matches && n.matches(KEEP_FOCUS_SELECTOR)) return true;
      n = n.parentNode;
    }
    return false;
  }
  document.addEventListener('pointerdown', (e) => {
    const active = document.activeElement;
    if (!active) return;
    const isTextField = active.matches?.('input, textarea, [contenteditable="true"]');
    if (!isTextField) return;
    if (shouldKeepFocus(e.target)) return;
    try { active.blur(); } catch (err) {}
  }, true);

  // При смене viewport заново отключаем вертикальные свайпы
  onViewportChanged(() => {
    try { tg?.disableVerticalSwipes?.(); } catch (e) {}
  });
  // При смене темы Telegram переоцениваем тему, если у нас auto
  onThemeChanged(() => applyTheme(state.settings.theme));

  // Стартовый экран
  if (!isOnboarded()) router.navigate('onboarding');
  else router.navigate('home');
}

bootstrap();
