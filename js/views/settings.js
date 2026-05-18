// Настройки: язык, тема, валюта. При смене — сохраняем и в БД (через upsertCustomer)
// и в локальном state.
import { t, getLang, applyI18N, setLang } from '../i18n.js';
import { escapeHtml } from '../utils.js';
import { state, setSettings } from '../state.js';
import { applyTheme } from '../theme.js';
import { api } from '../api/index.js';
import { router } from '../router.js';

export function renderSettings() {
  const s = state.settings;
  const page = document.getElementById('page-settings');
  page.innerHTML = `
    <h2>${escapeHtml(t('settingsTitle'))}</h2>
    <p class="page-sub">${escapeHtml(t('settingsSubFull'))}</p>
    <div class="settings-group">
      <div class="settings-row">
        <div class="settings-row-content">
          <div class="settings-row-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </div>
          <div>
            <div class="settings-row-label">${escapeHtml(t('language'))}</div>
            <div class="settings-row-sub">${escapeHtml(t('languageSub'))}</div>
          </div>
        </div>
        <select class="settings-select" id="settLang">
          <option value="auto" ${s.lang === 'auto' ? 'selected' : ''}>${escapeHtml(t('auto'))}</option>
          <option value="ru" ${s.lang === 'ru' ? 'selected' : ''}>Русский</option>
          <option value="en" ${s.lang === 'en' ? 'selected' : ''}>English</option>
        </select>
      </div>
      <div class="settings-row">
        <div class="settings-row-content">
          <div class="settings-row-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </div>
          <div>
            <div class="settings-row-label">${escapeHtml(t('theme'))}</div>
            <div class="settings-row-sub">${escapeHtml(t('themeSub'))}</div>
          </div>
        </div>
        <select class="settings-select" id="settTheme">
          <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>${escapeHtml(t('auto'))}</option>
          <option value="light" ${s.theme === 'light' ? 'selected' : ''}>${escapeHtml(t('themeLight'))}</option>
          <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>${escapeHtml(t('themeDark'))}</option>
        </select>
      </div>
      <div class="settings-row">
        <div class="settings-row-content">
          <div class="settings-row-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
          </div>
          <div>
            <div class="settings-row-label">${escapeHtml(t('currency'))}</div>
            <div class="settings-row-sub">${escapeHtml(t('currencySub'))}</div>
          </div>
        </div>
        <select class="settings-select" id="settCur">
          <option value="USD" ${s.currency === 'USD' ? 'selected' : ''}>USD</option>
          <option value="BYN" ${s.currency === 'BYN' ? 'selected' : ''}>BYN</option>
        </select>
      </div>
    </div>
  `;
  document.getElementById('settLang').onchange = (e) => {
    setSettings({ lang: e.target.value });
    setLang(e.target.value);
    applyI18N();
    api.upsertCustomer({ preferences: state.settings });
    router.navigate('settings');
  };
  document.getElementById('settTheme').onchange = (e) => {
    setSettings({ theme: e.target.value });
    applyTheme(e.target.value);
    api.upsertCustomer({ preferences: state.settings });
  };
  document.getElementById('settCur').onchange = (e) => {
    setSettings({ currency: e.target.value });
    api.upsertCustomer({ preferences: state.settings });
    router.navigate('settings');
  };
}
