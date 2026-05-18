// Лайтбокс с pinch-zoom и double-tap.
//
// Модель состояния:
//   tx, ty       — текущий transform.translate (в пикселях контейнера)
//   scale        — текущий масштаб (от 1 до MAX_SCALE)
//   imgW, imgH   — реальные размеры изображения (видимая часть при scale=1)
//   wrapW, wrapH — размеры контейнера
//
// transform-origin = 0 0. Формула pinch-zoom-в-точку:
//   tx' = fx - (fx - tx) * scale' / scale
//   ty' = fy - (fy - ty) * scale' / scale
// Эта формула гарантирует, что точка изображения под пальцем останется под пальцем
// после изменения масштаба.
//
// Pan-constraints: картинку нельзя унести так, чтобы появились пустоты по краям
// (кроме случая, когда изображение по этому измерению меньше контейнера — тогда центрируем).
//
// Режимы взаимоисключающие. На touchstart выбираем режим один раз и не меняем,
// пока все пальцы не отпущены:
//   1 палец, scale=1   → swipe (между картинками)
//   1 палец, scale>1   → pan (картинка не перемещается между фото)
//   2 пальца           → pinch
// Double-tap обрабатывается отдельно через touchend по таймингам.

const MAX_SCALE = 4;
const MIN_SCALE = 1;
const DOUBLE_TAP_DELAY = 300;     // мс между тапами
const DOUBLE_TAP_DIST = 30;       // px между точками двух тапов
const SWIPE_THRESHOLD = 50;       // px горизонтального движения для перехода между фото
const TAP_MAX_MOVE = 10;          // px движения, после которого тап не считается тапом

let lightbox, wrap, img, counterEl, prevBtn, nextBtn;
let images = [];
let index = 0;

// Transform state
let scale = 1, tx = 0, ty = 0;
// Размеры изображения и контейнера для constraints
let imgW = 0, imgH = 0, wrapW = 0, wrapH = 0;

// Per-gesture state
let mode = 'idle';                // 'idle' | 'swipe' | 'pan' | 'pinch'
let touchStartTime = 0;
let startPoints = [];             // [{x, y}] на начало жеста
let startTx = 0, startTy = 0;
let startDist = 0;
let startScale = 1;
let pinchCenter = { x: 0, y: 0 };
let lastTapTime = 0;
let lastTapPoint = { x: 0, y: 0 };

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

  img.addEventListener('load', onImageLoaded);

  setupGestures();
  setupMouse();

  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('show')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigate(-1);
    if (e.key === 'ArrowRight') navigate(1);
  });
}

export function openLightbox(imgs, startIndex = 0) {
  images = imgs;
  index = startIndex;
  lightbox.classList.add('show');
  showImage();
}

function closeLightbox() {
  lightbox.classList.remove('show');
}

function showImage() {
  resetTransform();
  img.src = images[index];
  counterEl.textContent = `${index + 1} / ${images.length}`;
  prevBtn.disabled = index === 0;
  nextBtn.disabled = index === images.length - 1;
}

function onImageLoaded() {
  // После загрузки определяем реальные отображаемые размеры (с учётом object-fit аналогии)
  recalcDimensions();
  centerImage();
}

function recalcDimensions() {
  const wrapRect = wrap.getBoundingClientRect();
  wrapW = wrapRect.width;
  wrapH = wrapRect.height;

  // img — обычный <img> внутри wrap. Из-за max-width/height: 100% реальный размер
  // на экране = getBoundingClientRect (но до transform).
  // Чтобы получить размер без учёта текущего scale — временно сбросим transform.
  const prevTransform = img.style.transform;
  img.style.transform = '';
  const rect = img.getBoundingClientRect();
  // Координаты могут зависеть от tx/ty — но мы только что сбросили; чтобы получить «базовый» размер
  // достаточно посчитать через naturalSize и ограничения wrap.
  imgW = rect.width;
  imgH = rect.height;
  img.style.transform = prevTransform;
}

