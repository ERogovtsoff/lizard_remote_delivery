// Онбординг. Источник правды — поле customers.onboarded в БД.
// Локальный флаг (localStorage) используется как быстрый кэш для следующих запусков.
import { setOnboardedLocal } from '../state.js';
import { api } from '../api/index.js';
import { router } from '../router.js';

export function setupOnboarding() {
  document.getElementById('onbBtn').onclick = () => {
    setOnboardedLocal();
    // Пишем в БД асинхронно — не задерживаем переход в магазин
    api.markOnboarded?.().catch(() => {});
    router.navigate('home');
  };
}

export function renderOnboarding() {
  // Разметка уже в index.html и переведена в applyI18N
}
