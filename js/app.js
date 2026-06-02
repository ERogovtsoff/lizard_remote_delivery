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

import { initTelegram, onThemeChanged, onViewportChanged, tg, getUser, setManagers } from './tg.js';
import { CONFIG } from './config.js';
import { applyTheme } from './theme.js';
import { setLang, applyI18N, t } from './i18n.js';
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

let _prevCartCount = 0;
let _prevFavCount = 0;
function updateBadges() {
  const favBadge = document.getElementById('favBadge');
  const cartBadge = document.getElementById('cartBadge');
  const favCount = state.favorites.length;
  const cartCount = cartTotalCount();
  if (favBadge) {
    favBadge.textContent = String(favCount);
    favBadge.style.display = favCount > 0 ? 'flex' : 'none';
    // Пульс при добавлении в избранное (количество выросло)
    if (favCount > _prevFavCount) {
      const favBtn = document.getElementById('favBtn');
      if (favBtn) {
        favBtn.classList.remove('cart-pulse');
        void favBtn.offsetWidth;           // перезапуск анимации
        favBtn.classList.add('cart-pulse');
      }
      favBadge.classList.remove('badge-pop');
      void favBadge.offsetWidth;
      favBadge.classList.add('badge-pop');
    }
  }
  if (cartBadge) {
    cartBadge.textContent = String(cartCount);
    cartBadge.style.display = cartCount > 0 ? 'flex' : 'none';
    // Пульс при добавлении (количество выросло)
    if (cartCount > _prevCartCount) {
      const cartBtn = document.getElementById('cartBtn');
      if (cartBtn) {
        cartBtn.classList.remove('cart-pulse');
        void cartBtn.offsetWidth;          // перезапуск анимации
        cartBtn.classList.add('cart-pulse');
      }
      cartBadge.classList.remove('badge-pop');
      void cartBadge.offsetWidth;
      cartBadge.classList.add('badge-pop');
    }
  }
  _prevCartCount = cartCount;
  _prevFavCount = favCount;
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
  // БД — источник истины. Состояние заменяем данными из БД, а не сливаем:
  // иначе удалённый на другом устройстве товар «воскресал» бы из локального кэша.
  if (!Array.isArray(dbFavs)) return false;
  const key = f => f.productId + '::' + (f.size || '');
  // Разовая миграция: БД пустая, локально есть — заливаем локальное в БД.
  if (dbFavs.length === 0 && state.favorites.length > 0) {
    state.favorites.forEach(f => { try { api.addFavorite(f.productId, f.size); } catch (e) {} });
    return false;
  }
  const newFavs = dbFavs.map(f => ({ ...f }));
  // Без изменений? (тот же состав)
  if (newFavs.length === state.favorites.length &&
      newFavs.every(f => state.favorites.some(s => key(s) === key(f)))) {
    return false;
  }
  state.favorites = newFavs;
  saveState();
  return true;
}

