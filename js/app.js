// Точка входа: бутстрап, навешивание глобальных обработчиков, регистрация view.
import { CONFIG } from './config.js';
import { initTelegram, onThemeChanged, onViewportChanged, tg } from './tg.js';
import { applyTheme } from './theme.js';
import { setLang, applyI18N, t } from './i18n.js';
import { state, isOnboarded, cartTotalCount, saveState, setFavoritesSyncer } from './state.js';
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

  // Регистрируем синхронизатор избранного: state.js дёргает его при каждой мутации,
  // мы пишем в БД через API.
  setFavoritesSyncer(({ action, productId, size }) => {
    if (action === 'add') api.addFavorite(productId, size);
    else if (action === 'remove') api.removeFavorite(productId, size);
  });

  // Подтягиваем настройки клиента и избранное из БД в фоне.
  // Если БД отдала отличные настройки — применим и перерисуем текущую страницу.
  (async () => {
    try {
      const customer = await api.loadCustomer();
      const dbPrefs = customer?.preferences;
      let needRerender = false;
      if (dbPrefs) {
        const changed =
          dbPrefs.lang !== state.settings.lang ||
          dbPrefs.theme !== state.settings.theme ||
          dbPrefs.currency !== state.settings.currency;
        if (changed) {
          state.settings = { ...state.settings, ...dbPrefs };
          setLang(state.settings.lang);
          applyTheme(state.settings.theme);
          applyI18N();
          needRerender = true;
        }
      }

      // Загружаем избранное из БД и сливаем с локальным.
      // Стратегия: если в БД что-то есть — БД это «источник правды» (между устройствами).
      // Локальные изменения, сделанные в этой сессии до прихода БД, останутся
      // — мы их добавляем к серверному списку.
      const dbFavs = await api.loadFavorites();
      if (Array.isArray(dbFavs) && dbFavs.length > 0) {
        // merge: уникальные по {productId, size}
        const key = f => f.productId + '::' + (f.size || '');
        const merged = new Map();
        dbFavs.forEach(f => merged.set(key(f), f));
        state.favorites.forEach(f => merged.set(key(f), f));
        state.favorites = Array.from(merged.values());
        saveState();
        needRerender = true;
      }

      if (needRerender) {
        const cur = router.current();
        if (cur) router.navigate(cur, router.lastContext());
      }
    } catch (e) {
      console.warn('[bootstrap] background load skipped:', e);
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

  // Подписка на обновление каталога (фоновое stale-while-revalidate).
  // Если открыта главная/каталог/деталь/избранное/корзина — перерисуем,
  // чтобы пользователь увидел свежие данные без ручной перезагрузки.
  const VIEWS_WITH_PRODUCTS = new Set(['home', 'catalog', 'detail', 'favorites', 'cart', 'admin', 'history']);
  api.onProductsChange(() => {
    const cur = router.current();
    if (VIEWS_WITH_PRODUCTS.has(cur)) {
      router.navigate(cur, router.lastContext());
    }
  });

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
  setInterval(refreshBadges, 300);
  refreshBadges();

  // Тап в любое место мини-аппа закрывает экранную клавиатуру.
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
