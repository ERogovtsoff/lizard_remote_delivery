// Карусель изображений. Используется в карточке товара (mini) и на деталке (full).
//
// Поведение свайпа:
//   - 1 картинка → touch-обработчики НЕ навешиваются, точек и счётчика нет
//   - попытка свайпнуть влево от первой / вправо от последней — резистивное движение
//     (rubber band: палец двигается, картинка следует только на ~25% дельты, потом
//     отпружинивает в исходное)
//
// onSlideClick(index): открыть лайтбокс при тапе на слайд
import { escapeAttr } from '../utils.js';

const SWIPE_THRESHOLD_RATIO = 0.2;   // палец прошёл > 20% ширины — листаем
const RUBBER_BAND_RATIO = 0.25;      // на границе следуем только 25% движения пальца

export function createCarousel({ images, variant = 'full', onSlideClick }) {
  const root = document.createElement('div');
  root.className = variant === 'mini' ? 'product-card-media' : 'product-carousel';

  if (!images || images.length === 0) {
    return root;
  }

  const track = document.createElement('div');
  track.className = variant === 'mini' ? 'product-card-track' : 'carousel-track';
  track.innerHTML = images.map(src =>
    variant === 'mini'
      ? `<div class="product-card-slide"><img src="${escapeAttr(src)}" alt="" loading="lazy"></div>`
      : `<div class="carousel-slide"><img src="${escapeAttr(src)}" alt=""></div>`
  ).join('');
  root.appendChild(track);

  // Индикаторы — только если картинок больше одной
  let dots = null, counter = null;
  if (images.length > 1) {
    if (variant === 'full') {
      counter = document.createElement('div');
      counter.className = 'carousel-counter';
      counter.textContent = `1 / ${images.length}`;
      root.appendChild(counter);
    }
    dots = document.createElement('div');
    dots.className = variant === 'mini' ? 'product-card-dots' : 'carousel-dots';
    dots.innerHTML = images.map((_, i) =>
      variant === 'mini'
        ? `<div class="dot ${i === 0 ? 'active' : ''}"></div>`
        : `<div class="carousel-dot ${i === 0 ? 'active' : ''}"></div>`
    ).join('');
    root.appendChild(dots);
  }

  let index = 0;

  function update() {
    track.style.transform = `translateX(${-index * 100}%)`;
    if (dots) {
      const sel = variant === 'mini' ? '.dot' : '.carousel-dot';
      dots.querySelectorAll(sel).forEach((d, i) => d.classList.toggle('active', i === index));
    }
    if (counter) counter.textContent = `${index + 1} / ${images.length}`;
  }

  // Свайп активируется только при > 1 картинке. Иначе слайдинг невозможен.
  if (images.length > 1) {
    let startX = 0, startY = 0, currentX = 0, dragging = false, isHorizontal = false;
    let trackWidth = 0;

    function onStart(e) {
      const touch = e.touches[0];
      startX = touch.clientX; startY = touch.clientY; currentX = 0;
      dragging = true; isHorizontal = false;
      trackWidth = track.offsetWidth;
      track.classList.add('dragging');
    }
    function onMove(e) {
      if (!dragging) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (!isHorizontal) {
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
          isHorizontal = Math.abs(dx) > Math.abs(dy);
        }
      }
      if (isHorizontal) {
        if (e.cancelable) e.preventDefault();
        currentX = dx;
        // Rubber band на границах: если пытаемся свайпнуть туда, где нет картинок —
        // следуем только частично, и палец «упирается» в границу
        let effectiveDx = dx;
        const atFirst = index === 0;
        const atLast = index === images.length - 1;
        if ((atFirst && dx > 0) || (atLast && dx < 0)) {
          effectiveDx = dx * RUBBER_BAND_RATIO;
        }
        const offset = -index * trackWidth + effectiveDx;
        track.style.transform = `translateX(${offset}px)`;
      }
    }
    function onEnd() {
      if (!dragging) return;
      dragging = false;
      track.classList.remove('dragging');
      if (isHorizontal) {
        const threshold = trackWidth * SWIPE_THRESHOLD_RATIO;
        if (currentX < -threshold && index < images.length - 1) index++;
        else if (currentX > threshold && index > 0) index--;
      }
      // CSS-transition вернёт track в позицию (или зафиксирует новую) плавно
      update();
    }

    track.addEventListener('touchstart', onStart, { passive: true });
    track.addEventListener('touchmove', onMove, { passive: false });
    track.addEventListener('touchend', onEnd);
    track.addEventListener('touchcancel', onEnd);
  }

  // Клик/тап по слайду (всегда, даже если картинка одна)
  if (onSlideClick) {
    const slides = track.querySelectorAll(variant === 'mini' ? '.product-card-slide' : '.carousel-slide');
    slides.forEach((slide) => {
      let downX = 0, downY = 0, downT = 0;
      slide.addEventListener('touchstart', (e) => {
        const tp = e.touches[0];
        downX = tp.clientX; downY = tp.clientY; downT = Date.now();
      }, { passive: true });
      slide.addEventListener('touchend', (e) => {
        const tp = e.changedTouches[0];
        const dx = Math.abs(tp.clientX - downX);
        const dy = Math.abs(tp.clientY - downY);
        const elapsed = Date.now() - downT;
        if (dx < 8 && dy < 8 && elapsed < 400) onSlideClick(index);
      });
      slide.addEventListener('click', () => {
        if (!('ontouchstart' in window)) onSlideClick(index);
      });
    });
  }

  update();
  return root;
}