function mergeCart(dbCart) {
  // БД — источник истины (см. mergeFavorites). Заменяем локальное состояние.
  if (!Array.isArray(dbCart)) return false;
  const key = c => c.productId + '::' + (c.size || '');
  // Разовая миграция: БД пустая, но локально что-то есть (старый клиент на
  // localStorage до появления синка) — заливаем локальное в БД, не теряя его.
  if (dbCart.length === 0 && state.cart.length > 0) {
    state.cart.forEach(c => { try { api.setCartItem(c.productId, c.size, c.qty); } catch (e) {} });
    return false;
  }
  const newCart = dbCart.map(c => ({ ...c }));
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

    // Подчищаем «мёртвые» позиции: товар скрыт/удалён или размера больше нет.
    // Это устраняет рассинхрон счётчиков между устройствами и битые карточки.
    const prunedChanged = await pruneDeadItems();

    if (favsChanged || cartChanged || prunedChanged) {
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

// Удаляет из избранного и корзины позиции, которых больше нет в продаже:
// товар отсутствует/неактивен, либо указанного размера уже нет (или сток 0
// для размерных товаров). Чистит и локальный state, и БД.
async function pruneDeadItems() {
  let products;
  try {
    products = await api.loadProducts();
  } catch (_) {
    return false;   // нет данных о товарах — не трогаем, чтобы не удалить лишнее
  }
  if (!Array.isArray(products) || products.length === 0) return false;
  const byId = new Map(products.map(p => [p.id, p]));

  // «Жива» ли позиция (productId + size)
  const isAlive = (productId, size) => {
    const p = byId.get(productId);
    if (!p) return false;                       // товара нет в каталоге
    if (p.is_active === false) return false;    // товар скрыт
    const sizes = p.sizes || [];
    if (sizes.length === 0) return true;        // безразмерный товар — жив
    if (size == null || size === '') return true; // позиция без размера у размерного — оставим
    if (!sizes.includes(size)) return false;    // такого размера больше нет
    // Размер есть — проверим сток (если задан)
    if (p.stock && Object.keys(p.stock).length > 0) {
      return (Number(p.stock[size]) || 0) > 0;
    }
    return true;
  };

  let changed = false;

  // Избранное
  const deadFavs = state.favorites.filter(f => !isAlive(f.productId, f.size));
  if (deadFavs.length > 0) {
    deadFavs.forEach(f => { try { api.removeFavorite(f.productId, f.size); } catch (_) {} });
    state.favorites = state.favorites.filter(f => isAlive(f.productId, f.size));
    changed = true;
  }

  // Корзина
  const deadCart = state.cart.filter(c => !isAlive(c.productId, c.size));
  if (deadCart.length > 0) {
    deadCart.forEach(c => { try { api.removeCartItem(c.productId, c.size); } catch (_) {} });
    state.cart = state.cart.filter(c => isAlive(c.productId, c.size));
    changed = true;
  }

  if (changed) saveState();
  return changed;
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

  // Индикатор отсутствия интернета. Браузер шлёт online/offline события.
  const offlineBar = document.getElementById('offlineBar');
  function updateOnlineStatus() {
    if (!offlineBar) return;
    if (navigator.onLine) {
      offlineBar.style.display = 'none';
    } else {
      offlineBar.textContent = t('offline');
      offlineBar.style.display = 'block';
    }
  }
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  // Предупреждение «Гость»: если Telegram не передал данные пользователя,
  // приложение открыто вне бота / по кривой ссылке — часть функций не работает.
  const guestBar = document.getElementById('guestBar');
  if (guestBar && !getUser()) {
    const botUrl = `https://t.me/${CONFIG.BOT_USERNAME}`;
    guestBar.innerHTML = `<span class="guest-text">${t('guestWarning')}</span>`
      + `<a class="guest-link" href="${botUrl}" target="_blank" rel="noopener">${t('guestOpenBot')}</a>`;
    guestBar.style.display = 'block';
    // Клик по тексту (не по ссылке) скрывает баннер
    guestBar.querySelector('.guest-text').onclick = () => { guestBar.style.display = 'none'; };
  }

  // Предзагружаем аватарку пользователя в кэш браузера — чтобы при открытии
  // профиля она появилась мгновенно, без мигания/повторного запроса.
  try {
    const photo = getUser()?.photo_url;
    if (photo) { const im = new Image(); im.src = photo; }
  } catch (_) {}

  // Загружаем список менеджеров из БД для проверки доступа к админке.
  // Делаем в фоне; если пользователь окажется менеджером — кнопка «Управление
  // каталогом» в профиле появится после перерисовки.
  api.loadManagers().then(list => {
    setManagers(list);
    // Если открыт профиль — перерисуем, чтобы показать админ-пункт
    if (router.current() === 'profile') router.navigate('profile');
  }).catch(() => {});

  document.getElementById('headerLogo').onclick = () => router.navigate('home');
  document.getElementById('favBtn').onclick = () => router.navigate('favorites');
  document.getElementById('cartBtn').onclick = () => router.navigate('cart');
  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => {
    b.onclick = () => router.navigate(b.getAttribute('data-nav'));
  });

  // Бейджи
  window.addEventListener('cart:changed', updateBadges);
  window.addEventListener('state:changed', updateBadges);
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

  // Когда приложение снова становится активным (вернулись с другого устройства,
  // развернули Mini App, переключили вкладку) — перечитываем корзину/избранное
  // из БД. Это устраняет остаточный рассинхрон #12: открытое в фоне приложение
  // не знало об изменениях, сделанных на другом устройстве.
  let lastResync = 0;
  async function resyncFromDb() {
    if (!getUser()) return;                 // гость — синхронизировать нечего
    const now = Date.now();
    if (now - lastResync < 2000) return;    // не чаще раза в 2с
    lastResync = now;
    try {
      const [favs, cart] = await Promise.all([
        api.loadFavorites().catch(() => null),
        api.loadCart().catch(() => null),
      ]);
      const favsChanged = mergeFavorites(favs);
      const cartChanged = mergeCart(cart);
      if (favsChanged || cartChanged) {
        updateBadges();
        // Если открыта корзина/избранное — перерисуем, чтобы изменения были видны
        const cur = router.current();
        if (cur === 'cart' || cur === 'favorites') {
          router.navigate(cur, router.lastContext());
        }
      }
    } catch (e) {
      console.warn('[resync] failed:', e);
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resyncFromDb();
  });
  // Telegram-специфичные события активации, если доступны
  try { tg?.onEvent?.('activated', resyncFromDb); } catch (_) {}
  window.addEventListener('focus', resyncFromDb);

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
  // Splash (#appSplashInit) уже виден из HTML с первого кадра — поэтому пользователь
  // НИКОГДА не видит главную раньше онбординга. Мы прячем splash только после того,
  // как решили, что показывать.
  //
  //   - Есть localStorage флаг → существующий клиент → главная (БД проверяем в фоне).
  //   - Нет флага → новый клиент → ждём БД (таймаут 1.5с), решаем онбординг/главная.
  if (isOnboarded()) {
    router.navigate('home');
    hideSplash();
    handleStartParam();
    loadCustomerData().then(customer => {
      if (customer && customer.onboarded === false) {
        clearOnboardedLocal();
        router.navigate('onboarding');
      }
    });
  } else {
    const customer = await Promise.race([
      api.loadCustomer().catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 1500)),
    ]);

    if (customer?.onboarded === true) {
      setOnboardedLocal();
      router.navigate('home');
      handleStartParam();
    } else {
      router.navigate('onboarding');
    }
    hideSplash();
    loadCustomerData();
  }
}

// Обработка deep-link: если апку открыли по ссылке вида ?startapp=product_<id>,
// сразу открываем нужный товар.
function handleStartParam() {
  try {
    const param = tg?.initDataUnsafe?.start_param;
    if (param && param.startsWith('product_')) {
      const productId = param.slice('product_'.length);
      if (productId) {
        router.navigate('detail', { productId, source: 'home' });
      }
    }
  } catch (e) {}
}

function hideSplash() {
  const s = document.getElementById('appSplashInit');
  if (!s) return;
  s.classList.add('fade-out');
  setTimeout(() => s.remove(), 220);
}

bootstrap();
