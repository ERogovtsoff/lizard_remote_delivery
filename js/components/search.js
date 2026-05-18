// Поиск-бар. Каждая страница (home, catalog) держит свой экземпляр с собственным
// search-state на уровне модуля — поэтому запросы между ними не делятся.
import { escapeHtml } from '../utils.js';
import { t } from '../i18n.js';

export function createSearchBar({ initialValue = '', onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'search-bar';
  wrap.innerHTML = `
    <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input type="text" placeholder="${escapeHtml(t('searchPlaceholder'))}" autocomplete="off" value="${escapeHtml(initialValue)}">
    <button class="search-clear ${initialValue ? 'show' : ''}" aria-label="Clear">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>`;
  const input = wrap.querySelector('input');
  const clear = wrap.querySelector('.search-clear');

  input.addEventListener('input', () => {
    clear.classList.toggle('show', !!input.value);
    onChange(input.value);
  });
  clear.addEventListener('click', () => {
    input.value = '';
    clear.classList.remove('show');
    onChange('');
  });

  return wrap;
}

// Поиск по русскому и английскому названию (case-insensitive substring match)
export function matches(prod, q) {
  if (!q) return true;
  const norm = q.toLowerCase().trim();
  if (!norm) return true;
  return [prod.name_ru, prod.name_en]
    .filter(Boolean)
    .some(s => s.toLowerCase().includes(norm));
}
