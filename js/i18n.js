// Переводы. Ключи общие для всех вьюшек.
import { getUserLanguage } from './tg.js';

const STRINGS = {
  ru: {
    appName: 'LIZARD',
    onbTitle: 'Добро пожаловать в LIZARD',
    onbText: 'Покупай оригинальные товары мировых брендов напрямую с китайских маркетплейсов — без переплат и подделок.',
    onbF1Title: '100% оригинал', onbF1Text: 'Проверяем подлинность каждой вещи перед отправкой',
    onbF2Title: 'Примерка перед оплатой', onbF2Text: 'Не подошло — возвращаем деньги без вопросов',
    onbF3Title: 'Доставка 3–4 недели', onbF3Text: 'Прямые поставки из Китая по всей Беларуси',
    onbBtnLabel: 'Начать',

    homeHeroTitle: 'Оригинальные товары мировых брендов',
    homeHeroText: 'Заказ напрямую с китайских площадок — без переплат и подделок.',
    homeFeature1Title: 'Только оригинал',
    homeFeature1Text: 'Проверяем каждую вещь',
    homeFeature2Title: 'Примерка при получении',
    homeFeature2Text: 'Не подошло — бесплатный возврат',
    homeFeature3Title: 'Доставка по Беларуси',
    homeFeature3Text: 'Почта или курьер в любой город',
    orderFromChina: 'Заказать товар',
    homeInStockTitle: 'Или примерь уже сегодня',
    homeInStockText: 'Товары в наличии в Беларуси',
    homeInStockLink: 'Смотреть наличие →',
    inStock: 'В наличии',
    searchPlaceholder: 'Поиск по названию…',
    catalogEmptyTitle: 'Пока нет товаров в наличии',
    catalogEmptyText: 'Но любой товар можно заказать из Китая — оригинал, с примеркой при получении.',
    catalogEmptyLink: 'Заказать товар →',
    searchEmptyTitle: 'Ничего не найдено', searchEmptyText: 'Попробуйте изменить запрос.',
    catalogTitle: 'В наличии', catalogSub: 'Товары, которые можно заказать прямо сейчас.',

    chatGreeting1: 'Привет! 👋',
    chatGreeting2: 'Расскажите, что хотите заказать — название, ссылку или просто фото. Подберём и привезём 💛',
    chatGreeting3: 'Нажмите на поле ввода, чтобы начать диалог — там можно написать и приложить фото.',
    chatInputPlaceholder: 'Напишите сообщение…',
    chatAttachInfo: 'Фото и файлы можно прикрепить в чате с менеджером после нажатия на поле ввода',

    favTitle: 'Избранное', favSub: 'Товары, которые вы сохранили.',
    favEmptyTitle: 'Пока пусто', favEmptyText: 'Добавляйте товары в избранное, чтобы вернуться к ним позже.',
    favEmptyLink: 'Перейти в каталог →',
    cartTitle: 'Корзина', cartSub: 'Товары из наличия, готовые к заказу.',
    cartEmptyTitle: 'Корзина пуста', cartEmptyText: 'Добавьте что-нибудь из наличия или закажите любой товар из Китая.',
    cartEmptyLinkCatalog: 'Посмотреть наличие',
    cartEmptyLinkOrder: 'Заказать из Китая',
    orJoin: 'или',
    cartTotal: 'Итого', checkout: 'Оформить заказ',
    orderPlaced: 'Заказ оформлен — менеджер свяжется с вами',
    orderFailed: 'Не удалось оформить заказ. Попробуйте ещё раз.',

    guest: 'Гость',
    loading: 'Загрузка…',
    profileSpent: 'Выкуплено на сумму',
    historyTitle: 'История заказов', historySub: 'Запросы и заказы',
    historySubFull: 'Все ваши запросы и заказы.',
    historyEmptyTitle: 'Пока пусто', historyEmptyText: 'Здесь появятся ваши запросы и заказы.',
    settingsTitle: 'Настройки', settingsSub: 'Язык, тема, валюта',
    settingsSubFull: 'Язык, тема и валюта отображения.',
    language: 'Язык', languageSub: 'Язык интерфейса',
    theme: 'Тема', themeSub: 'Светлая или тёмная',
    currency: 'Валюта', currencySub: 'Отображение цен',
    auto: 'Авто', themeLight: 'Светлая', themeDark: 'Тёмная',
    adminPanelOpen: 'Управление каталогом', adminPanelSub: 'Добавляйте и редактируйте товары',

    navHome: 'Главная', navChat: 'Заказать', navCatalog: 'В наличии', navProfile: 'Профиль',

    addToCart: 'В корзину', inCart: 'В корзине',
    sizeChart: 'Выберите размер', description: 'Описание',
    selectSize: 'Выберите размер',
    askOtherSizes: 'Уточнить наличие других размеров',
    addedToCart: 'Добавлено в корзину', removedFromCart: 'Убрано из корзины',
    addedToFav: 'Добавлено в избранное', removedFromFav: 'Убрано из избранного',
    typeRequest: 'Запрос на подбор', typeOrder: 'Заказ', typeProductQuestion: 'Вопрос по товару',
    inquiryAboutProduct: 'Интересует товар',
    inquiryRequestBody: 'Запрос на подбор товара — менеджер свяжется с вами',
    photos: 'Файлы',
    lightboxHint: 'Двойной тап или щипок — приближение',

    confirmRemoveFavTitle: 'Убрать из избранного?',
    confirmRemoveFavText: 'Товар будет удалён из вашего избранного.',
    confirmRemoveCartTitle: 'Удалить из корзины?',
    confirmRemoveCartText: 'Товар будет удалён из корзины.',
    confirmYes: 'Да, удалить', confirmNo: 'Отмена',

    // Статусы заказа (воронка выкупа)
    osNew: 'Новый',
    osInProgress: 'В работе',
    osAwaitingPayment: 'Ждёт оплаты',
    osPaid: 'Оплачен',
    osPurchasing: 'Выкупаем',
    osShipping: 'В пути',
    osReady: 'Готов к выдаче',
    osCompleted: 'Выдан',
    osCancelled: 'Отменён',
    // Статусы обращения
    isNew: 'Новое',
    isInProgress: 'В работе',
    isClosed: 'Закрыто',
    eta: 'Ожидается',

    // Админка
    adminTitle: 'Управление каталогом',
    adminSub: 'Изменения сохраняются в базу данных и сразу видны всем клиентам.',
    adminTabCatalog: 'Товары', adminTabExport: 'Экспорт/Импорт',
    adminAddProduct: 'Добавить товар', adminEditProduct: 'Редактировать товар',
    adminFieldNameRu: 'Название (рус)', adminFieldNameEn: 'Название (англ)',
    adminFieldDescRu: 'Описание (рус)', adminFieldDescEn: 'Описание (англ)',
    adminFieldImages: 'Картинки', adminAddImage: 'Добавить картинку',
    adminImagePlaceholder: 'https://...',
    adminFieldPriceUsd: 'Цена USD', adminFieldPriceByn: 'Цена BYN',
    adminFieldSizes: 'Размеры через запятую', adminFieldSizesPlaceholder: 'XS, S, M, L, XL',
    adminFieldIsActive: 'Виден клиентам',
    adminFieldIsActiveHint: 'Если выключено — товар останется в базе, но не будет отображаться в каталоге',
    adminHidden: 'Скрыт',
    adminSave: 'Сохранить',
    adminProductSaved: 'Товар сохранён', adminProductDeleted: 'Товар удалён',
    adminConfirmDelete: 'Удалить товар?', adminConfirmDeleteText: 'Это действие нельзя отменить.',
    adminExportTitle: 'Экспорт каталога',
    adminExportSub: 'Скачайте JSON и загрузите на хостинг как catalog.json',
    adminExportBtn: 'Скачать catalog.json',
    adminImportTitle: 'Импорт каталога',
    adminImportSub: 'Загрузите ранее экспортированный JSON-файл',
    adminImportBtn: 'Выбрать файл',
    adminImported: 'Каталог импортирован',
    adminImportError: 'Ошибка импорта файла',
    adminNoName: 'Введите название товара',
    cancel: 'Отмена', yes: 'Да',
  },
  en: {
    appName: 'LIZARD',
    onbTitle: 'Welcome to LIZARD',
    onbText: 'Buy authentic items from world brands directly from Chinese marketplaces — no markups, no fakes.',
    onbF1Title: '100% authentic', onbF1Text: 'We verify every item before shipping',
    onbF2Title: 'Try on before paying', onbF2Text: 'Does not fit — we refund without questions',
    onbF3Title: 'Delivery in 3–4 weeks', onbF3Text: 'Direct shipping from China across Belarus',
    onbBtnLabel: 'Start',

    homeHeroTitle: 'Authentic items from world brands',
    homeHeroText: 'Direct orders from China — no markups, no fakes.',
    homeFeature1Title: 'Authentic only',
    homeFeature1Text: 'We verify every item',
    homeFeature2Title: 'Try on at delivery',
    homeFeature2Text: 'Free return if it does not fit',
    homeFeature3Title: 'Delivery in Belarus',
    homeFeature3Text: 'Post or courier to any city',
    orderFromChina: 'Order an item',
    homeInStockTitle: 'Or pick up today',
    homeInStockText: 'Items in stock in Belarus',
    homeInStockLink: 'Browse in stock →',
    inStock: 'In Stock',
    searchPlaceholder: 'Search by name…',
    catalogEmptyTitle: 'No items in stock yet',
    catalogEmptyText: 'But you can order any item from China — authentic, with try-on at delivery.',
    catalogEmptyLink: 'Order an item →',
    searchEmptyTitle: 'Nothing found', searchEmptyText: 'Try a different query.',
    catalogTitle: 'In Stock', catalogSub: 'Items you can order right now.',

    chatGreeting1: 'Hi! 👋',
    chatGreeting2: 'Tell us what you want to order — a name, a link, or just a photo. We will find it and bring it 💛',
    chatGreeting3: 'Tap the input field to start the chat — you can write and attach photos there.',
    chatInputPlaceholder: 'Type a message…',
    chatAttachInfo: 'You can attach photos and files in the chat with the manager after tapping the input field',

    favTitle: 'Favorites', favSub: 'Items you saved.',
    favEmptyTitle: 'Nothing here yet', favEmptyText: 'Save items to favorites to come back to them later.',
    favEmptyLink: 'Browse catalog →',
    cartTitle: 'Cart', cartSub: 'In-stock items ready to order.',
    cartEmptyTitle: 'Cart is empty', cartEmptyText: 'Add something from in-stock items, or order any item from China.',
    cartEmptyLinkCatalog: 'Browse in stock',
    cartEmptyLinkOrder: 'Order from China',
    orJoin: 'or',
    cartTotal: 'Total', checkout: 'Place order',
    orderPlaced: 'Order placed — the manager will contact you',
    orderFailed: 'Failed to place the order. Please try again.',

    guest: 'Guest',
    loading: 'Loading…',
    profileSpent: 'Total bought',
    historyTitle: 'Order history', historySub: 'Requests and orders',
    historySubFull: 'All your requests and orders.',
    historyEmptyTitle: 'Nothing here yet', historyEmptyText: 'Your requests and orders will appear here.',
    settingsTitle: 'Settings', settingsSub: 'Language, theme, currency',
    settingsSubFull: 'Language, theme and currency.',
    language: 'Language', languageSub: 'Interface language',
    theme: 'Theme', themeSub: 'Light or dark',
    currency: 'Currency', currencySub: 'Price display',
    auto: 'Auto', themeLight: 'Light', themeDark: 'Dark',
    adminPanelOpen: 'Manage catalog', adminPanelSub: 'Add and edit products',

    navHome: 'Home', navChat: 'Order', navCatalog: 'Shop', navProfile: 'Profile',

    addToCart: 'Add to cart', inCart: 'In cart',
    sizeChart: 'Select size', description: 'Description',
    selectSize: 'Select size',
    askOtherSizes: 'Ask about other sizes',
    addedToCart: 'Added to cart', removedFromCart: 'Removed from cart',
    addedToFav: 'Added to favorites', removedFromFav: 'Removed from favorites',
    typeRequest: 'Pickup request', typeOrder: 'Order', typeProductQuestion: 'Product question',
    inquiryAboutProduct: 'Interested in',
    inquiryRequestBody: 'Pickup request — the manager will contact you',
    photos: 'Files',
    lightboxHint: 'Double-tap or pinch to zoom',

    confirmRemoveFavTitle: 'Remove from favorites?',
    confirmRemoveFavText: 'The item will be removed from your favorites.',
    confirmRemoveCartTitle: 'Remove from cart?',
    confirmRemoveCartText: 'The item will be removed from your cart.',
    confirmYes: 'Yes, remove', confirmNo: 'Cancel',

    // Order statuses
    osNew: 'New',
    osInProgress: 'In progress',
    osAwaitingPayment: 'Awaiting payment',
    osPaid: 'Paid',
    osPurchasing: 'Purchasing',
    osShipping: 'Shipping',
    osReady: 'Ready for pickup',
    osCompleted: 'Completed',
    osCancelled: 'Cancelled',
    // Inquiry statuses
    isNew: 'New',
    isInProgress: 'In progress',
    isClosed: 'Closed',
    eta: 'ETA',

    adminTitle: 'Catalog management',
    adminSub: 'Changes are saved to the database and visible to all clients immediately.',
    adminTabCatalog: 'Products', adminTabExport: 'Export/Import',
    adminAddProduct: 'Add product', adminEditProduct: 'Edit product',
    adminFieldNameRu: 'Name (RU)', adminFieldNameEn: 'Name (EN)',
    adminFieldDescRu: 'Description (RU)', adminFieldDescEn: 'Description (EN)',
    adminFieldImages: 'Images', adminAddImage: 'Add image',
    adminImagePlaceholder: 'https://...',
    adminFieldPriceUsd: 'Price USD', adminFieldPriceByn: 'Price BYN',
    adminFieldSizes: 'Sizes, comma-separated', adminFieldSizesPlaceholder: 'XS, S, M, L, XL',
    adminFieldIsActive: 'Visible to clients',
    adminFieldIsActiveHint: 'If off — the product stays in the database but is hidden from the catalog',
    adminHidden: 'Hidden',
    adminSave: 'Save',
    adminProductSaved: 'Product saved', adminProductDeleted: 'Product deleted',
    adminConfirmDelete: 'Delete product?', adminConfirmDeleteText: 'This cannot be undone.',
    adminExportTitle: 'Export catalog',
    adminExportSub: 'Download the JSON and upload it to your hosting as catalog.json',
    adminExportBtn: 'Download catalog.json',
    adminImportTitle: 'Import catalog', adminImportSub: 'Load a previously exported JSON file',
    adminImportBtn: 'Choose file',
    adminImported: 'Catalog imported',
    adminImportError: 'Import error',
    adminNoName: 'Enter product name',
    cancel: 'Cancel', yes: 'Yes',
  }
};

let currentLang = 'ru';

export function setLang(langSetting) {
  if (langSetting && langSetting !== 'auto') { currentLang = langSetting; return; }
  const code = getUserLanguage();
  currentLang = code.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function getLang() { return currentLang; }

export function t(key) {
  return STRINGS[currentLang]?.[key] ?? STRINGS.en[key] ?? key;
}

// Применить переводы ко всему DOM (data-i18n / data-i18n-placeholder)
export function applyI18N() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
}

export function localizedProduct(p, currency) {
  return {
    ...p,
    name: p[`name_${currentLang}`] || p.name_ru || p.name_en || '—',
    desc: p[`desc_${currentLang}`] || p.desc_ru || p.desc_en || '',
    price: currency === 'BYN' ? (p.price_byn ?? 0) : (p.price_usd ?? 0),
    altPrice: currency === 'BYN' ? (p.price_usd ?? 0) : (p.price_byn ?? 0),
    mainImg: (p.images && p.images[0]) || p.img || '',
  };
}

export function altCurrency(currency) { return currency === 'USD' ? 'BYN' : 'USD'; }
