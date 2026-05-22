// Управление каталогом товаров в панели.
// Точечные операции (saveProduct/deleteProduct/setProductActive) — безопасно
// при параллельной работе с админкой в приложении.
import * as api from './api.js';
import { escapeHtml, makeId, BADGE_COLORS } from './utils.js';

let products = [];
let activeId = null;       // редактируемый товар
let search = '';
let draft = null;          // черновик редактируемого товара

// ============ ЗАГРУЗКА И СПИСОК ============

export async function loadCatalog() {
  try {
    products = await api.loadProducts();
  } catch (e) {
    console.error('loadCatalog failed:', e);
    products = [];
  }
  renderList();
}

function matches(p, q) {
  if (!q) return true;
  const s = q.trim().toLowerCase();
  return (p.id || '').toLowerCase().includes(s)
    || (p.name_ru || '').toLowerCase().includes(s)
    || (p.name_en || '').toLowerCase().includes(s);
}

function renderList() {
  const list = document.getElementById('catalogSideList');
  if (!list) return;
  const filtered = products.filter(p => matches(p, search));
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-hint">${products.length ? 'Ничего не найдено' : 'Товаров пока нет'}</div>`;
    return;
  }
  list.innerHTML = filtered.map(p => {
    const img = (p.images && p.images[0]) || '';
    const name = p.name_ru || p.name_en || '(без названия)';
    const hidden = p.is_active === false;
    const active = p.id === activeId ? ' active' : '';
    return `
      <div class="cat-row${active}${hidden ? ' hidden' : ''}" data-id="${escapeHtml(p.id)}">
        <div class="cat-row-img">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">` : '🖼'}</div>
        <div class="cat-row-body">
          <div class="cat-row-name">${escapeHtml(name)}</div>
          <div class="cat-row-meta">$${p.price_usd || 0}${hidden ? ' · скрыт' : ''}</div>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('.cat-row').forEach(el => {
    el.onclick = () => openEditor(el.getAttribute('data-id'));
  });
}

// ============ РЕДАКТОР ТОВАРА ============

function blankProduct() {
  return {
    id: makeId('p'), name_ru: '', name_en: '', desc_ru: '', desc_en: '',
    price_usd: 0, price_byn: 0, images: [], sizes: [], stock: {},
    is_active: true, badge_text: '', badge_color: 'accent', _isNew: true,
  };
}

export function startNewProduct() {
  draft = blankProduct();
  activeId = draft.id;
  renderEditor();
  renderList();
}

function openEditor(id) {
  const prod = products.find(p => p.id === id);
  if (!prod) return;
  // Глубокая копия в черновик
  draft = JSON.parse(JSON.stringify(prod));
  if (!Array.isArray(draft.images)) draft.images = [];
  if (!Array.isArray(draft.sizes)) draft.sizes = [];
  if (!draft.stock || typeof draft.stock !== 'object') draft.stock = {};
  activeId = id;
  renderEditor();
  renderList();
}

function renderEditor() {
  document.getElementById('catalogEditorEmpty').style.display = 'none';
  const box = document.getElementById('catalogEditor');
  box.style.display = 'block';
  const p = draft;

  // Опции цветов плашки
  const colorOpts = Object.entries(BADGE_COLORS).map(([key, c]) =>
    `<option value="${key}" ${p.badge_color === key ? 'selected' : ''}>${c.label}</option>`
  ).join('');

  box.innerHTML = `
    <div class="editor-head">
      <h2>${p._isNew ? 'Новый товар' : 'Редактирование'}</h2>
      <code class="editor-id">${escapeHtml(p.id)}</code>
    </div>

    <div class="field-grid">
      <label>Название (рус)<input type="text" id="e_name_ru" value="${escapeHtml(p.name_ru || '')}"></label>
      <label>Название (eng)<input type="text" id="e_name_en" value="${escapeHtml(p.name_en || '')}"></label>
      <label>Цена USD<input type="number" id="e_price_usd" value="${p.price_usd || 0}"></label>
      <label>Цена BYN<input type="number" id="e_price_byn" value="${p.price_byn || 0}"></label>
    </div>

    <label class="field-full">Описание (рус)<textarea id="e_desc_ru" rows="2">${escapeHtml(p.desc_ru || '')}</textarea></label>
    <label class="field-full">Описание (eng)<textarea id="e_desc_en" rows="2">${escapeHtml(p.desc_en || '')}</textarea></label>

    <div class="field-section">
      <div class="field-section-title">Фотографии (ссылки)</div>
      <div id="e_images"></div>
      <button class="btn-light" id="e_add_image">+ Добавить фото</button>
    </div>

    <div class="field-section">
      <div class="field-section-title">Размеры и остатки</div>
      <div id="e_sizes"></div>
      <button class="btn-light" id="e_add_size">+ Добавить размер</button>
      <div class="field-hint">Без размеров — товар продаётся как единое целое. Остаток 0 — размер показывается распроданным.</div>
    </div>

    <div class="field-grid">
      <label>Плашка (текст)<input type="text" id="e_badge_text" value="${escapeHtml(p.badge_text || '')}" maxlength="14" placeholder="Напр. ХИТ"></label>
      <label>Цвет плашки<select id="e_badge_color">${colorOpts}</select></label>
    </div>

    <label class="field-check">
      <input type="checkbox" id="e_is_active" ${p.is_active !== false ? 'checked' : ''}>
      Товар виден клиентам
    </label>

    <div class="editor-actions">
      <button class="btn-primary" id="e_save">Сохранить</button>
      ${p._isNew ? '' : '<button class="btn-danger" id="e_delete">Удалить</button>'}
      <span class="editor-status" id="e_status"></span>
    </div>
  `;

  renderImages();
  renderSizes();

  document.getElementById('e_add_image').onclick = () => { draft.images.push(''); renderImages(); };
  document.getElementById('e_add_size').onclick = () => { addSizeRow(); };
  document.getElementById('e_save').onclick = saveDraft;
  const delBtn = document.getElementById('e_delete');
  if (delBtn) delBtn.onclick = removeDraft;
}

