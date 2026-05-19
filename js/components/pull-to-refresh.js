// Pull-to-refresh со сдвигом всей страницы (как в нативных iOS-приложениях).
//
// Поведение:
//   - В верхней части страницы пользователь свайпает вниз пальцем
//   - Весь контент страницы движется вниз с резистивностью (~50% от движения пальца)
//   - Над верхней границей контента появляется индикатор (стрелка/спиннер)
//   - При отпускании:
//      * если pull >= порога → контент остаётся приспущен (виден спиннер),
//        выполняется refresh, потом плавный возврат
//      * иначе → плавный возврат в исходное положение без действия
//
// API:
//   attachPullToRefresh(scrollable, onRefresh)
//       scrollable — элемент с скроллом (обычно сам page). Должен иметь
//                    position не static.
//   detachPullToRefresh(scrollable)
//
// При повторном attach к тому же элементу старый детачится автоматически —
// поэтому функция идемпотентна и безопасна на повторный вход в страницу.

const THRESHOLD = 70;        // px движения пальца для триггера refresh
const MAX_PULL = 140;        // максимальное растяжение визуала
const RESISTANCE = 0.5;      // 1.0 = синхронно с пальцем, 0.5 = в 2 раза медленнее

const INDICATOR_SVG = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
`;

const installed = new WeakMap();

export function attachPullToRefresh(scrollable, onRefresh) {
  if (!scrollable) return;
  // Идемпотентность: если уже установлен — снимем старый
  if (installed.has(scrollable)) detachPullToRefresh(scrollable);

  if (getComputedStyle(scrollable).position === 'static') {
    scrollable.style.position = 'relative';
  }

  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  indicator.innerHTML = INDICATOR_SVG;
  scrollable.appendChild(indicator);

  let startY = 0;
  let pulling = false;          // активен ли в данный момент жест
  let pullDistance = 0;         // фактическое смещение контента (с учётом резистивности)
  let loading = false;          // выполняется ли в данный момент refresh
  let armed = false;            // палец достаточно опустился, чтобы считать жест «pull-to-refresh»

  function setTranslate(y) {
    scrollable.style.transform = y > 0 ? `translateY(${y}px)` : '';
  }

  function setIndicator(y, spinning = false) {
    if (y > 6) {
      indicator.classList.add('visible');
      indicator.style.transform = `translate(-50%, ${y - 40}px)`;
      const svg = indicator.querySelector('svg');
      if (svg && !spinning) {
        const ratio = Math.min(1, y / THRESHOLD);
        svg.style.transform = `rotate(${ratio * 360}deg)`;
      }
    } else {
      indicator.classList.remove('visible');
    }
  }

  function reset(animated = true) {
    if (animated) scrollable.classList.add('ptr-animating');
    setTranslate(0);
    indicator.classList.remove('visible', 'loading');
    indicator.style.transform = 'translate(-50%, -100%)';
    pullDistance = 0;
    armed = false;
    if (animated) {
      setTimeout(() => scrollable.classList.remove('ptr-animating'), 300);
    }
  }

  function onStart(e) {
    if (loading) return;
    // Только если контент проскроллен в самый верх
    if (window.scrollY > 0) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    pulling = true;
    armed = false;
    scrollable.classList.remove('ptr-animating');
  }

  function onMove(e) {
    if (!pulling || loading) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) {
      if (armed) {
        setTranslate(0);
        setIndicator(0);
        armed = false;
      }
      return;
    }
    // Распознаём что это вертикальный pull (а не горизонтальный свайп)
    armed = true;
    pullDistance = Math.min(MAX_PULL, dy * RESISTANCE);
    setTranslate(pullDistance);
    setIndicator(pullDistance);
  }

  async function onEnd() {
    if (!pulling || loading) {
      pulling = false;
      return;
    }
    pulling = false;
    if (!armed) return;

    if (pullDistance >= THRESHOLD) {
      // Триггерим refresh: контент остаётся приспущен, спиннер крутится
      loading = true;
      scrollable.classList.add('ptr-animating');
      setTranslate(THRESHOLD);
      setIndicator(THRESHOLD, true);
      indicator.classList.add('loading');
      setTimeout(() => scrollable.classList.remove('ptr-animating'), 300);

      try { await onRefresh(); } catch (_) {}

      // Возвращаем в исходное
      loading = false;
      reset(true);
    } else {
      reset(true);
    }
  }

  scrollable.addEventListener('touchstart', onStart, { passive: true });
  scrollable.addEventListener('touchmove', onMove, { passive: true });
  scrollable.addEventListener('touchend', onEnd);
  scrollable.addEventListener('touchcancel', onEnd);

  installed.set(scrollable, { indicator, onStart, onMove, onEnd });
}

export function detachPullToRefresh(scrollable) {
  const h = installed.get(scrollable);
  if (!h) return;
  scrollable.removeEventListener('touchstart', h.onStart);
  scrollable.removeEventListener('touchmove', h.onMove);
  scrollable.removeEventListener('touchend', h.onEnd);
  scrollable.removeEventListener('touchcancel', h.onEnd);
  if (h.indicator && h.indicator.parentNode) h.indicator.remove();
  scrollable.style.transform = '';
  scrollable.classList.remove('ptr-animating');
  installed.delete(scrollable);
}
