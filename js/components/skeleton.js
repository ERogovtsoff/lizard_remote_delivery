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

// Skeleton-placeholder для списка истории заказов/обращений.
export function createSkeletonList(count = 3) {
  const el = document.createElement('div');
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'history-item skeleton-card';
    card.innerHTML = `
      <div class="skeleton-line" style="width:40%;height:14px;margin-bottom:10px"></div>
      <div class="skeleton-line" style="width:70%;height:12px;margin-bottom:6px"></div>
      <div class="skeleton-line" style="width:55%;height:12px"></div>
    `;
    el.appendChild(card);
  }
  return el;
}
