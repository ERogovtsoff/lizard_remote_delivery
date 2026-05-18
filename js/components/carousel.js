// Карусель изображений. Используется в карточке товара (mini) и на деталке (full).
// Параметры:
//   images: string[]
//   variant: 'mini' (без счётчика, маленькие точки) | 'full' (счётчик + большие точки)
//   onSlideClick: (index) => void   (опционально — открыть лайтбокс)
// Возвращает корневой DOM элемент.
import { escapeAttr } from '../utils.js';

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

  // Индикаторы
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
  let startX = 0, startY = 0, currentX = 0, dragging = false, isHorizontal = false;
  let trackWidth = 0;

  function update() {
    track.style.transform = `translateX(${-index * 100}%)`;
    if (dots) {
      const sel = variant === 'mini' ? '.dot' : '.carousel-dot';
      dots.querySelectorAll(sel).forEach((d, i) => d.classList.toggle('active', i === index));
    }
    if (counter) counter.textContent = `${index + 1} / ${images.length}`;
  }

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
      const offset = (-index * trackWidth + dx);
      track.style.transform = `translateX(${offset}px)`;
    }
  }
  function onEnd() {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('dragging');
    if (isHorizontal) {
      const threshold = trackWidth * 0.2;
      if (currentX < -threshold && index < images.length - 1) index++;
      else if (currentX > threshold && index > 0) index--;
    }
    update();
  }

  track.addEventListener('touchstart', onStart, { passive: true });
  track.addEventListener('touchmove', onMove, { passive: false });
  track.addEventListener('touchend', onEnd);
  track.addEventListener('touchcancel', onEnd);

  // Клик/тап по слайду
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
      slide.addEventListener('click', (e) => {
        // десктоп
        if (!('ontouchstart' in window)) onSlideClick(index);
      });
    });
  }

  update();
  return root;
}
