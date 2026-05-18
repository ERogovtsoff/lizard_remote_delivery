// Админка каталога: список товаров, редактор с несколькими картинками, экспорт/импорт.
import { t, getLang, localizedProduct } from '../i18n.js';
import { escapeHtml, escapeAttr, formatPrice, makeId } from '../utils.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/modal.js';
import { isAdmin } from '../tg.js';
import { state } from '../state.js';

let activeTab = 'catalog';
let editingId = null;
let workingProducts = [];

export async function renderAdmin() {
  if (!isAdmin()) { router.navigate('home'); return; }

  workingProducts = await api.loadProducts();
  const page = document.getElementById('page-admin');
  page.innerHTML = `
    <h2>${escapeHtml(t('adminTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('adminSub'))}</p>
    <div class="admin-tabs">
      <button class="admin-tab ${activeTab === 'catalog' ? 'active' : ''}" data-tab="catalog">${escapeHtml(t('adminTabCatalog'))}</button>
      <button class="admin-tab ${activeTab === 'export' ? 'active' : ''}" data-tab="export">${escapeHtml(t('adminTabExport'))}</button>
    </div>
    <div id="adminBody"></div>
  `;
  page.querySelectorAll('.admin-tab').forEach(btn => {
    btn.onclick = () => { activeTab = btn.dataset.tab; editingId = null; renderAdmin(); };
  });

  if (activeTab === 'catalog') renderCatalogTab();
  else renderExportTab();
}

function renderCatalogTab() {
  const body = document.getElementById('adminBody');
  if (editingId !== null) { renderEditor(); return; }

  body.innerHTML = `
    <button class="primary-btn" id="addProdBtn">${escapeHtml(t('adminAddProduct'))}</button>
    <div class="admin-section" style="margin-top:16px"><div id="adminList"></div></div>
  `;
  document.getElementById('addProdBtn').onclick = () => { editingId = 'new'; renderAdmin(); };
  const list = document.getElementById('adminList');
  const cur = state.settings.currency;
  const lang = getLang();
  workingProducts.forEach(prod => {
    const p = localizedProduct(prod, cur);
    const row = document.createElement('div');
    row.className = 'admin-product-row';
    const img = (prod.images && prod.images[0]) || prod.img || '';
    row.innerHTML = `
      <img src="${escapeAttr(img)}" alt="">
      <div class="admin-product-info">
        <div class="admin-product-name">${escapeHtml(p.name)}</div>
        <div class="admin-product-price">${escapeHtml(formatPrice(p.price, cur, lang))}</div>
      </div>
      <div class="admin-product-actions">
        <button class="admin-icon-btn" data-act="edit" aria-label="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="admin-icon-btn danger" data-act="del" aria-label="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    `;
    row.querySelector('[data-act="edit"]').onclick = () => { editingId = prod.id; renderAdmin(); };
    row.querySelector('[data-act="del"]').onclick = () => {
      showConfirm({
        icon: '🗑️',
        title: t('adminConfirmDelete'),
        text: t('adminConfirmDeleteText'),
        yes: t('yes'), no: t('cancel'), danger: true,
        onYes: async () => {
          workingProducts = workingProducts.filter(p => p.id !== prod.id);
          await api.saveProducts(workingProducts);
          showToast(t('adminProductDeleted'));
          renderAdmin();
        }
      });
    };
    list.appendChild(row);
  });
}

