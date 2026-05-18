// Главная страница: hero-блок с CTA «Заказать из Китая», поиск и сетка товаров.
// Search-state изолирован на уровне модуля — не делится с каталогом.
import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { createSearchBar, matches } from '../components/search.js';
import { createProductCard } from '../components/product-card.js';

let searchQuery = '';

export async function renderHome() {
  const page = document.getElementById('page-home');
  page.innerHTML = `
    <div class="home-hero">
      <div class="home-hero-logo">
        <svg viewBox="0 0 64 64" fill="currentColor"><path d="M58 26c-1.2-4.6-5.4-8-10.4-8-1.8 0-3.5.5-5 1.3-1.7-2-4.3-3.3-7.1-3.3-2.5 0-4.8 1-6.5 2.6C27.3 16.9 24.8 16 22 16c-5.5 0-10 4.5-10 10 0 3.6 1.9 6.8 4.8 8.5-.5.8-.8 1.6-.8 2.5 0 3 2.5 5 6 5 .8 0 1.5-.1 2.2-.3l-3 3.5c-.5.6-.7 1.3-.7 2 0 1.7 1.3 3 3 3 .8 0 1.6-.3 2.2-.9L31 44c.8.2 1.6.4 2.5.4 2 0 3.8-.6 5.3-1.6.7 1.5 2.2 2.6 4 2.6 1.6 0 3-.8 3.8-2C50.4 41.8 56 36.5 56 30c0-.2 0-.4-.1-.6 1.3-.8 2.1-2.3 2.1-3.4zM45 28c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>
      </div>
      <h2>${escapeHtml(t('homeHeroTitle'))}</h2>
      <p>${escapeHtml(t('homeHeroText'))}</p>
      <button class="home-cta-btn" id="homeCtaBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>${escapeHtml(t('orderFromChina'))}</span>
      </button>
    </div>
    <div class="section-header"><h3>${escapeHtml(t('inStock'))}</h3></div>
    <div id="homeSearchSlot"></div>
    <div class="products-grid" id="homeGrid"></div>
    <div class="empty-state" id="homeEmpty" style="display:none">
      <div class="icon">📦</div>
      <h3>${escapeHtml(t('catalogEmptyTitle'))}</h3>
      <p>${escapeHtml(t('catalogEmptyText'))}</p>
    </div>
    <div class="empty-state" id="homeSearchEmpty" style="display:none">
      <div class="icon">🔍</div>
      <h3>${escapeHtml(t('searchEmptyTitle'))}</h3>
      <p>${escapeHtml(t('searchEmptyText'))}</p>
    </div>
  `;

  document.getElementById('homeCtaBtn').onclick = () => router.navigate('chat');

  const searchBar = createSearchBar({
    initialValue: searchQuery,
    onChange: (v) => { searchQuery = v; renderGrid(); }
  });
  document.getElementById('homeSearchSlot').appendChild(searchBar);

  const products = await api.loadProducts();

  function renderGrid() {
    const grid = document.getElementById('homeGrid');
    const empty = document.getElementById('homeEmpty');
    const emptySearch = document.getElementById('homeSearchEmpty');
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
    filtered.forEach(p => grid.appendChild(createProductCard(p, { source: 'home' })));
  }
  renderGrid();
}
