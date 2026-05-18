// Избранное. Каждая карточка хранит productId + size (если выбран);
// при удалении показывается подтверждение.
import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { state } from '../state.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { createProductCard } from '../components/product-card.js';

export async function renderFavorites() {
  const page = document.getElementById('page-favorites');
  page.innerHTML = `
    <h2>${escapeHtml(t('favTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('favSub'))}</p>
    <div class="products-grid" id="favGrid"></div>
    <div class="empty-state" id="favEmpty" style="display:none">
      <div class="icon">❤️</div>
      <h3>${escapeHtml(t('favEmptyTitle'))}</h3>
      <p>${escapeHtml(t('favEmptyText'))}</p>
    </div>
  `;
  const products = await api.loadProducts();
  const map = new Map(products.map(p => [p.id, p]));

  function renderGrid() {
    const grid = document.getElementById('favGrid');
    const empty = document.getElementById('favEmpty');
    grid.innerHTML = '';
    if (state.favorites.length === 0) {
      grid.style.display = 'none'; empty.style.display = 'block'; return;
    }
    grid.style.display = 'grid'; empty.style.display = 'none';

    state.favorites.forEach(fav => {
      const prod = map.get(fav.productId);
      if (!prod) return;
      const card = createProductCard(prod, {
        source: 'favorites',
        showSize: fav.size || undefined,
        favSize: fav.size,           // тоггл будет работать с этим конкретным размером
        onChange: renderGrid,
      });
      grid.appendChild(card);
    });
  }
  renderGrid();
}