function centerImage() {
  // При scale = 1 и transform-origin 0 0 картинка по умолчанию находится в (0,0) wrap.
  // Чтобы центрировать (если imgW < wrapW), смещаем на (wrapW-imgW)/2.
  // Но object-fit-аналогия здесь обеспечивается CSS (max-width/max-height 100%),
  // поэтому при scale=1 картинка уже центрирована средствами flex (`align/justify-center`),
  // а transform применяется поверх. Значит для нашего transform базовая позиция = (0,0).
  scale = 1; tx = 0; ty = 0;
  applyTransform();
}

function resetTransform() {
  scale = 1; tx = 0; ty = 0;
  applyTransform();
}

function applyTransform() {
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
}

function navigate(delta) {
  const next = index + delta;
  if (next < 0 || next >= images.length) return;
  index = next;
  showImage();
}

// Получить координаты точки относительно wrap
function localPoint(clientX, clientY) {
  const rect = wrap.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

// Зум в точку (fx, fy относительно wrap). Применяет constraints.
function zoomAt(newScale, fx, fy) {
  newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
  if (Math.abs(newScale - scale) < 0.001) return;
  const k = scale, kPrime = newScale;
  tx = fx - (fx - tx) * (kPrime / k);
  ty = fy - (fy - ty) * (kPrime / k);
  scale = newScale;
  applyConstraints();
  applyTransform();
}

// Constraints: картинку нельзя унести так, чтобы появились пустоты по краям
function applyConstraints() {
  if (!imgW || !imgH) return;
  const scaledW = imgW * scale;
  const scaledH = imgH * scale;

  // Картинка позиционируется через transform от своего базового положения (центр wrap, для CSS).
  // Однако у нас transform-origin: 0 0 → translate работает от верх-лев угла img.
  // Базовая позиция img (при scale=1, tx=0, ty=0): img выровнен по центру wrap благодаря CSS flex.
  // То есть «видимое» положение img = (centerX - imgW/2 + tx, centerY - imgH/2 + ty).
  // При scale > 1 картинка расширяется от своего origin (0,0 = верх-лев угла img),
  // то есть фактически рисуется от (centerX - imgW/2 + tx) до (centerX - imgW/2 + tx + scaledW).

  const baseX = (wrapW - imgW) / 2;   // позиция img-угла без transform
  const baseY = (wrapH - imgH) / 2;

  // Левая граница картинки (с учётом transform): baseX + tx
  // Правая граница: baseX + tx + scaledW
  // Допустимый диапазон tx: чтобы при scaledW > wrapW не было щели по краям;
  //                         при scaledW <= wrapW — центрируем.

  // По X
  if (scaledW <= wrapW) {
    tx = 0; // центрировано по умолчанию
  } else {
    const minTx = wrapW - baseX - scaledW;   // правый край не должен уходить левее правого края wrap
    const maxTx = -baseX;                     // левый край не должен уходить правее левого края wrap
    if (tx < minTx) tx = minTx;
    if (tx > maxTx) tx = maxTx;
  }
  // По Y
  if (scaledH <= wrapH) {
    ty = 0;
  } else {
    const minTy = wrapH - baseY - scaledH;
    const maxTy = -baseY;
    if (ty < minTy) ty = minTy;
    if (ty > maxTy) ty = maxTy;
  }
}

// =========== GESTURES ===========

function setupGestures() {
  wrap.addEventListener('touchstart', onTouchStart, { passive: false });
  wrap.addEventListener('touchmove', onTouchMove, { passive: false });
  wrap.addEventListener('touchend', onTouchEnd);
  wrap.addEventListener('touchcancel', onTouchEnd);
}

function distance(p1, p2) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

function onTouchStart(e) {
  if (e.touches.length === 2) {
    // Pinch
    mode = 'pinch';
    const p1 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    const p2 = { x: e.touches[1].clientX, y: e.touches[1].clientY };
    startPoints = [p1, p2];
    startDist = distance(p1, p2);
    startScale = scale;
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    pinchCenter = localPoint(mid.x, mid.y);
    if (e.cancelable) e.preventDefault();
    return;
  }
  if (e.touches.length === 1) {
    const p = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    startPoints = [p];
    touchStartTime = Date.now();

    if (scale > 1) {
      // Pan
      mode = 'pan';
      startTx = tx; startTy = ty;
    } else {
      // Swipe между картинками. Не активируем pan/swipe пока не было движения —
      // touchend по короткому жесту даст double-tap или просто закрытие.
      mode = 'swipe';
      startTx = tx; startTy = ty;
    }
  }
}

function onTouchMove(e) {
  if (mode === 'pinch' && e.touches.length === 2) {
    const p1 = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    const p2 = { x: e.touches[1].clientX, y: e.touches[1].clientY };
    const d = distance(p1, p2);
    const newScale = startScale * (d / startDist);
    // Применяем pinch относительно начального center'а — это даёт стабильный зум,
    // даже если пальцы немного дрейфуют
    zoomAt(newScale, pinchCenter.x, pinchCenter.y);
    if (e.cancelable) e.preventDefault();
    return;
  }

  if (mode === 'pan' && e.touches.length === 1) {
    const p = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    tx = startTx + (p.x - startPoints[0].x);
    ty = startTy + (p.y - startPoints[0].y);
    applyConstraints();
    applyTransform();
    if (e.cancelable) e.preventDefault();
    return;
  }

  if (mode === 'swipe' && e.touches.length === 1) {
    // Для swipe просто блокируем дефолтное поведение по горизонтали;
    // переход между картинками сделаем на touchend
    const p = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    const dx = p.x - startPoints[0].x;
    const dy = p.y - startPoints[0].y;
    if (Math.abs(dx) > Math.abs(dy) && e.cancelable) e.preventDefault();
  }
}

function onTouchEnd(e) {
  if (e.touches.length > 0) {
    // Остался ещё палец на экране — переключим режим
    if (mode === 'pinch' && e.touches.length === 1) {
      // pinch → pan: фиксируем новую базовую точку
      const p = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      startPoints = [p];
      startTx = tx; startTy = ty;
      mode = scale > 1 ? 'pan' : 'swipe';
    }
    return;
  }

  // Все пальцы отпущены — обрабатываем финальный жест
  if (mode === 'swipe' && e.changedTouches.length === 1) {
    const p = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    const dx = p.x - startPoints[0].x;
    const dy = p.y - startPoints[0].y;
    const moved = Math.max(Math.abs(dx), Math.abs(dy));
    const elapsed = Date.now() - touchStartTime;

    if (moved <= TAP_MAX_MOVE && elapsed < 400) {
      // Это тап. Проверяем double-tap.
      const now = Date.now();
      const local = localPoint(p.x, p.y);
      const dtBetween = now - lastTapTime;
      const distBetween = Math.hypot(local.x - lastTapPoint.x, local.y - lastTapPoint.y);
      if (dtBetween < DOUBLE_TAP_DELAY && distBetween < DOUBLE_TAP_DIST) {
        // Double tap → toggle zoom
        if (scale > 1) resetTransform();
        else zoomAt(2.5, local.x, local.y);
        lastTapTime = 0;
      } else {
        lastTapTime = now;
        lastTapPoint = local;
      }
    } else if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      // Горизонтальный свайп → следующая/предыдущая
      navigate(dx < 0 ? 1 : -1);
    }
  }
  mode = 'idle';
}

// =========== MOUSE (десктоп) ===========

function setupMouse() {
  wrap.addEventListener('wheel', (e) => {
    if (!lightbox.classList.contains('show')) return;
    e.preventDefault();
    const local = localPoint(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    zoomAt(scale * factor, local.x, local.y);
  }, { passive: false });

  wrap.addEventListener('dblclick', (e) => {
    const local = localPoint(e.clientX, e.clientY);
    if (scale > 1) resetTransform();
    else zoomAt(2.5, local.x, local.y);
  });

  // Drag мышкой при scale > 1
  let mouseDown = false;
  let mouseStart = { x: 0, y: 0 };
  let mouseStartTx = 0, mouseStartTy = 0;
  wrap.addEventListener('mousedown', (e) => {
    if (scale <= 1) return;
    mouseDown = true;
    mouseStart = { x: e.clientX, y: e.clientY };
    mouseStartTx = tx;
    mouseStartTy = ty;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!mouseDown) return;
    tx = mouseStartTx + (e.clientX - mouseStart.x);
    ty = mouseStartTy + (e.clientY - mouseStart.y);
    applyConstraints();
    applyTransform();
  });
  document.addEventListener('mouseup', () => { mouseDown = false; });
}
