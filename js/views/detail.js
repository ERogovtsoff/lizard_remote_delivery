// Деталь товара.
import { t, getLang, localizedProduct } from '../i18n.js';
import { escapeHtml, formatPrice, badgeColor, copyToClipboard } from '../utils.js';
import { state, isFavExact, toggleFav, removeFav, addToCart } from '../state.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { createCarousel } from '../components/carousel.js';
import { openLightbox } from '../components/lightbox.js';
import { showConfirm } from '../components/modal.js';
import { showToast } from '../components/toast.js';
import { haptic, openBotChat, tg } from '../tg.js';
import { CONFIG } from '../config.js';

let selectedSize = null;

export async function renderDetail(opts = {}) {
  const productId = opts.productId;
  const page = document.getElementById('page-detail');
  let products = [];
  try {
    products = await api.loadProducts();
  } catch (e) {
    console.error('[detail] load failed:', e);
    page.innerHTML = `
      <div class="empty-state">
        <div class="icon">📡</div>
        <h3>${escapeHtml(t('loadErrorTitle'))}</h3>
        <p>${escapeHtml(t('loadErrorText'))}</p>
        <button class="primary-btn retry-btn" id="detailRetry">${escapeHtml(t('retry'))}</button>
      </div>`;
    const rb = document.getElementById('detailRetry');
    if (rb) rb.onclick = () => renderDetail(opts);
    return;
  }
  const prod = products.find(p => p.id === productId);
  if (!prod || prod.is_active === false) {
    page.innerHTML = `
      <div class="empty-state">
        <div class="icon">🔍</div>
        <h3>${escapeHtml(t('productGoneTitle'))}</h3>
        <p>${escapeHtml(t('productGoneText'))}</p>
        <a class="empty-state-link" id="detailGoneCatalog">${escapeHtml(t('toCatalog'))}</a>
        <a class="empty-state-link" id="detailGoneChat">${escapeHtml(t('catalogEmptyLink'))}</a>
      </div>`;
    const toCat = document.getElementById('detailGoneCatalog');
    const toChat = document.getElementById('detailGoneChat');
    if (toCat) toCat.onclick = () => router.navigate('catalog');
    if (toChat) toChat.onclick = () => router.navigate('chat');
    return;
  }
  const lang = getLang();
  const cur = state.settings.currency;
  const p = localizedProduct(prod, cur);
  const images = (prod.images && prod.images.length) ? prod.images : (prod.img ? [prod.img] : []);

  // Если размер один и он в наличии — выбираем автоматически
  if (prod.sizes && prod.sizes.length === 1) {
    const only = prod.sizes[0];
    const st = (!prod.stock || Object.keys(prod.stock).length === 0) ? Infinity : (Number(prod.stock[only]) || 0);
    selectedSize = st > 0 ? only : null;
  } else {
    selectedSize = null;
  }

  const badgeOnImage = (prod.badge_text && prod.badge_text.trim())
    ? `<div class="detail-badge-overlay" style="background:${badgeColor(prod.badge_color).bg};color:${badgeColor(prod.badge_color).fg}">${escapeHtml(prod.badge_text.trim())}</div>`
    : '';

  page.innerHTML = `
    <div class="detail-carousel-wrap">
      <div id="detailCarouselSlot"></div>
      ${badgeOnImage}
    </div>
    <div class="detail-name-row">
      <h2 class="product-detail-name">${escapeHtml(p.name)}</h2>
      <button class="detail-share-btn" id="detailShareBtn" aria-label="${escapeHtml(t('share'))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      </button>
    </div>
    <div class="product-detail-price">${escapeHtml(formatPrice(p.price, cur, lang))}</div>
    <div class="price-note">${escapeHtml(t('priceFinalNote'))}</div>
    ${p.desc ? `<p class="product-detail-desc">${escapeHtml(p.desc)}</p>` : ''}
    ${prod.sizes && prod.sizes.length > 0 ? `
      <div class="product-section">
        <h4>${escapeHtml(t('sizeChart'))}</h4>
        <div class="size-picker" id="sizePicker"></div>
      </div>
    ` : ''}
    <button class="detail-ask-btn" id="detailAskBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>${escapeHtml(t('askAboutProduct'))}</span>
    </button>
    <div class="detail-actions">
      <button class="detail-fav-btn" id="detailFavBtn" aria-label="Favorite">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>
      <button class="primary-btn" id="addToCartBtn">${escapeHtml(t('addToCart'))}</button>
    </div>
  `;

  // Карусель + лайтбокс
  const carousel = createCarousel({
    images, variant: 'full',
    onSlideClick: (idx) => openLightbox(images, idx),
  });
  document.getElementById('detailCarouselSlot').appendChild(carousel);

  // Кнопка «Поделиться» — формирует deep-link на этот товар и открывает шеринг Telegram
  const shareBtn = document.getElementById('detailShareBtn');
  if (shareBtn) shareBtn.onclick = () => shareProduct(prod, p);

  // Кнопка «Задать вопрос менеджеру» — всегда доступна, открывает чат с контекстом товара
  const askBtn = document.getElementById('detailAskBtn');
  if (askBtn) askBtn.onclick = () => {
    haptic('light');
    openBotChat('ask_' + prod.id);
  };

  // Размеры
  if (prod.sizes && prod.sizes.length > 0) {
    renderSizes(prod);
  }

  // Кнопка избранного
  updateFavBtn(prod);
  document.getElementById('detailFavBtn').onclick = () => {
    // если избранное для выбранного размера уже стоит — спрашиваем подтверждение
    const sizeKey = selectedSize || null;
    if (isFavExact(prod.id, sizeKey)) {
      showConfirm({
        icon: '❤️',
        title: t('confirmRemoveFavTitle'),
        text: t('confirmRemoveFavText'),
        yes: t('confirmYes'), no: t('confirmNo'), danger: true,
        onYes: () => {
          removeFav(prod.id, sizeKey);
          haptic('light');
          showToast(t('removedFromFav'));
          updateFavBtn(prod);
        }
      });
    } else {
      toggleFav(prod.id, sizeKey);
      haptic('light');
      showToast(t('addedToFav'));
      updateFavBtn(prod);
    }
  };

  // Добавить в корзину
  document.getElementById('addToCartBtn').onclick = () => {
    if (prod.sizes && prod.sizes.length > 0 && !selectedSize) {
      showToast(t('selectSize'));
      haptic('warning');
      return;
    }
    // Проверяем остаток: сколько этого размера уже в корзине + 1 не должно превышать stock
    const maxQty = sizeStock(prod, selectedSize);
    const inCart = state.cart
      .filter(c => c.productId === prod.id && c.size === selectedSize)
      .reduce((sum, c) => sum + c.qty, 0);
    if (inCart >= maxQty) {
      showToast(t('cartMaxQty'));
      haptic('warning');
      return;
    }
    addToCart(prod.id, selectedSize);
    haptic('success');
    showToast(t('addedToCart'));
    // обновим бейдж — это делает app.js через слушатель
    window.dispatchEvent(new CustomEvent('cart:changed'));
  };
}

