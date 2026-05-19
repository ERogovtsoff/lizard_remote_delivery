// Главная страница.
//
// Layout:
//   1. Заголовок + подзаголовок (что мы делаем)
//   2. Блок партнёрских маркетплейсов: большой POIZON сверху + Pinduoduo и Taobao снизу
//   3. Список преимуществ (компактно)
//   4. CTA-кнопка «Заказать товар»
//   5. Ссылка-fallback «Или примерь уже сегодня — Смотреть наличие»
//
// Всё помещается на один экран без вертикального скролла на стандартных мобильных
// экранах (390x844 iPhone, 412x914 Android). Layout — flex column с авто-распределением.

import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { router } from '../router.js';

export async function renderHome() {
  const page = document.getElementById('page-home');
  page.innerHTML = `
    <div class="home-screen">
      <div class="home-top">
        <h1 class="home-title">${escapeHtml(t('homeHeroTitle'))}</h1>
        <p class="home-subtitle">${escapeHtml(t('homeHeroText'))}</p>
      </div>

      <div class="home-partners">
        <div class="partner-big">
          <img src="./assets/partner-poizon.png" alt="POIZON" onerror="this.style.display='none'; this.parentNode.classList.add('no-img')" />
          <span class="partner-fallback">POIZON</span>
        </div>
        <div class="partner-row">
          <div class="partner-small partner-pdd">
            <img src="./assets/partner-pinduoduo.png" alt="Pinduoduo" onerror="this.style.display='none'; this.parentNode.classList.add('no-img')" />
            <span class="partner-fallback">拼多多</span>
          </div>
          <div class="partner-small partner-tb">
            <img src="./assets/partner-taobao.png" alt="Taobao" onerror="this.style.display='none'; this.parentNode.classList.add('no-img')" />
            <span class="partner-fallback">淘宝<br>Taobao</span>
          </div>
        </div>
      </div>

      <ul class="home-features">
        <li>
          <div class="home-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7l-8 10-4-4"/><path d="M4 12v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2"/></svg>
          </div>
          <div class="home-feature-text">
            <div class="home-feature-title">${escapeHtml(t('homeFeature2Title'))}</div>
            <div class="home-feature-sub">${escapeHtml(t('homeFeature2Text'))}</div>
          </div>
        </li>
        <li>
          <div class="home-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="14" height="11"/><polygon points="15 10 19 10 22 13 22 17 15 17 15 10"/><circle cx="5.5" cy="18.5" r="1.8"/><circle cx="17.5" cy="18.5" r="1.8"/></svg>
          </div>
          <div class="home-feature-text">
            <div class="home-feature-title">${escapeHtml(t('homeFeature3Title'))}</div>
            <div class="home-feature-sub">${escapeHtml(t('homeFeature3Text'))}</div>
          </div>
        </li>
      </ul>

      <div class="home-bottom">
        <button class="home-cta-btn" id="homeCtaBtn">
          ${escapeHtml(t('orderFromChina'))}
        </button>
        <a class="home-instock-link" id="homeInStockLink">
          <span class="home-instock-text">${escapeHtml(t('homeInStockTitle'))} —</span>
          <span class="home-instock-action">${escapeHtml(t('homeInStockLink'))}</span>
        </a>
      </div>
    </div>
  `;

  document.getElementById('homeCtaBtn').onclick = () => router.navigate('chat');
  document.getElementById('homeInStockLink').onclick = () => router.navigate('catalog');
}

export function onCatalogChanged() {}
