// Конфигурация приложения.
// API_MODE — какой backend используем:
//   'local'    — данные хранятся в localStorage + catalog.json (текущий режим)
//   'supabase' — данные хранятся в Supabase (PostgreSQL)
// Чтобы подключить Supabase: создайте проект на supabase.com, выполните db/schema.sql,
// затем смените режим на 'supabase' и заполните SUPABASE_URL / SUPABASE_ANON_KEY.
export const CONFIG = {
  API_MODE: 'local',

  // Supabase (заполнить после создания проекта)
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',

  // Локальный fallback каталога
  CATALOG_URL: './catalog.json',

  // Менеджер магазина
  MANAGER_USERNAME: 'rogovtsoff',
  ADMIN_USERNAMES: ['rogovtsoff'],

  // Ключи localStorage
  STORAGE: {
    STATE: 'tg_shop_state_v5',
    CATALOG: 'tg_shop_catalog_v5',
    ONBOARDING: 'tg_shop_onboarded_v1',
  },

  // Доступные статусы заказа (синхронизированы со схемой БД)
  ORDER_STATUSES: ['processing', 'packing', 'shipping', 'delivered', 'cancelled'],
};
