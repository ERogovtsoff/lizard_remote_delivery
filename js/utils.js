// Общие хелперы.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}
export const escapeAttr = escapeHtml;

export function formatPrice(price, currency, lang) {
  const locale = lang === 'ru' ? 'ru-RU' : 'en-US';
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(price || 0);
  return currency === 'USD' ? `$${formatted}` : `${formatted} BYN`;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function formatDate(iso, lang) {
  return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  }).format(new Date(iso));
}

export function formatDayHeader(date, lang) {
  return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-US', {
    day: 'numeric', month: 'long'
  }).format(date);
}

// Уникальный id (для черновика, до сохранения в БД)
export function makeId(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Скопировать текст в буфер. Возвращает Promise<boolean> — успешно ли.
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback через временный textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// Фиксированная палитра цветов плашек (бейджей) товаров.
// Ключ хранится в БД (products.badge_color), значения — фон и цвет текста.
export const BADGE_COLORS = {
  red:    { bg: '#e74c3c', fg: '#ffffff', label: 'Красный' },
  orange: { bg: '#f39c12', fg: '#ffffff', label: 'Оранжевый' },
  green:  { bg: '#2ecc71', fg: '#ffffff', label: 'Зелёный' },
  blue:   { bg: '#3498db', fg: '#ffffff', label: 'Синий' },
  gold:   { bg: '#d4af37', fg: '#1a1a1a', label: 'Золотой' },
  black:  { bg: '#1a1a1a', fg: '#ffffff', label: 'Чёрный' },
  accent: { bg: '#01C2C3', fg: '#ffffff', label: 'Бирюзовый' },
};

// Вернуть {bg, fg} для ключа цвета. Дефолт — accent.
export function badgeColor(key) {
  return BADGE_COLORS[key] || BADGE_COLORS.accent;
}

// ====================== Картинки товаров ======================
// Единый помощник для <img> товара: lazy-loading, асинхронное декодирование,
// плавное появление и fallback при битой ссылке.
//
// Использование: imageHtml(src, { className, alt, eager })
//   eager=true — для первого экрана (детальная, главное фото), без lazy.
//
// Класс product-img управляет плейсхолдером и переходом (см. styles.css).
// onload снимает класс loading; onerror подставляет заглушку «нет фото».
export function imageHtml(src, opts = {}) {
  const { className = '', alt = '', eager = false } = opts;
  const cls = ('product-img loading ' + className).trim();
  const loading = eager ? 'eager' : 'lazy';
  const safeSrc = escapeAttr(src || '');
  // onerror: помечаем контейнер как сломанный, прячем сам img
  return `<img src="${safeSrc}" alt="${escapeAttr(alt)}" `
    + `class="${cls}" loading="${loading}" decoding="async" `
    + `onload="this.classList.remove('loading')" `
    + `onerror="this.classList.remove('loading');this.classList.add('img-broken')">`;
}