// Доступное количество для размера. Если stock не задан вовсе — считаем доступным (∞).
function sizeStock(prod, sz) {
  if (!prod.stock || Object.keys(prod.stock).length === 0) return Infinity;
  // Товар без выбранного размера (нет размеров вовсе) — суммарный остаток
  if (sz == null) {
    const vals = Object.values(prod.stock);
    return vals.length ? vals.reduce((a, b) => a + (Number(b) || 0), 0) : Infinity;
  }
  return Number(prod.stock[sz]) || 0;
}

function renderSizes(prod) {
  const wrap = document.getElementById('sizePicker');
  wrap.innerHTML = '';
  prod.sizes.forEach(sz => {
    const stock = sizeStock(prod, sz);
    const soldOut = stock <= 0;
    const cell = document.createElement('div');
    cell.className = 'size-cell'
      + (selectedSize === sz ? ' selected' : '')
      + (soldOut ? ' sold-out' : '');
    cell.textContent = sz;
    if (soldOut) {
      cell.title = t('sizeSoldOut');
    } else {
      cell.onclick = () => {
        selectedSize = sz;
        renderSizes(prod);
        updateFavBtn(prod);
      };
    }
    wrap.appendChild(cell);
  });
}

function updateFavBtn(prod) {
  const btn = document.getElementById('detailFavBtn');
  if (!btn) return;
  const sizeKey = selectedSize || null;
  const fav = isFavExact(prod.id, sizeKey);
  btn.classList.toggle('active', fav);
  const svg = btn.querySelector('svg');
  svg.setAttribute('fill', fav ? 'currentColor' : 'none');
}
// Поделиться товаром: формируем deep-link на Mini App с параметром startapp,
// открывающим этот товар, и вызываем нативный шеринг Telegram.
function shareProduct(prod, p) {
  haptic('light');
  const botUser = (CONFIG.BOT_USERNAME || '').replace(/^@/, '');
  if (!botUser || botUser === 'your_shop_bot') {
    // Бот не настроен — копируем хотя бы название (на крайний случай)
    showToast(t('shareNotConfigured'), 4000);
    return;
  }
  const link = `https://t.me/${botUser}?startapp=product_${encodeURIComponent(prod.id)}`;
  const text = `${p.name} — ${formatPrice(p.price, state.settings.currency, getLang())}`;
  // Нативный шеринг через Telegram: окно «Переслать» с готовым сообщением
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
  try {
    if (tg && typeof tg.openTelegramLink === 'function') {
      tg.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, '_blank');
    }
  } catch (e) {
    // Fallback — копируем ссылку в буфер
    copyToClipboard(link).then(ok => showToast(ok ? t('shareLinkCopied') : link));
  }
}
