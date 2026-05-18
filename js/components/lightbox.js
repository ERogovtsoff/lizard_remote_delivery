// Полноэкранный лайтбокс с pinch-zoom и double-tap zoom.
// Правка #2: зум должен происходить в точку касания/щипка, а не в левый верхний угол.
//
// Математика:
//   Если мы хотим, чтобы точка изображения, находившаяся под пальцем (fx, fy в координатах wrap),
//   осталась под пальцем после изменения масштаба k -> k', нужно:
//     newTx = fx - (fx - tx) * k' / k
//     newTy = fy - (fy - ty) * k' / k
//   где tx, ty — текущий transform.translate, k/k' — старый/новый scale.
//
//   transform-origin у нас 0 0, поэтому формула применима в чистом виде.

import { t } from '../i18n.js';

const MAX_SCALE = 4;
const MIN_SCALE = 1;

const state = {
  images: [],
  index: 0,
  scale: 1,
  tx: 0,
  ty: 0,
};

let wrap, img, counterEl, prevBtn, nextBtn, lightbox;

export function setupLightbox() {
  lightbox = document.getElementById('lightbox');
  wrap = document.getElementById('lightboxWrap');
  img = document.getElementById('lightboxImg');
  counterEl = document.getElementById('lightboxCounter');
  prevBtn = document.getElementById('lightboxPrev');
  nextBtn = document.getElementById('lightboxNext');

  document.getElementById('lightboxClose').onclick = closeLightbox;
  prevBtn.onclick = () => navigate(-1);
  nextBtn.onclick = () => navigate(1);

  // Восстановим оригинальные размеры после смены картинки
  img.addEventListener('load', () => {
    // Сброс трансформа при смене картинки уже произведён в showImage()
  });

  setupGestures();

  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('show')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
  });
}

export function openLightbox(images, startIndex = 0) {
  state.images = images;
  state.index = startIndex;
  lightbox.classList.add('show');
  showImage();
}

function closeLightbox() {
  lightbox.classList.remove('show');
}

function showImage() {
  img.src = state.images[state.index];
  counterEl.textContent = `${state.index + 1} / ${state.images.length}`;
  prevBtn.disabled = state.index === 0;
  nextBtn.disabled = state.index === state.images.length - 1;
  resetTransform();
}

function navigate(delta) {
  const next = state.index + delta;
  if (next < 0 || next >= state.images.length) return;
  state.index = next;
  showImage();
}

function resetTransform() {
  state.scale = 1; state.tx = 0; state.ty = 0;
  applyTransform();
}

function applyTransform() {
  img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
}

// Получает координаты точки относительно wrap (учёт его размещения на экране и border).
function getLocalPoint(clientX, clientY) {
  const rect = wrap.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

// Изменяет масштаб с центром в точке (fx, fy) — координаты относительно wrap.
function zoomAt(newScale, fx, fy) {
  newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
  if (newScale === state.scale) return;
  const k = state.scale;
  const kPrime = newScale;
  state.tx = fx - (fx - state.tx) * (kPrime / k);
  state.ty = fy - (fy - state.ty) * (kPrime / k);
  state.scale = newScale;
  if (state.scale === MIN_SCALE) { state.tx = 0; state.ty = 0; }
  applyTransform();
}

function setupGestures() {
  let mode = 'idle';     // 'idle' | 'pan' | 'pinch' | 'swipe'
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchCenter = { x: 0, y: 0 };
  let panStartTx = 0, panStartTy = 0;
  let panStartClient = { x: 0, y: 0 };
  let swipeStart = { x: 0, y: 0 };
  let lastTapTime = 0;
  let lastTapPoint = { x: 0, y: 0 };

  function distance(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function midpoint(a, b) { return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }; }

  wrap.addEventListener('touchstart', (e) => {
    const ts = e.touches;
    if (ts.length === 2) {
      mode = 'pinch';
      pinchStartDist = distance(ts[0], ts[1]);
      pinchStartScale = state.scale;
      const mid = midpoint(ts[0], ts[1]);
      pinchCenter = getLocalPoint(mid.clientX, mid.clientY);
    } else if (ts.length === 1) {
      const t0 = ts[0];
      const now = Date.now();
      const local = getLocalPoint(t0.clientX, t0.clientY);

      // Двойной тап: тапы близко по времени и по координате
      if (now - lastTapTime < 300
          && Math.abs(local.x - lastTapPoint.x) < 30
          && Math.abs(local.y - lastTapPoint.y) < 30) {
        if (state.scale > 1) {
          resetTransform();
        } else {
          zoomAt(2.5, local.x, local.y);
        }
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;
      lastTapPoint = local;

      if (state.scale > 1) {
        mode = 'pan';
        panStartTx = state.tx; panStartTy = state.ty;
        panStartClient = { x: t0.clientX, y: t0.clientY };
      } else {
        mode = 'swipe';
        swipeStart = { x: t0.clientX, y: t0.clientY };
      }
    }
  }, { passive: true });

  wrap.addEventListener('touchmove', (e) => {
    if (mode === 'pinch' && e.touches.length === 2) {
      const d = distance(e.touches[0], e.touches[1]);
      const newScale = pinchStartScale * (d / pinchStartDist);
      zoomAt(newScale, pinchCenter.x, pinchCenter.y);
      if (e.cancelable) e.preventDefault();
    } else if (mode === 'pan' && e.touches.length === 1) {
      const t0 = e.touches[0];
      state.tx = panStartTx + (t0.clientX - panStartClient.x);
      state.ty = panStartTy + (t0.clientY - panStartClient.y);
      applyTransform();
      if (e.cancelable) e.preventDefault();
    } else if (mode === 'swipe' && e.touches.length === 1) {
      const t0 = e.touches[0];
      const dx = t0.clientX - swipeStart.x;
      const dy = t0.clientY - swipeStart.y;
      if (Math.abs(dx) > Math.abs(dy) && e.cancelable) e.preventDefault();
    }
  }, { passive: false });

  wrap.addEventListener('touchend', (e) => {
    if (mode === 'swipe' && e.changedTouches.length === 1) {
      const t0 = e.changedTouches[0];
      const dx = t0.clientX - swipeStart.x;
      if (Math.abs(dx) > 50) {
        navigate(dx < 0 ? 1 : -1);
      }
    }
    if (e.touches.length === 0) mode = 'idle';
    else if (e.touches.length === 1 && mode === 'pinch') mode = 'pan';
  });

  // Десктоп — колесо мыши = зум в точку курсора
  wrap.addEventListener('wheel', (e) => {
    if (!lightbox.classList.contains('show')) return;
    e.preventDefault();
    const local = getLocalPoint(e.clientX, e.clientY);
    const k = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    zoomAt(state.scale * k, local.x, local.y);
  }, { passive: false });

  // Двойной клик мышью
  wrap.addEventListener('dblclick', (e) => {
    const local = getLocalPoint(e.clientX, e.clientY);
    if (state.scale > 1) resetTransform();
    else zoomAt(2.5, local.x, local.y);
  });
}
