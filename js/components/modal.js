// Модалка-подтверждение. Используется для удаления из избранного/корзины и т.п.
// API: showConfirm({ icon, title, text, yes, no, danger, onYes, onNo })
import { t } from '../i18n.js';

export function showConfirm({ icon = '⚠️', title, text, yes, no, danger = false, onYes, onNo }) {
  const modal = document.getElementById('modal');
  document.getElementById('modalIcon').textContent = icon;
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalText').textContent = text;
  const actions = document.getElementById('modalActions');
  actions.innerHTML = '';

  const btnYes = document.createElement('button');
  btnYes.className = danger ? 'primary-btn' : 'primary-btn';
  if (danger) btnYes.style.background = 'var(--danger)';
  btnYes.textContent = yes || t('yes');
  btnYes.onclick = () => { modal.classList.remove('show'); onYes && onYes(); };
  actions.append(btnYes);

  // Вторая кнопка («Отмена») — только если no не передан как null явно
  if (no !== null) {
    const btnNo = document.createElement('button');
    btnNo.className = 'secondary-btn';
    btnNo.textContent = no || t('cancel');
    btnNo.onclick = () => { modal.classList.remove('show'); onNo && onNo(); };
    actions.append(btnNo);
  }

  modal.classList.add('show');
}

export function closeModal() {
  document.getElementById('modal')?.classList.remove('show');
}