function renderImages() {
  const wrap = document.getElementById('e_images');
  wrap.innerHTML = draft.images.map((url, i) => `
    <div class="img-row">
      <div class="img-thumb">${url ? `<img src="${escapeHtml(url)}" alt="">` : '🖼'}</div>
      <input type="text" class="img-input" data-i="${i}" value="${escapeHtml(url)}" placeholder="https://...">
      <button class="img-del" data-i="${i}">✕</button>
    </div>`).join('');
  wrap.querySelectorAll('.img-input').forEach(inp => {
    inp.oninput = () => {
      draft.images[Number(inp.getAttribute('data-i'))] = inp.value.trim();
      // обновим превью рядом
      const thumb = inp.previousElementSibling;
      if (inp.value.trim()) thumb.innerHTML = `<img src="${escapeHtml(inp.value.trim())}" alt="">`;
      else thumb.textContent = '🖼';
    };
  });
  wrap.querySelectorAll('.img-del').forEach(btn => {
    btn.onclick = () => { draft.images.splice(Number(btn.getAttribute('data-i')), 1); renderImages(); };
  });
}

function renderSizes() {
  const wrap = document.getElementById('e_sizes');
  // sizes — массив, stock — объект {size: qty}
  wrap.innerHTML = draft.sizes.map((sz, i) => `
    <div class="size-row">
      <input type="text" class="size-name" data-i="${i}" value="${escapeHtml(sz)}" placeholder="Размер (M, 42…)">
      <input type="number" class="size-qty" data-i="${i}" value="${Number(draft.stock[sz]) || 0}" placeholder="шт" min="0">
      <button class="size-del" data-i="${i}">✕</button>
    </div>`).join('');
  wrap.querySelectorAll('.size-name').forEach(inp => {
    inp.oninput = () => {
      const i = Number(inp.getAttribute('data-i'));
      const old = draft.sizes[i];
      const val = inp.value.trim();
      const qty = draft.stock[old] || 0;
      delete draft.stock[old];
      draft.sizes[i] = val;
      if (val) draft.stock[val] = qty;
    };
  });
  wrap.querySelectorAll('.size-qty').forEach(inp => {
    inp.oninput = () => {
      const i = Number(inp.getAttribute('data-i'));
      const sz = draft.sizes[i];
      if (sz) draft.stock[sz] = Math.max(0, parseInt(inp.value) || 0);
    };
  });
  wrap.querySelectorAll('.size-del').forEach(btn => {
    btn.onclick = () => {
      const i = Number(btn.getAttribute('data-i'));
      const sz = draft.sizes[i];
      delete draft.stock[sz];
      draft.sizes.splice(i, 1);
      renderSizes();
    };
  });
}

function addSizeRow() {
  draft.sizes.push('');
  renderSizes();
}

async function saveDraft() {
  // Считываем поля
  draft.name_ru = document.getElementById('e_name_ru').value.trim();
  draft.name_en = document.getElementById('e_name_en').value.trim();
  draft.desc_ru = document.getElementById('e_desc_ru').value;
  draft.desc_en = document.getElementById('e_desc_en').value;
  draft.price_usd = Number(document.getElementById('e_price_usd').value) || 0;
  draft.price_byn = Number(document.getElementById('e_price_byn').value) || 0;
  draft.badge_text = document.getElementById('e_badge_text').value.trim();
  draft.badge_color = document.getElementById('e_badge_color').value;
  draft.is_active = document.getElementById('e_is_active').checked;
  // Чистим пустые фото и размеры
  draft.images = draft.images.filter(Boolean);
  const cleanSizes = [];
  const cleanStock = {};
  draft.sizes.forEach(s => {
    const sz = (s || '').trim();
    if (!sz) return;
    cleanSizes.push(sz);
    cleanStock[sz] = Math.max(0, Number(draft.stock[sz]) || 0);
  });
  draft.sizes = cleanSizes;
  draft.stock = cleanStock;

  if (!draft.name_ru && !draft.name_en) {
    setStatus('Укажите название товара', true);
    return;
  }

  const btn = document.getElementById('e_save');
  btn.disabled = true;
  setStatus('Сохраняем…');
  try {
    await api.saveProduct(draft);
    draft._isNew = false;
    setStatus('Сохранено ✓');
    await loadCatalog();
  } catch (e) {
    console.error(e);
    setStatus('Ошибка сохранения', true);
  } finally {
    btn.disabled = false;
  }
}

async function removeDraft() {
  if (!confirm('Удалить товар безвозвратно?')) return;
  const btn = document.getElementById('e_delete');
  btn.disabled = true;
  try {
    await api.deleteProduct(draft.id);
    activeId = null;
    draft = null;
    document.getElementById('catalogEditor').style.display = 'none';
    document.getElementById('catalogEditorEmpty').style.display = 'flex';
    await loadCatalog();
  } catch (e) {
    console.error(e);
    setStatus('Ошибка удаления', true);
    btn.disabled = false;
  }
}

function setStatus(text, isError) {
  const el = document.getElementById('e_status');
  if (!el) return;
  el.textContent = text;
  el.className = 'editor-status' + (isError ? ' error' : '');
}

// ============ ВНЕШНИЙ API МОДУЛЯ ============

export function setupCatalog() {
  document.getElementById('catalogAddBtn').onclick = startNewProduct;
  const searchInput = document.getElementById('catalogSearch');
  searchInput.oninput = () => { search = searchInput.value; renderList(); };
}
