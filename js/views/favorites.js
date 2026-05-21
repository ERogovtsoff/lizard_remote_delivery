// Избранное. Каждая запись = {productId, size}; один и тот же товар может
// появиться несколько раз с разными размерами. При удалении показывается подтверждение.
import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { state } from '../state.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { createProductGrid } from '../components/product-grid.js';

let grid = null;
let productsMap = new Map();

export async function renderFavorites() {
  const page = document.getElementById('page-favorites');
  page.innerHTML = `
    <h2>${escapeHtml(t('favTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('favSub'))}</p>
    <div id="favGridContainer"></div>
    <div class="empty-state" id="favEmpty" style="display:none">
      <div class="icon">❤️</div>
      <h3>${escapeHtml(t('favEmptyTitle'))}</h3>
      <p>${escapeHtml(t('favEmptyText'))}</p>
      <a class="empty-state-link" id="favEmptyLink">${escapeHtml(t('favEmptyLink'))}</a>
    </div>
    <div class="empty-state" id="favError" style="display:none">
      <div class="icon">📡</div>
      <h3>${escapeHtml(t('loadErrorTitle'))}</h3>
      <p>${escapeHtml(t('loadErrorText'))}</p>
      <button class="primary-btn retry-btn" id="favRetry">${escapeHtml(t('retry'))}</button>
    </div>
  `;

  const container = document.getElementById('favGridContainer');
  grid = createProductGrid({
    source: 'favorites',
    favSizeBy: item => item.__favSize ?? null,
    onCardChange: refreshGrid,
  });
  container.appendChild(grid.element);

  const favRetry = document.getElementById('favRetry');
  if (favRetry) favRetry.onclick = () => renderFavorites();

  try {
    const products = await api.loadProducts();
    productsMap = new Map(products.map(p => [p.id, p]));
    document.getElementById('favError').style.display = 'none';
    refreshGrid();
  } catch (e) {
    console.error('[favorites] load failed:', e);
    grid.clear();
    document.getElementById('favEmpty').style.display = 'none';
    document.getElementById('favError').style.display = 'block';
  }

  // Кнопка-ссылка в empty-state становится доступна сразу после render
  const emptyLink = document.getElementById('favEmptyLink');
  if (emptyLink) emptyLink.onclick = () => router.navigate('catalog');
}

function refreshGrid() {
  if (!grid) return;
  const empty = document.getElementById('favEmpty');

  if (state.favorites.length === 0) {
    grid.clear();
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const items = state.favorites
    .map(fav => {
      const prod = productsMap.get(fav.productId);
      if (!prod) return null;
      return { ...prod, __favSize: fav.size };
    })
    .filter(Boolean);

  grid.update(items);
}