function renderEditor() {
  const body = document.getElementById('adminBody');
  const isNew = editingId === 'new';
  const prod = isNew
    ? { id: makeId('p'), name_ru: '', name_en: '', desc_ru: '', desc_en: '', price_usd: 0, price_byn: 0, images: [], sizes: [] }
    : { ...workingProducts.find(p => p.id === editingId) };
  if (!prod.images) prod.images = prod.img ? [prod.img] : [];

  body.innerHTML = `
    <div class="admin-section">
      <h3>${escapeHtml(isNew ? t('adminAddProduct') : t('adminEditProduct'))}</h3>
      <div class="form-row">
        <label>${escapeHtml(t('adminFieldNameRu'))}</label>
        <input type="text" id="fNameRu" value="${escapeAttr(prod.name_ru || '')}">
      </div>
      <div class="form-row">
        <label>${escapeHtml(t('adminFieldNameEn'))}</label>
        <input type="text" id="fNameEn" value="${escapeAttr(prod.name_en || '')}">
      </div>
      <div class="form-row">
        <label>${escapeHtml(t('adminFieldImages'))}</label>
        <div class="image-editor" id="imgEditor"></div>
        <button class="image-editor-add" id="addImgBtn" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>${escapeHtml(t('adminAddImage'))}</span>
        </button>
      </div>
      <div class="form-row-pair">
        <div class="form-row">
          <label>${escapeHtml(t('adminFieldPriceUsd'))}</label>
          <input type="number" id="fPriceUsd" value="${prod.price_usd || 0}">
        </div>
        <div class="form-row">
          <label>${escapeHtml(t('adminFieldPriceByn'))}</label>
          <input type="number" id="fPriceByn" value="${prod.price_byn || 0}">
        </div>
      </div>
      <div class="form-row">
        <label>${escapeHtml(t('adminFieldSizes'))}</label>
        <input type="text" id="fSizes" value="${escapeAttr((prod.sizes || []).join(', '))}" placeholder="${escapeAttr(t('adminFieldSizesPlaceholder'))}">
      </div>
      <div class="form-row">
        <label>${escapeHtml(t('adminFieldDescRu'))}</label>
        <textarea id="fDescRu">${escapeHtml(prod.desc_ru || '')}</textarea>
      </div>
      <div class="form-row">
        <label>${escapeHtml(t('adminFieldDescEn'))}</label>
        <textarea id="fDescEn">${escapeHtml(prod.desc_en || '')}</textarea>
      </div>
      <div class="admin-form-actions">
        <button class="secondary-btn" id="cancelEditBtn">${escapeHtml(t('cancel'))}</button>
        <button class="primary-btn" id="saveProdBtn">${escapeHtml(t('adminSave'))}</button>
      </div>
    </div>
  `;

  // Динамический список картинок
  const editor = document.getElementById('imgEditor');
  const draft = { images: [...prod.images] };
  function renderImages() {
    editor.innerHTML = '';
    draft.images.forEach((url, idx) => {
      const item = document.createElement('div');
      item.className = 'image-editor-item';
      item.innerHTML = `
        <img class="image-editor-thumb" src="${escapeAttr(url || '')}" alt="">
        <input type="text" value="${escapeAttr(url)}" placeholder="${escapeAttr(t('adminImagePlaceholder'))}">
        <button class="image-editor-remove" aria-label="Remove">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      `;
      const input = item.querySelector('input');
      const thumb = item.querySelector('img');
      input.addEventListener('input', () => { draft.images[idx] = input.value; thumb.src = input.value; });
      item.querySelector('button').onclick = () => { draft.images.splice(idx, 1); renderImages(); };
      editor.appendChild(item);
    });
  }
  renderImages();
  document.getElementById('addImgBtn').onclick = () => { draft.images.push(''); renderImages(); };

  document.getElementById('cancelEditBtn').onclick = () => { editingId = null; renderAdmin(); };
  document.getElementById('saveProdBtn').onclick = async () => {
    const nameRu = document.getElementById('fNameRu').value.trim();
    const nameEn = document.getElementById('fNameEn').value.trim();
    if (!nameRu && !nameEn) { showToast(t('adminNoName')); return; }
    const sizes = document.getElementById('fSizes').value
      .split(',').map(s => s.trim()).filter(Boolean);
    const obj = {
      id: prod.id,
      name_ru: nameRu, name_en: nameEn,
      desc_ru: document.getElementById('fDescRu').value,
      desc_en: document.getElementById('fDescEn').value,
      price_usd: Number(document.getElementById('fPriceUsd').value) || 0,
      price_byn: Number(document.getElementById('fPriceByn').value) || 0,
      images: draft.images.filter(Boolean),
      sizes,
    };
    if (isNew) workingProducts.push(obj);
    else {
      const idx = workingProducts.findIndex(p => p.id === prod.id);
      if (idx >= 0) workingProducts[idx] = obj;
    }
    await api.saveProducts(workingProducts);
    showToast(t('adminProductSaved'));
    editingId = null;
    renderAdmin();
  };
}

function renderExportTab() {
  const body = document.getElementById('adminBody');
  body.innerHTML = `
    <div class="admin-section">
      <h3>${escapeHtml(t('adminExportTitle'))}</h3>
      <p class="page-sub">${escapeHtml(t('adminExportSub'))}</p>
      <button class="primary-btn" id="exportBtn">${escapeHtml(t('adminExportBtn'))}</button>
    </div>
    <div class="admin-section">
      <h3>${escapeHtml(t('adminImportTitle'))}</h3>
      <p class="page-sub">${escapeHtml(t('adminImportSub'))}</p>
      <label class="secondary-btn" style="display:block; text-align:center; cursor:pointer">
        ${escapeHtml(t('adminImportBtn'))}
        <input type="file" id="importFile" accept="application/json" style="display:none">
      </label>
    </div>
  `;
  document.getElementById('exportBtn').onclick = () => {
    const json = JSON.stringify({ catalog: workingProducts }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'catalog.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 200);
  };
  document.getElementById('importFile').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.catalog)) throw new Error('no catalog');
      workingProducts = data.catalog;
      await api.saveProducts(workingProducts);
      showToast(t('adminImported'));
      activeTab = 'catalog';
      renderAdmin();
    } catch (err) {
      showToast(t('adminImportError'));
    }
    e.target.value = '';
  };
}
