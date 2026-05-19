// Главная страница.
// Основная цель — направить клиента в «Заказать» (доставка из Китая).
// Вторичный путь — раздел «В наличии» (товары для примерки в Беларуси).
// Подробности — в онбординге; здесь всё сжато под один экран без скролла.

import { t } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { router } from '../router.js';

export async function renderHome() {
  const page = document.getElementById('page-home');
  page.innerHTML = `
    <div class="home-screen">
      <div class="home-hero">
        <div class="home-brand-mark">
          <svg viewBox="0 0 64 64" fill="currentColor"><path d="M58 26c-1.2-4.6-5.4-8-10.4-8-1.8 0-3.5.5-5 1.3-1.7-2-4.3-3.3-7.1-3.3-2.5 0-4.8 1-6.5 2.6C27.3 16.9 24.8 16 22 16c-5.5 0-10 4.5-10 10 0 3.6 1.9 6.8 4.8 8.5-.5.8-.8 1.6-.8 2.5 0 3 2.5 5 6 5 .8 0 1.5-.1 2.2-.3l-3 3.5c-.5.6-.7 1.3-.7 2 0 1.7 1.3 3 3 3 .8 0 1.6-.3 2.2-.9L31 44c.8.2 1.6.4 2.5.4 2 0 3.8-.6 5.3-1.6.7 1.5 2.2 2.6 4 2.6 1.6 0 3-.8 3.8-2C50.4 41.8 56 36.5 56 30c0-.2 0-.4-.1-.6 1.3-.8 2.1-2.3 2.1-3.4zM45 28c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>
        </div>
        <h1 class="home-title">${escapeHtml(t('homeHeroTitle'))}</h1>
        <p class="home-subtitle">${escapeHtml(t('homeHeroText'))}</p>
      </div>

      <ul class="home-features">
        <li>
          <div class="home-feature-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
          </div>
          <div class="home-feature-text">
            <div class="home-feature-title">${escapeHtml(t('homeFeature1Title'))}</div>
            <div class="home-feature-sub">${escapeHtml(t('homeFeature1Text'))}</div>
          </div>
        </li>
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

      <button class="home-cta-btn" id="homeCtaBtn">
        ${escapeHtml(t('orderFromChina'))}
      </button>

      <a class="home-instock-link" id="homeInStockLink">
        <span class="home-instock-text">${escapeHtml(t('homeInStockTitle'))} —</span>
        <span class="home-instock-action">${escapeHtml(t('homeInStockLink'))}</span>
      </a>
    </div>
  `;

  document.getElementById('homeCtaBtn').onclick = () => router.navigate('chat');
  document.getElementById('homeInStockLink').onclick = () => router.navigate('catalog');
}

// Заглушка чтобы импорты в app.js не падали
export function onCatalogChanged() {}
