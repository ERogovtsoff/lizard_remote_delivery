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
