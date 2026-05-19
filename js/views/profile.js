// Профиль: шапка с аватаркой и именем, карточка суммы выкупа, ссылки на разделы.
import { t, getLang } from '../i18n.js';
import { escapeHtml, formatPrice } from '../utils.js';
import { state } from '../state.js';
import { api } from '../api/index.js';
import { router } from '../router.js';
import { isAdmin } from '../tg.js';

export async function renderProfile() {
  const customer = await api.loadCustomer();
  const name = customer
    ? [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || t('guest')
    : t('guest');
  const username = customer?.username ? '@' + customer.username : '';
  const photo = customer?.photo_url || '';
  const letter = (name || 'G').trim().charAt(0).toUpperCase();

  // Сумма выкупа в выбранной клиентом валюте
  const cur = state.settings.currency;
  const lang = getLang();
  const totalUsd = Number(customer?.purchases_total) || 0;
  const totalByn = Number(customer?.purchases_total_byn) || 0;
  const total = cur === 'USD' ? totalUsd : totalByn;

  const page = document.getElementById('page-profile');
  page.innerHTML = `
    <div class="profile-header">
      <div class="profile-avatar ${photo ? 'has-photo' : ''}" ${photo ? `style="background-image:url('${escapeHtml(photo)}')"` : ''}>
        <span class="avatar-letter">${escapeHtml(letter)}</span>
      </div>
      <div class="profile-info">
        <div class="profile-name">${escapeHtml(name)}</div>
        ${username ? `<div class="profile-username">${escapeHtml(username)}</div>` : ''}
      </div>
    </div>

    <div class="profile-stats">
      <div class="profile-stat-label">${escapeHtml(t('profileSpent'))}</div>
      <div class="profile-stat-value">${escapeHtml(formatPrice(total, cur, lang))}</div>
    </div>

    <div class="settings-group">
      <div class="settings-row clickable" id="rowHistory">
        <div class="settings-row-content">
          <div class="settings-row-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div>
            <div class="settings-row-label">${escapeHtml(t('historyTitle'))}</div>
            <div class="settings-row-sub">${escapeHtml(t('historySub'))}</div>
          </div>
        </div>
        <div class="chevron">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
      <div class="settings-row clickable" id="rowSettings">
        <div class="settings-row-content">
          <div class="settings-row-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </div>
          <div>
            <div class="settings-row-label">${escapeHtml(t('settingsTitle'))}</div>
            <div class="settings-row-sub">${escapeHtml(t('settingsSub'))}</div>
          </div>
        </div>
        <div class="chevron">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
      ${isAdmin() ? `
      <div class="settings-row clickable" id="rowAdmin">
        <div class="settings-row-content">
          <div class="settings-row-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          </div>
          <div>
            <div class="settings-row-label">${escapeHtml(t('adminPanelOpen'))}</div>
            <div class="settings-row-sub">${escapeHtml(t('adminPanelSub'))}</div>
          </div>
        </div>
        <div class="chevron">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
      </div>
      ` : ''}
    </div>
  `;
  document.getElementById('rowHistory').onclick = () => router.navigate('history');
  document.getElementById('rowSettings').onclick = () => router.navigate('settings');
  const adminRow = document.getElementById('rowAdmin');
  if (adminRow) adminRow.onclick = () => router.navigate('admin');
}
