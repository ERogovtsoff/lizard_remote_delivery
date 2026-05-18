// Раздел «В наличии» — каталог товаров с поиском.
// Search-state изолирован — не делится с главной.
import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { api } from '../api/index.js';
import { createSearchBar, matches } from '../components/search.js';
import { createProductCard } from '../components/product-card.js';

let searchQuery = '';

export async function renderCatalog() {
  const page = document.getElementById('page-catalog');
  page.innerHTML = `
    <h2>${escapeHtml(t('catalogTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('catalogSub'))}</p>
    <div id="catalogSearchSlot"></div>
    <div class="products-grid" id="catalogGrid"></div>
    <div class="empty-state" id="catalogEmpty" style="display:none">
      <div class="icon">📦</div>
      <h3>${escapeHtml(t('catalogEmptyTitle'))}</h3>
      <p>${escapeHtml(t('catalogEmptyText'))}</p>
    </div>
    <div class="empty-state" id="catalogSearchEmpty" style="display:none">
      <div class="icon">🔍</div>
      <h3>${escapeHtml(t('searchEmptyTitle'))}</h3>
      <p>${escapeHtml(t('searchEmptyText'))}</p>
    </div>
  `;

  const searchBar = createSearchBar({
    initialValue: searchQuery,
    onChange: (v) => { searchQuery = v; renderGrid(); }
  });
  document.getElementById('catalogSearchSlot').appendChild(searchBar);

  const products = await api.loadProducts();

  function renderGrid() {
    const grid = document.getElementById('catalogGrid');
    const empty = document.getElementById('catalogEmpty');
    const emptySearch = document.getElementById('catalogSearchEmpty');
    grid.innerHTML = '';
    if (products.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'block';
      emptySearch.style.display = 'none';
      return;
    }
    const filtered = products.filter(p => matches(p, searchQuery));
    if (filtered.length === 0) {
      grid.style.display = 'none';
      empty.style.display = 'none';
      emptySearch.style.display = 'block';
      return;
    }
    grid.style.display = 'grid';
    empty.style.display = 'none';
    emptySearch.style.display = 'none';
    filtered.forEach(p => grid.appendChild(createProductCard(p, { source: 'catalog' })));
  }
  renderGrid();
}
