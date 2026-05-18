// Точка входа. Стратегия первой отрисовки:
//
// 1. Применяем локальные настройки (lang/theme) — мгновенно, без сети
// 2. Запускаем параллельные BD-запросы (customer/favorites/cart)
// 3. Ждём их с таймаутом 800мс
// 4. Применяем то что пришло, и только потом делаем router.navigate('home'|'onboarding')
//
// Этим избегаем «моргание через секунду» — раньше первый рендер шёл сразу с локальными
// данными, а через ~500-1000мс приходил ответ из БД с другими настройками или данными,
// что вызывало router.navigate() и перерисовку. Теперь первый рендер уже учитывает БД.
//
// Если 800мс не хватило (медленная сеть) — рендерим с локальными данными и применяем
// БД-данные через мягкое обновление badges (не через router.navigate).

import { initTelegram, onThemeChanged, onViewportChanged, tg } from './tg.js';
import { applyTheme } from './theme.js';
import { setLang, applyI18N } from './i18n.js';
import {
  state, isOnboarded, cartTotalCount, saveState,
  setFavoritesSyncer, setCartSyncer,
} from './state.js';
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

const BOOTSTRAP_TIMEOUT_MS = 800;

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

// Применяет данные клиента (preferences) к локальному state. Возвращает true,
// если что-то реально изменилось.
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
  if (newFavs.length === state.favorites.length) return false;
  state.favorites = newFavs;
  saveState();
  return true;
}

// Корзина: при merge берём максимум qty, не «сумму» — пользователь видел эти товары
// на каком-то устройстве и не отменял их, значит должны остаться.
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
  // Записываем merged-результат в БД, чтобы устройства синхронизировались
  newCart.forEach(c => api.setCartItem(c.productId, c.size, c.qty));
  if (newCart.length === state.cart.length &&
      newCart.every((c, i) => state.cart[i] && state.cart[i].qty === c.qty)) return false;
  state.cart = newCart;
  saveState();
  return true;
}

// Запускает BD-загрузку, ждёт максимум timeout мс, применяет всё что успело прийти.
// Возвращает Promise<void>.
async function bootstrapDataWithTimeout(timeoutMs) {
  // Запускаем все запросы параллельно
  const customerP = api.loadCustomer().catch(() => null);
  const favsP = api.loadFavorites().catch(() => null);
  const cartP = api.loadCart().catch(() => null);

  // Race с таймаутом
  const all = Promise.all([customerP, favsP, cartP]);
  const timeout = new Promise(resolve => setTimeout(resolve, timeoutMs));
  const result = await Promise.race([all, timeout]);

  if (Array.isArray(result)) {
    // Все запросы успели — применяем синхронно
    const [customer, favs, cart] = result;
    applyCustomerData(customer);
    mergeFavorites(favs);
    mergeCart(cart);
    return;
  }

  // Таймаут — применяем то что придёт, без перерисовки страницы.
  // Списки favorites/cart мягко обновятся через badges (setInterval);
  // settings — применятся через applyTheme/applyI18N, которые меняют CSS-переменные
  // и DOM-атрибуты без полной перерисовки страницы.
  all.then(([customer, favs, cart]) => {
    applyCustomerData(customer);
    mergeFavorites(favs);
    mergeCart(cart);
    updateBadges();
  });
}

async function bootstrap() {
  initTelegram();

  // 1. Локальные настройки сразу (для случая когда сеть медленная — пользователь
  //    хотя бы увидит правильный язык/тему мгновенно)
  setLang(state.settings.lang);
  applyTheme(state.settings.theme);
  applyI18N();

  // 2. Регистрируем view
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

  // 3. Регистрируем синхронизаторы — без них любая мутация favorites/cart
  //    перестанет писать в БД
  setFavoritesSyncer(({ action, productId, size }) => {
    if (action === 'add') api.addFavorite(productId, size);
    else if (action === 'remove') api.removeFavorite(productId, size);
  });
  setCartSyncer(({ action, productId, size, qty }) => {
    if (action === 'set') api.setCartItem(productId, size, qty);
    else if (action === 'remove') api.removeCartItem(productId, size);
    else if (action === 'clear') api.clearCart();
  });

  // 4. Глобальные обработчики UI
  setupLightbox();
  setupOnboarding();

  document.getElementById('headerLogo').onclick = () => router.navigate('home');
  document.getElementById('favBtn').onclick = () => router.navigate('favorites');
  document.getElementById('cartBtn').onclick = () => router.navigate('cart');
  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => {
    b.onclick = () => router.navigate(b.getAttribute('data-nav'));
  });

  // Бейджи в шапке
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

  // Telegram-события
  onViewportChanged(() => {
    try { tg?.disableVerticalSwipes?.(); } catch (_) {}
  });
  onThemeChanged(() => applyTheme(state.settings.theme));

  // Подписка на обновления каталога (фоновое stale-while-revalidate).
  // Перерисовываем текущую страницу только если она показывает товары —
  // и только если кэш реально изменился (это проверяется в cache/products.js).
  const VIEWS_WITH_PRODUCTS = new Set(['home', 'catalog', 'detail', 'favorites', 'cart', 'admin']);
  api.onProductsChange(() => {
    const cur = router.current();
    if (VIEWS_WITH_PRODUCTS.has(cur)) {
      router.navigate(cur, router.lastContext());
    }
  });

  // 5. Подгружаем данные клиента с таймаутом, чтобы первая отрисовка
  //    уже была с актуальной информацией. Если таймаут — рендер с локальными.
  if (isOnboarded()) {
    await bootstrapDataWithTimeout(BOOTSTRAP_TIMEOUT_MS);
  }

  // 6. Стартовый экран
  if (!isOnboarded()) router.navigate('onboarding');
  else router.navigate('home');
}

bootstrap();
