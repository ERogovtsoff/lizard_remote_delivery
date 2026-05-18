// Минимальный роутер. Хранит текущую страницу + контекст (для деталки — id товара),
// управляет видимостью шапки, нижней навигации и нативной BackButton Telegram.
import { tg, showBackButton } from './tg.js';

const VIEWS = {};
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

    // Подсветка нижней навигации: только когда мы находимся на одном из её разделов.
    // На детальной товара / избранном / корзине / истории / настройках / админке
    // ничего не подсвечиваем — это даёт пользователю понимание «я не в корневом разделе».
    const rootHighlight = ROOT_PAGES.includes(name) ? name : null;
    document.querySelectorAll('.nav-btn[data-nav]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-nav') === rootHighlight);
    });

    // Шапка — везде кроме онбординга
    document.getElementById('appHeader').classList.toggle('hidden', name === 'onboarding');
    // Нижняя навигация видна на всех экранах кроме онбординга
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
