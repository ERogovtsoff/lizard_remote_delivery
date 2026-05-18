// Тема: оранжево-коричневая палитра. Игнорируем Telegram themeParams,
// чтобы сохранить фирменный вид. Поддерживаем только светлый/тёмный режим.
import { tg, setHeaderColor } from './tg.js';

const LIGHT = {
  '--bg': '#ffffff',
  '--bg-secondary': '#faf4ec',
  '--bg-tertiary': '#efe3d2',
  '--text': '#2a1a0e',
  '--text-secondary': '#7b5a3c',
  '--hint': '#ad8d6c',
  '--link': '#c4661f',
  '--button': '#e07d2e',
  '--button-text': '#ffffff',
  '--border': '#ead9c2',
  '--danger': '#b03a2e',
  '--success': '#6b8e23',
  '--warning': '#d97706',
  '--accent': '#e07d2e',
  '--accent-soft': 'rgba(224, 125, 46, 0.10)',
  '--brown': '#5c3a1e',
  '--brown-soft': 'rgba(92, 58, 30, 0.08)',
  '--chat-in': '#f3e9d9',
  '--chat-out': '#e07d2e',
  '--chat-out-text': '#ffffff',
};

const DARK = {
  '--bg': '#1c130c',
  '--bg-secondary': '#2a1c12',
  '--bg-tertiary': '#3a2718',
  '--text': '#f4e9da',
  '--text-secondary': '#c3a988',
  '--hint': '#8b7355',
  '--link': '#ed8a3e',
  '--button': '#e07d2e',
  '--button-text': '#ffffff',
  '--border': '#3a2718',
  '--danger': '#e57161',
  '--success': '#9aaf5a',
  '--warning': '#e0922e',
  '--accent': '#e07d2e',
  '--accent-soft': 'rgba(224, 125, 46, 0.16)',
  '--brown': '#d9b896',
  '--brown-soft': 'rgba(217, 184, 150, 0.10)',
  '--chat-in': '#3a2718',
  '--chat-out': '#e07d2e',
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

  // Включаем плавный transition только на момент смены палитры,
  // чтобы не тормозить остальные интеракции (наведения, фокусы и т.п.)
  root.classList.add('theme-transition');
  for (const [k, v] of Object.entries(palette)) {
    root.style.setProperty(k, v);
  }
  root.style.setProperty('color-scheme', isDark ? 'dark' : 'light');
  setHeaderColor(isDark ? '#1c130c' : '#ffffff');
  setTimeout(() => root.classList.remove('theme-transition'), 400);
}
