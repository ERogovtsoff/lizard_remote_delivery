// Skeleton-placeholder для сетки товаров.
// Показывается пока идёт первая загрузка каталога и кэш пустой.

export function createSkeletonGrid(count = 6) {
  const el = document.createElement('div');
  el.className = 'products-grid';
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'product-card skeleton-card';
    card.innerHTML = `
      <div class="skeleton-img"></div>
      <div class="product-card-info">
        <div class="skeleton-line skeleton-line-name"></div>
        <div class="skeleton-line skeleton-line-price"></div>
      </div>
    `;
    el.appendChild(card);
  }
  return el;
}
