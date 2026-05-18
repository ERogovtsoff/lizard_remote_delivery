// Простой роутер. Хранит текущую страницу + контекст (для деталки — id товара).
// Управляет видимостью шапки и нижней навигации.
// Правка #13: нижняя навигация должна быть на детали тоже.
import { tg, showBackButton } from './tg.js';

const VIEWS = {};      // name -> render(opts)
const ROOT_PAGES = ['home', 'chat', 'catalog', 'profile'];

let current = null;
let lastContext = {};
let detailSource = 'home';

export function registerView(name, render) {
  VIEWS[name] = render;
}

export const router = {
  navigate(name, opts = {}) {
    // переключить активную секцию
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`page-${name}`);
    if (target) target.classList.add('active');

    // active в нижней навигации показываем для корневых разделов
    // Если зашли в детальную с главной — подсвечиваем «Главную»; с каталога — «Каталог»
    let rootHighlight = ROOT_PAGES.includes(name) ? name : null;
    if (name === 'detail') {
      rootHighlight = ROOT_PAGES.includes(detailSource) ? detailSource : 'home';
    } else if (name === 'favorites' || name === 'cart') {
      rootHighlight = 'home';
    } else if (['history', 'settings', 'admin'].includes(name)) {
      rootHighlight = 'profile';
    }
    document.querySelectorAll('.nav-btn[data-nav]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-nav') === rootHighlight);
    });

    // Шапка — везде кроме онбординга
    document.getElementById('appHeader').classList.toggle('hidden', name === 'onboarding');
    // Нижняя навигация — везде кроме онбординга (правка #13: на деталке тоже остаётся)
    document.getElementById('bottomNav').classList.toggle('hidden', name === 'onboarding');

    document.body.classList.toggle('no-chrome', name === 'onboarding');
    document.body.classList.toggle('chat-mode', name === 'chat');

    // Кнопка «Назад» — телеграмовская. Появляется на всех нерутовых страницах.
    const showBack = !ROOT_PAGES.includes(name) && name !== 'onboarding';
    showBackButton(showBack, () => {
      // Логика «Назад» по странице
      if (name === 'detail') router.navigate(detailSource || 'home');
      else if (['history', 'settings', 'admin'].includes(name)) router.navigate('profile');
      else if (name === 'favorites' || name === 'cart') router.navigate('home');
    });

    if (name === 'detail' && opts.source) detailSource = opts.source;

    current = name;
    lastContext = opts;
    window.scrollTo({ top: 0, behavior: 'instant' });

    // Закрыть клавиатуру при переходе
    if (document.activeElement && document.activeElement.blur) {
      try { document.activeElement.blur(); } catch (e) {}
    }

    const view = VIEWS[name];
    if (view) view(opts);
  },

  current() { return current; },
  lastContext() { return lastContext; },
  detailSource() { return detailSource; },
};
