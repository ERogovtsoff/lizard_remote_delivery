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

  // Сначала пробуем загрузить настройки клиента из API (в local-режиме это просто state)
  try {
    const customer = await api.loadCustomer();
    if (customer?.preferences) {
      // Если БД отдала пользовательские настройки — применяем их к локальному state
      state.settings = { ...state.settings, ...customer.preferences };
    }
  } catch (e) {}

  setLang(state.settings.lang);
  applyTheme(state.settings.theme);
  applyI18N();

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
  // Если цель клика — НЕ инпут/textarea/select/label и НЕ кнопка-сабмит-формы,
  // мы убираем фокус с активного инпута.
  document.addEventListener('pointerdown', (e) => {
    const active = document.activeElement;
    if (!active) return;
    const isTextField = active.matches?.('input, textarea, [contenteditable="true"]');
    if (!isTextField) return;
    if (e.target.closest('input, textarea, select, label, [contenteditable="true"]')) return;
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
