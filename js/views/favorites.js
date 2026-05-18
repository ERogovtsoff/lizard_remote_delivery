// Избранное. Каждая запись = {productId, size}; один и тот же товар может
// появиться несколько раз с разными размерами. При удалении показывается подтверждение.
import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { state } from '../state.js';
import { api } from '../api/index.js';
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
    </div>
  `;

  const container = document.getElementById('favGridContainer');
  // Карточка избранного передаёт favSize в опции — grid использует это для key
  grid = createProductGrid({
    source: 'favorites',
    favSizeBy: item => item.__favSize ?? null,
    onCardChange: refreshGrid,
  });
  container.appendChild(grid.element);

  const products = await api.loadProducts();
  productsMap = new Map(products.map(p => [p.id, p]));
  refreshGrid();
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

  // Для grid нам нужны «продукты» — но в избранном они с привязкой к size.
  // Делаем расширенный объект на лету: { ...product, __favSize: size }
  const items = state.favorites
    .map(fav => {
      const prod = productsMap.get(fav.productId);
      if (!prod) return null;
      return { ...prod, __favSize: fav.size };
    })
    .filter(Boolean);

  grid.update(items);
}
