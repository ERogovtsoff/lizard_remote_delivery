// Карточка товара. С каруселью в превью (правка #8).
// Опционально показывает выбранный размер (для избранного, правка #3).
import { escapeHtml, escapeAttr, formatPrice } from '../utils.js';
import { localizedProduct, getLang, t } from '../i18n.js';
import { state, isFavAny, isFavExact, removeFav, toggleFav, saveState } from '../state.js';
import { showConfirm } from './modal.js';
import { showToast } from './toast.js';
import { createCarousel } from './carousel.js';
import { openLightbox } from './lightbox.js';
import { haptic } from '../tg.js';
import { router } from '../router.js';

// opts: { source, showSize: 'size to display in badge', favSize: 'size to use for fav-toggle' }
export function createProductCard(prod, opts = {}) {
  const lang = getLang();
  const cur = state.settings.currency;
  const p = localizedProduct(prod, cur);
  const images = (prod.images && prod.images.length) ? prod.images : (prod.img ? [prod.img] : []);

  const card = document.createElement('div');
  card.className = 'product-card' + (opts.showSize ? ' fav-with-size' : '');

  // Карусель (или просто фон если картинок нет)
  const carousel = createCarousel({
    images,
    variant: 'mini',
    // Клик по слайду — открывает карточку (как обычный клик), не лайтбокс
    onSlideClick: () => router.navigate('detail', { productId: prod.id, source: opts.source || 'home' }),
  });
  card.appendChild(carousel);

  // Размер-бейдж (для избранного)
  if (opts.showSize) {
    const badge = document.createElement('div');
    badge.className = 'product-card-size';
    badge.textContent = opts.showSize;
    carousel.appendChild(badge);
  }

  // Сердечко
  const fav = opts.favSize !== undefined
    ? isFavExact(prod.id, opts.favSize)
    : isFavAny(prod.id);
  const favBtn = document.createElement('button');
  favBtn.className = 'product-card-fav' + (fav ? ' active' : '');
  favBtn.setAttribute('aria-label', 'Favorite');
  favBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
  favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Если карточка показывает конкретный размер из избранного — снимаем именно его.
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
          if (opts.onChange) opts.onChange();
        }
      });
      return;
    }
    // На карточке без явного размера — удаление всех вариантов товара из избранного
    if (isFavAny(prod.id)) {
      showConfirm({
        icon: '❤️',
        title: t('confirmRemoveFavTitle'),
        text: t('confirmRemoveFavText'),
        yes: t('confirmYes'), no: t('confirmNo'), danger: true,
        onYes: () => {
          state.favorites = state.favorites.filter(f => f.productId !== prod.id);
          saveState();
          haptic('light');
          showToast(t('removedFromFav'));
          if (opts.onChange) opts.onChange();
        }
      });
    } else {
      toggleFav(prod.id, opts.favSize || null);
      haptic('light');
      showToast(t('addedToFav'));
      favBtn.classList.add('active');
      favBtn.querySelector('svg').setAttribute('fill', 'currentColor');
      if (opts.onChange) opts.onChange();
    }
  });
  card.appendChild(favBtn);

  // Инфо-блок
  const info = document.createElement('div');
  info.className = 'product-card-info';
  info.innerHTML = `
    <div class="product-card-name">${escapeHtml(p.name)}</div>
    <div class="product-card-price">${formatPrice(p.price, cur, lang)}</div>
  `;
  card.appendChild(info);

  // Клик в любое место карточки кроме сердечка → деталь
  card.addEventListener('click', (e) => {
    if (e.target.closest('.product-card-fav')) return;
    router.navigate('detail', { productId: prod.id, source: opts.source || 'home' });
  });

  return card;
}
