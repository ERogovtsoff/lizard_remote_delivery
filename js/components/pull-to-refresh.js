// Pull-to-refresh: жест свайпа вниз в начале страницы вызывает refresh.
//
// Работает только когда страница прокручена в самый верх (window.scrollY === 0)
// и в текущей странице активен PTR. Поверх стандартного скролла, но индикатор
// показывается только при достаточном смещении.
//
// API:
//   attachPullToRefresh(pageElement, onRefresh)
//   detachPullToRefresh(pageElement)
//   onRefresh — async () => void; пока выполняется, спиннер крутится.

const THRESHOLD = 70;          // px пройти пальцем чтобы триггернуть refresh
const MAX_PULL = 120;          // максимальное растяжение для визуала

const INDICATOR_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
`;

// Удерживаем по одному обработчику на каждую страницу — чтобы attach был идемпотентен
const installed = new WeakMap();

export function attachPullToRefresh(page, onRefresh) {
  if (!page || installed.has(page)) return;

  // Индикатор размещаем относительно page; page нужен position для абсолютного позиционирования.
  if (getComputedStyle(page).position === 'static') {
    page.style.position = 'relative';
  }
  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.innerHTML = INDICATOR_SVG;
  page.appendChild(indicator);

  let startY = 0;
  let pulling = false;
  let pullDistance = 0;
  let loading = false;

  function onStart(e) {
    if (loading) return;
    if (window.scrollY > 0) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pulling = true;
    pullDistance = 0;
  }

  function onMove(e) {
    if (!pulling || loading) return;
    const y = e.touches[0].clientY;
    const dy = y - startY;
    if (dy <= 0) {
      indicator.classList.remove('visible');
      return;
    }
    // Резистивное движение — индикатор следует пальцу с убывающей скоростью
    pullDistance = Math.min(MAX_PULL, dy * 0.5);
    if (pullDistance > 6) {
      indicator.classList.add('visible');
      indicator.style.transform = `translate(-50%, ${pullDistance - 32}px)`;
      const svg = indicator.querySelector('svg');
      const ratio = Math.min(1, pullDistance / THRESHOLD);
      svg.style.transform = `rotate(${ratio * 360}deg)`;
    } else {
      indicator.classList.remove('visible');
    }
  }

  async function onEnd() {
    if (!pulling || loading) {
      pulling = false;
      return;
    }
    pulling = false;
    if (pullDistance >= THRESHOLD) {
      loading = true;
      indicator.classList.add('loading', 'visible');
      indicator.style.transform = `translate(-50%, ${THRESHOLD - 32}px)`;
      try {
        await onRefresh();
      } catch (_) {}
      loading = false;
      indicator.classList.remove('loading');
      // Плавно убираем индикатор
      indicator.style.transform = `translate(-50%, -100%)`;
      setTimeout(() => indicator.classList.remove('visible'), 250);
    } else {
      indicator.classList.remove('visible');
      indicator.style.transform = `translate(-50%, -100%)`;
    }
    pullDistance = 0;
  }

  page.addEventListener('touchstart', onStart, { passive: true });
  page.addEventListener('touchmove', onMove, { passive: true });
  page.addEventListener('touchend', onEnd);
  page.addEventListener('touchcancel', onEnd);

  installed.set(page, { indicator, onStart, onMove, onEnd });
}

export function detachPullToRefresh(page) {
  const h = installed.get(page);
  if (!h) return;
  page.removeEventListener('touchstart', h.onStart);
  page.removeEventListener('touchmove', h.onMove);
  page.removeEventListener('touchend', h.onEnd);
  page.removeEventListener('touchcancel', h.onEnd);
  h.indicator.remove();
  installed.delete(page);
}
