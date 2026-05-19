// Точка входа.
//
// Стратегия первой отрисовки: НЕ блокируем рендер на сетевых запросах.
// Локальные настройки применяем сразу, страницу рендерим сразу с тем что есть в
// localStorage-кэше (или со skeleton, если кэша нет). БД-запросы идут в фоне:
//   - Каталог: при приходе свежих данных view получает их через api.onProductsChange
//     и обновляет grid в режиме diff — никаких полных перерисовок страницы.
//   - Клиент: настройки (lang/theme/currency) применяются тихо через applyTheme/applyI18N.
//     Если они отличаются от локальных — текущая страница перерисуется через router.navigate,
//     но это редкий случай (только первое открытие на новом устройстве или после смены
//     настроек на другом устройстве).
//   - Избранное/корзина: после merge обновляются badges; на странице избранного/корзины
//     refreshGrid() сработает через подписку на каталог (он гарантированно отрабатывает
//     после первой загрузки данных).

import { initTelegram, onThemeChanged, onViewportChanged, tg } from './tg.js';
import { applyTheme } from './theme.js';
import { setLang, applyI18N } from './i18n.js';
import {
  state, isOnboarded, cartTotalCount, saveState,
  setFavoritesSyncer, setCartSyncer,
  setOnboardedLocal, clearOnboardedLocal,
} from './state.js';
import { api } from './api/index.js';
import { router, registerView } from './router.js';
import { setupLightbox } from './components/lightbox.js';
import { setupOnboarding, renderOnboarding } from './views/onboarding.js';
import { renderHome, onCatalogChanged as onHomeCatalogChanged } from './views/home.js';
import { renderChat, resetChat } from './views/chat.js';
import { renderCatalog, onCatalogChanged as onCatalogCatalogChanged } from './views/catalog.js';
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

function applyCustomerData(customer) {
  const dbPrefs = customer?.preferences;
  if (!dbPrefs) return false;
  const changed =
    (dbPrefs.lang ?? state.settings.lang) !== state.settings.lang ||
    (dbPrefs.theme ?? state.settings.theme) !== state.settings.theme ||
    (dbPrefs.currency ?? state.settings.currency) !== state.settings.currency;
  if (!changed) return false;
  state.settings = { ...state.settings, ...dbPrefs };
  saveState();
  setLang(state.settings.lang);
  applyTheme(state.settings.theme);
  applyI18N();
  return true;
}

function mergeFavorites(dbFavs) {
  if (!Array.isArray(dbFavs) || dbFavs.length === 0) return false;
  const key = f => f.productId + '::' + (f.size || '');
  const merged = new Map();
  dbFavs.forEach(f => merged.set(key(f), f));
  state.favorites.forEach(f => merged.set(key(f), f));
  const newFavs = Array.from(merged.values());
  if (newFavs.length === state.favorites.length &&
      newFavs.every(f => state.favorites.some(s => key(s) === key(f)))) {
    return false;
  }
  state.favorites = newFavs;
  saveState();
  return true;
}

function mergeCart(dbCart) {
  if (!Array.isArray(dbCart) || dbCart.length === 0) return false;
  const key = c => c.productId + '::' + (c.size || '');
  const merged = new Map();
  dbCart.forEach(c => merged.set(key(c), { ...c }));
  state.cart.forEach(c => {
    const k = key(c);
    if (merged.has(k)) merged.get(k).qty = Math.max(merged.get(k).qty, c.qty);
    else merged.set(k, { ...c });
  });
  const newCart = Array.from(merged.values());
  // Синхронизируем merged в БД (на случай если устройства расходились)
  newCart.forEach(c => api.setCartItem(c.productId, c.size, c.qty));
  // Сравниваем: если состав и количества те же — не считаем изменением
  if (newCart.length === state.cart.length) {
    const same = newCart.every(c => {
      const existing = state.cart.find(s => key(s) === key(c));
      return existing && existing.qty === c.qty;
    });
    if (same) return false;
  }
  state.cart = newCart;
  saveState();
  return true;
}

async function loadCustomerData() {
  try {
    const [customer, favs, cart] = await Promise.all([
      api.loadCustomer().catch(() => null),
      api.loadFavorites().catch(() => null),
      api.loadCart().catch(() => null),
    ]);
    const prefsChanged = applyCustomerData(customer);
    const favsChanged = mergeFavorites(favs);
    const cartChanged = mergeCart(cart);

    if (favsChanged || cartChanged) {
      updateBadges();
    }
    if (prefsChanged) {
      const cur = router.current();
      if (cur && cur !== 'detail') router.navigate(cur, router.lastContext());
    }
    return customer;
  } catch (e) {
    console.warn('[bootstrap] customer load skipped:', e);
    return null;
  }
}

