// Раздел «В наличии» — каталог товаров с поиском и diff-rendering.
import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { createSearchBar, matches } from '../components/search.js';
import { createProductGrid } from '../components/product-grid.js';
import { createSkeletonGrid } from '../components/skeleton.js';

let searchQuery = '';
let grid = null;
let allProducts = [];

export async function renderCatalog() {
  const page = document.getElementById('page-catalog');
  page.innerHTML = `
    <h2>${escapeHtml(t('catalogTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('catalogSub'))}</p>
    <div id="catalogSearchSlot"></div>
    <div id="catalogGridContainer"></div>
    <div class="empty-state" id="catalogEmpty" style="display:none">
      <div class="icon">📦</div>
      <h3>${escapeHtml(t('catalogEmptyTitle'))}</h3>
      <p>${escapeHtml(t('catalogEmptyText'))}</p>
      <a class="empty-state-link" id="catalogEmptyLink">${escapeHtml(t('catalogEmptyLink'))}</a>
    </div>
    <div class="empty-state" id="catalogSearchEmpty" style="display:none">
      <div class="icon">🔍</div>
      <h3>${escapeHtml(t('searchEmptyTitle'))}</h3>
      <p>${escapeHtml(t('searchEmptyText'))}</p>
      <a class="empty-state-link" id="catalogSearchEmptyLink">${escapeHtml(t('catalogEmptyLink'))}</a>
    </div>
  `;

  const searchBar = createSearchBar({
    initialValue: searchQuery,
    onChange: v => { searchQuery = v; refreshGrid(); }
  });
  document.getElementById('catalogSearchSlot').appendChild(searchBar);

  // Ссылки в empty-state
  const emptyLink = document.getElementById('catalogEmptyLink');
  const searchEmptyLink = document.getElementById('catalogSearchEmptyLink');
  if (emptyLink) emptyLink.onclick = () => router.navigate('chat');
  if (searchEmptyLink) searchEmptyLink.onclick = () => router.navigate('chat');

  const container = document.getElementById('catalogGridContainer');
  grid = createProductGrid({ source: 'catalog' });
  container.appendChild(grid.element);

  const cached = await api.loadProducts();
  if (!cached || cached.length === 0) {
    container.replaceChild(createSkeletonGrid(6), grid.element);
    allProducts = await api.loadProducts();
    container.replaceChild(grid.element, container.firstChild);
  } else {
    allProducts = cached;
  }

  refreshGrid();
}

function refreshGrid() {
  if (!grid) return;
  const empty = document.getElementById('catalogEmpty');
  const emptySearch = document.getElementById('catalogSearchEmpty');

  if (!allProducts || allProducts.length === 0) {
    grid.clear();
    empty.style.display = 'block';
    emptySearch.style.display = 'none';
    return;
  }
  const filtered = allProducts.filter(p => matches(p, searchQuery));
  if (filtered.length === 0) {
    grid.clear();
    empty.style.display = 'none';
    emptySearch.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  emptySearch.style.display = 'none';
  grid.update(filtered);
}

export async function onCatalogChanged() {
  if (!grid) return;
  allProducts = await api.loadProducts();
  refreshGrid();
}
