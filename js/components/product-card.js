// Карточка товара с каруселью.
// Кнопка избранного перерисовывается через единую функцию paintFavButton,
// чтобы состояние "active" всегда соответствовало реальному содержимому state.favorites.
//
// opts:
//   source       — откуда пришёл клик (для возврата по back-кнопке)
//   showSize     — подпись с размером (для карточек на странице "Избранное")
//   favSize      — если задан, тоггл изменяет именно этот размер; иначе любой
//   onChange     — callback после изменения избранного (родитель перерисует список)

import { escapeHtml, formatPrice, badgeColor } from '../utils.js';
import { localizedProduct, getLang, t } from '../i18n.js';
import { state, isFavAny, isFavExact, removeFav, toggleFav, removeFavAll } from '../state.js';
import { showConfirm } from './modal.js';
import { showToast } from './toast.js';
import { createCarousel } from './carousel.js';
import { haptic } from '../tg.js';
import { router } from '../router.js';

const HEART_SVG = '<svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';

export function createProductCard(prod, opts = {}) {
  const lang = getLang();
  const cur = state.settings.currency;
  const p = localizedProduct(prod, cur);
  const images = (prod.images && prod.images.length) ? prod.images : (prod.img ? [prod.img] : []);

  const card = document.createElement('div');
  // Размер для бейджа в избранном — только если реально задан (иначе пустой белый квадрат)
  const sizeLabel = (opts.showSize == null) ? '' : String(opts.showSize).trim();
  const hasSize = !!sizeLabel && sizeLabel !== 'null' && sizeLabel !== 'undefined';
  card.className = 'product-card' + (hasSize ? ' fav-with-size' : '');

  // Карусель
  const carousel = createCarousel({
    images,
    variant: 'mini',
    onSlideClick: () => router.navigate('detail', { productId: prod.id, source: opts.source || 'home' }),
  });
  card.appendChild(carousel);

  // Плашка товара (Топ/Хит/etc) — поверх картинки в левом верхнем углу
  if (prod.badge_text && prod.badge_text.trim()) {
    const c = badgeColor(prod.badge_color);
    const badgeEl = document.createElement('div');
    badgeEl.className = 'product-badge';
    badgeEl.style.background = c.bg;
    badgeEl.style.color = c.fg;
    badgeEl.textContent = prod.badge_text.trim();
    carousel.appendChild(badgeEl);
  }

  // Бейдж с размером (для страницы «Избранное»).
  // Показываем ТОЛЬКО если размер реально задан — иначе был пустой белый квадрат.
  if (hasSize) {
    const badge = document.createElement('div');
    badge.className = 'product-card-size';
    badge.textContent = sizeLabel;
    carousel.appendChild(badge);
  }

  // Кнопка избранного
  const favBtn = document.createElement('button');
  favBtn.className = 'product-card-fav';
  favBtn.setAttribute('aria-label', 'Favorite');
  favBtn.innerHTML = HEART_SVG;

  // Единая функция перерисовки иконки. Вызывается при создании и после каждого тоггла.
  function paintFavButton() {
    const active = opts.favSize !== undefined
      ? isFavExact(prod.id, opts.favSize)
      : isFavAny(prod.id);
    favBtn.classList.toggle('active', active);
    const svg = favBtn.querySelector('svg');
    if (svg) svg.setAttribute('fill', active ? 'currentColor' : 'none');
  }
  paintFavButton();

  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();

    // Удаление конкретного варианта (на странице «Избранное» с известным размером)
    if (opts.favSize !== undefined && isFavExact(prod.id, opts.favSize)) {
      showConfirm({
        icon: '❤️',
        title: t('confirmRemoveFavTitle'),
        text: t('confirmRemoveFavText'),
        yes: t('confirmYes'), no: t('confirmNo'), danger: true,
        onYes: () => {
          removeFav(prod.id, opts.favSize);
          haptic('light');
          showToast(t('removedFromFav'));
          paintFavButton();
          if (opts.onChange) opts.onChange();
        }
      });
      return;
    }

    // Удаление всех вариантов товара (на главной/в каталоге, без выбранного размера)
    if (isFavAny(prod.id)) {
      showConfirm({
        icon: '❤️',
        title: t('confirmRemoveFavTitle'),
        text: t('confirmRemoveFavText'),
        yes: t('confirmYes'), no: t('confirmNo'), danger: true,
        onYes: () => {
          removeFavAll(prod.id);
          haptic('light');
          showToast(t('removedFromFav'));
          paintFavButton();
          if (opts.onChange) opts.onChange();
        }
      });
      return;
    }

    // Добавление в избранное (без размера, если карточка на списке)
    toggleFav(prod.id, opts.favSize || null);
    haptic('light');
    showToast(t('addedToFav'));
    paintFavButton();
    if (opts.onChange) opts.onChange();
  });
  card.appendChild(favBtn);

  // Инфо-блок
  const info = document.createElement('div');
  info.className = 'product-card-info';

  // Доступные размеры (с ненулевым остатком) — короткой строкой под ценой.
  // Если остаток нигде не задан — показываем все размеры (без ограничений).
  let sizesLine = '';
  const sizes = prod.sizes || [];
  if (sizes.length > 0) {
    const hasStock = prod.stock && Object.keys(prod.stock).length > 0;
    const available = hasStock
      ? sizes.filter(s => (Number(prod.stock[s]) || 0) > 0)
      : sizes;
    if (available.length > 0) {
      sizesLine = `<div class="product-card-sizes">${available.map(s => escapeHtml(s)).join(' · ')}</div>`;
    } else {
      // все размеры распроданы
      sizesLine = `<div class="product-card-sizes sold-out-line">${escapeHtml(t('outOfStockShort'))}</div>`;
    }
  }

  info.innerHTML = `
    <div class="product-card-name">${escapeHtml(p.name)}</div>
    <div class="product-card-price">${formatPrice(p.price, cur, lang)}</div>
    ${sizesLine}
  `;
  card.appendChild(info);

  // Клик в любое место карточки кроме сердечка → деталь
  card.addEventListener('click', (e) => {
    if (e.target.closest('.product-card-fav')) return;
    router.navigate('detail', { productId: prod.id, source: opts.source || 'home' });
  });

  return card;
}
