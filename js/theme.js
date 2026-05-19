// Тема в стиле POIZON: бирюзовый акцент на нейтральной серой базе.
// Игнорируем Telegram themeParams, чтобы сохранить фирменный вид.

import { tg, setHeaderColor } from './tg.js';

// Бирюзовый акцент: #01C2C3 — основной цвет POIZON.
// Серая база: почти-белый фон (#f5f5f5 / #fafafa) и тёмно-серый текст (#1a1a1a).

const LIGHT = {
  '--bg': '#ffffff',
  '--bg-secondary': '#f5f5f5',
  '--bg-tertiary': '#ebebeb',
  '--text': '#1a1a1a',
  '--text-secondary': '#666666',
  '--hint': '#999999',
  '--link': '#01a8a9',
  '--button': '#01C2C3',
  '--button-text': '#ffffff',
  '--border': '#e5e5e5',
  '--danger': '#e74c3c',
  '--success': '#2ecc71',
  '--warning': '#f39c12',
  '--accent': '#01C2C3',
  '--accent-soft': 'rgba(1, 194, 195, 0.10)',
  '--brown': '#1a1a1a',                        // legacy var name: используется для цен
  '--brown-soft': 'rgba(26, 26, 26, 0.06)',
  '--chat-in': '#f0f0f0',
  '--chat-out': '#01C2C3',
  '--chat-out-text': '#ffffff',
};

const DARK = {
  '--bg': '#0d0d0d',
  '--bg-secondary': '#1a1a1a',
  '--bg-tertiary': '#262626',
  '--text': '#f5f5f5',
  '--text-secondary': '#a8a8a8',
  '--hint': '#7a7a7a',
  '--link': '#33d4d5',
  '--button': '#01C2C3',
  '--button-text': '#ffffff',
  '--border': '#2a2a2a',
  '--danger': '#e74c3c',
  '--success': '#2ecc71',
  '--warning': '#f39c12',
  '--accent': '#01C2C3',
  '--accent-soft': 'rgba(1, 194, 195, 0.18)',
  '--brown': '#f5f5f5',
  '--brown-soft': 'rgba(245, 245, 245, 0.06)',
  '--chat-in': '#262626',
  '--chat-out': '#01C2C3',
  '--chat-out-text': '#ffffff',
};

export function detectTheme(settingsTheme) {
  if (settingsTheme && settingsTheme !== 'auto') return settingsTheme;
  if (tg?.colorScheme) return tg.colorScheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(settingsTheme) {
  const theme = detectTheme(settingsTheme);
  const isDark = theme === 'dark';
  const palette = isDark ? DARK : LIGHT;
  const root = document.documentElement;

  // Класс theme-transition включает плавный transition только на момент смены палитры,
  // чтобы не тормозить остальные интеракции.
  root.classList.add('theme-transition');
  for (const [k, v] of Object.entries(palette)) {
    root.style.setProperty(k, v);
  }
  root.style.setProperty('color-scheme', isDark ? 'dark' : 'light');
  setHeaderColor(isDark ? '#0d0d0d' : '#ffffff');
  setTimeout(() => root.classList.remove('theme-transition'), 400);
}
