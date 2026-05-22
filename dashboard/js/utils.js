// Вспомогательные функции форматирования для панели.

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Имя клиента для отображения: @username, либо имя+фамилия, либо id.
export function customerName(customer, fallbackId) {
  if (customer) {
    if (customer.username) return '@' + customer.username;
    const fn = (customer.first_name || '').trim();
    const ln = (customer.last_name || '').trim();
    const full = (fn + ' ' + ln).trim();
    if (full) return full;
  }
  return 'ID ' + fallbackId;
}

// Инициал для аватара
export function initial(name) {
  const s = (name || '?').replace(/^@/, '');
  return s.charAt(0).toUpperCase();
}

// Время сообщения: сегодня — «14:30», иначе — «22 мая».
export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

// Полная дата-время для разделителей в переписке
export function formatFullDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Краткое превью последнего сообщения для списка чатов
export function previewText(msg) {
  if (!msg) return '';
  if (msg.text) return msg.text;
  const typeLabels = {
    photo: '📷 Фото', document: '📎 Документ', video: '🎬 Видео',
    voice: '🎤 Голосовое', video_note: '⭕ Кружок', audio: '🎵 Аудио',
  };
  return typeLabels[msg.attachment_type] || '📎 Вложение';
}

// Генерация ID для нового товара (как в приложении: префикс + случайная часть).
export function makeId(prefix = 'p') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

// Палитра цветов плашек (бейджей) — совпадает с приложением.
export const BADGE_COLORS = {
  red:    { bg: '#e74c3c', fg: '#ffffff', label: 'Красный' },
  orange: { bg: '#f39c12', fg: '#ffffff', label: 'Оранжевый' },
  green:  { bg: '#2ecc71', fg: '#ffffff', label: 'Зелёный' },
  blue:   { bg: '#3498db', fg: '#ffffff', label: 'Синий' },
  gold:   { bg: '#d4af37', fg: '#1a1a1a', label: 'Золотой' },
  black:  { bg: '#1a1a1a', fg: '#ffffff', label: 'Чёрный' },
  accent: { bg: '#01C2C3', fg: '#ffffff', label: 'Бирюзовый' },
};
