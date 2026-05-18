// Онбординг — отображается один раз (флаг в localStorage).
import { setOnboarded } from '../state.js';
import { router } from '../router.js';

export function setupOnboarding() {
  document.getElementById('onbBtn').onclick = () => {
    setOnboarded();
    router.navigate('home');
  };
}

export function renderOnboarding() {
  // Разметка уже в index.html и переведена в applyI18N
}