async function bootstrap() {
  initTelegram();

  // Локальные настройки сразу
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

  // Синхронизаторы favorites/cart с БД
  setFavoritesSyncer(({ action, productId, size }) => {
    if (action === 'add') api.addFavorite(productId, size);
    else if (action === 'remove') api.removeFavorite(productId, size);
  });
  setCartSyncer(({ action, productId, size, qty }) => {
    if (action === 'set') api.setCartItem(productId, size, qty);
    else if (action === 'remove') api.removeCartItem(productId, size);
    else if (action === 'clear') api.clearCart();
  });

  // Глобальные обработчики UI
  setupLightbox();
  setupOnboarding();
  document.getElementById('headerLogo').onclick = () => router.navigate('home');
  document.getElementById('favBtn').onclick = () => router.navigate('favorites');
  document.getElementById('cartBtn').onclick = () => router.navigate('cart');
  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => {
    b.onclick = () => router.navigate(b.getAttribute('data-nav'));
  });

  // Бейджи
  window.addEventListener('cart:changed', updateBadges);
  setInterval(updateBadges, 500);
  updateBadges();

  // Закрытие клавиатуры при тапе вне поля ввода
  const KEEP_FOCUS_SELECTOR = 'input, textarea, select, label, button, a, [contenteditable="true"]';
  document.addEventListener('pointerdown', (e) => {
    const active = document.activeElement;
    if (!active?.matches?.('input, textarea, [contenteditable="true"]')) return;
    let n = e.target;
    while (n && n !== document.body) {
      if (n.matches?.(KEEP_FOCUS_SELECTOR)) return;
      n = n.parentNode;
    }
    try { active.blur(); } catch (_) {}
  }, true);

  onViewportChanged(() => {
    try { tg?.disableVerticalSwipes?.(); } catch (_) {}
  });
  onThemeChanged(() => applyTheme(state.settings.theme));

  // Подписка на обновление каталога — обновляем grid НА ТЕКУЩЕЙ странице
  // без полной перерисовки. Это убирает моргание картинок.
  api.onProductsChange(() => {
    const cur = router.current();
    if (cur === 'home') onHomeCatalogChanged();
    else if (cur === 'catalog') onCatalogCatalogChanged();
    // На favorites/cart/detail сетки нет — не трогаем
    // На admin/history — обычно нужна полная перерисовка, но это редкий случай
  });

  // Стартовый экран — определяем по флагу онбординга.
  //
  // Источник правды — поле customers.onboarded в БД. Но запрос к БД асинхронный,
  // и если мы будем ждать его перед первой отрисовкой — пользователь увидит
  // белый экран на 200-500мс. Делаем так:
  //
  //   1. Если localStorage говорит что онбординг был — сразу показываем главную.
  //      Это покрывает 99% случаев (повторное открытие апки).
  //   2. Если localStorage пустой — это либо новый клиент, либо админ сбросил флаг.
  //      Ждём БД с коротким таймаутом 400мс, чтобы решить.
  //   3. БД-данные (customer/favorites/cart) подгружаем параллельно в любом случае.
  if (isOnboarded()) {
    // localStorage говорит что было — показываем сразу главную.
    router.navigate('home');
    // Параллельно проверяем БД: если там FALSE (например, админ сбросил)
    // — переключаем на онбординг и стираем локальный флаг.
    loadCustomerData().then(customer => {
      if (customer && customer.onboarded === false) {
        clearOnboardedLocal();
        router.navigate('onboarding');
      }
    });
  } else {
    // Нет локального флага. Запрашиваем БД быстро.
    const customer = await Promise.race([
      api.loadCustomer().catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 400)),
    ]);
    if (customer?.onboarded === true) {
      // В БД флаг стоит — синхронизируем с localStorage и идём на главную.
      setOnboardedLocal();
      router.navigate('home');
    } else {
      // Либо новый клиент, либо БД не ответила — в любом случае показываем онбординг.
      router.navigate('onboarding');
    }
    // Догружаем остальные данные в фоне
    loadCustomerData();
  }
}

bootstrap();
