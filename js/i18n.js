// Переводы. Ключи общие для всех вьюшек.
import { getUserLanguage } from './tg.js';

const STRINGS = {
  ru: {
    appName: 'Магазин',
    onbTitle: 'Привет!',
    onbText: 'Магазин одежды и сервис заказа любых вещей из Китая — всё в одном приложении.',
    onbF1Title: 'Заказ из Китая', onbF1Text: 'Опишите вещь или пришлите ссылку — менеджер найдёт и привезёт',
    onbF2Title: 'Каталог в наличии', onbF2Text: 'Готовые товары, доступные сразу — без ожидания доставки',
    onbF3Title: 'Избранное и корзина', onbF3Text: 'Сохраняйте понравившееся и оформляйте заказ в пару нажатий',
    onbBtnLabel: 'Понятно',

    homeHeroTitle: 'Не нашли то, что нужно?',
    homeHeroText: 'Опишите товар или пришлите ссылку — мы привезём из Китая.',
    orderFromChina: 'Заказать из Китая',
    inStock: 'В наличии',
    searchPlaceholder: 'Поиск по названию…',
    catalogEmptyTitle: 'Пока пусто', catalogEmptyText: 'Товары скоро появятся.',
    searchEmptyTitle: 'Ничего не найдено', searchEmptyText: 'Попробуйте изменить запрос.',
    catalogTitle: 'В наличии', catalogSub: 'Товары, которые можно заказать прямо сейчас.',

    chatGreeting1: 'Здравствуйте! 👋',
    chatGreeting2: 'Расскажите, что вы хотели бы заказать — название, описание, ссылку или фото. Я найду и привезу.',
    chatGreeting3: 'Нажмите на поле ввода, чтобы продолжить диалог. Там можно отправить сообщение и приложить фото.',
    chatInputPlaceholder: 'Напишите сообщение…',

    favTitle: 'Избранное', favSub: 'Товары, которые вы сохранили.',
    favEmptyTitle: 'Пока пусто', favEmptyText: 'Добавляйте товары в избранное, чтобы вернуться к ним позже.',
    cartTitle: 'Корзина', cartSub: 'Товары из наличия, готовые к заказу.',
    cartEmptyTitle: 'Корзина пуста', cartEmptyText: 'Добавьте что-нибудь из раздела «В наличии».',
    cartTotal: 'Итого', checkout: 'Оформить заказ',
    orderPlaced: 'Заказ оформлен — менеджер свяжется с вами',
    orderFailed: 'Не удалось оформить заказ. Попробуйте ещё раз.',

    guest: 'Гость',
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
    typeRequest: 'Запрос на подбор', typeOrder: 'Заказ из наличия',
    photos: 'Файлы',
    orderMsgHeader: 'Здравствуйте! Хочу оформить заказ:',
    orderMsgTotal: 'Итого',
    lightboxHint: 'Двойной тап или щипок — приближение',

    confirmRemoveFavTitle: 'Убрать из избранного?',
    confirmRemoveFavText: 'Товар будет удалён из вашего избранного.',
    confirmRemoveCartTitle: 'Удалить из корзины?',
    confirmRemoveCartText: 'Товар будет удалён из корзины.',
    confirmYes: 'Да, удалить', confirmNo: 'Отмена',

    statusProcessing: 'В обработке',
    statusPacking: 'Собирается',
    statusShipping: 'В пути',
    statusDelivered: 'Доставлен',
    statusCancelled: 'Отменён',
    statusPaid: 'Оплачен',
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
    appName: 'Shop',
    onbTitle: 'Hello!',
    onbText: 'Clothing store and a service for ordering anything from China — all in one app.',
    onbF1Title: 'Order from China', onbF1Text: 'Describe the item or send a link — the manager will find and bring it',
    onbF2Title: 'In-stock catalog', onbF2Text: 'Ready items available now — no waiting for shipping',
    onbF3Title: 'Favorites and cart', onbF3Text: 'Save what you like and order in a couple of taps',
    onbBtnLabel: 'Got it',

    homeHeroTitle: "Didn't find what you need?",
    homeHeroText: 'Describe the item or send a link — we will bring it from China.',
    orderFromChina: 'Order from China',
    inStock: 'In Stock',
    searchPlaceholder: 'Search by name…',
    catalogEmptyTitle: 'Empty for now', catalogEmptyText: 'Items coming soon.',
    searchEmptyTitle: 'Nothing found', searchEmptyText: 'Try a different query.',
    catalogTitle: 'In Stock', catalogSub: 'Items you can order right now.',

    chatGreeting1: 'Hi! 👋',
    chatGreeting2: 'Tell us what you would like to order — name, description, link or photo. We will find it and bring it.',
    chatGreeting3: 'Tap the input field to continue the conversation. You can send messages and attach photos there.',
    chatInputPlaceholder: 'Type a message…',

    favTitle: 'Favorites', favSub: 'Items you saved.',
    favEmptyTitle: 'Nothing here yet', favEmptyText: 'Save items to favorites to come back to them later.',
    cartTitle: 'Cart', cartSub: 'In-stock items ready to order.',
    cartEmptyTitle: 'Cart is empty', cartEmptyText: 'Add something from "In Stock".',
    cartTotal: 'Total', checkout: 'Place order',
    orderPlaced: 'Order placed — the manager will contact you',
    orderFailed: 'Failed to place the order. Please try again.',

    guest: 'Guest',
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
    typeRequest: 'Pickup request', typeOrder: 'Order from stock',
    photos: 'Files',
    orderMsgHeader: 'Hello! I would like to place an order:',
    orderMsgTotal: 'Total',
    lightboxHint: 'Double-tap or pinch to zoom',

    confirmRemoveFavTitle: 'Remove from favorites?',
    confirmRemoveFavText: 'The item will be removed from your favorites.',
    confirmRemoveCartTitle: 'Remove from cart?',
    confirmRemoveCartText: 'The item will be removed from your cart.',
    confirmYes: 'Yes, remove', confirmNo: 'Cancel',

    statusProcessing: 'Processing',
    statusPacking: 'Packing',
    statusShipping: 'Shipping',
    statusDelivered: 'Delivered',
    statusCancelled: 'Cancelled',
    statusPaid: 'Paid',
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
