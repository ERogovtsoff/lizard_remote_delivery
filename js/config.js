// Конфигурация приложения.
// API_MODE — какой backend используем:
//   'local'    — данные хранятся в localStorage + catalog.json (текущий режим)
//   'supabase' — данные хранятся в Supabase (PostgreSQL)
// Чтобы подключить Supabase: создайте проект на supabase.com, выполните db/schema.sql,
// затем смените режим на 'supabase' и заполните SUPABASE_URL / SUPABASE_ANON_KEY.
export const CONFIG = {
  API_MODE: 'supabase',

  // Supabase (заполнить после создания проекта)
  SUPABASE_URL: 'https://nhnbprmyqqpwcofkaasi.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obmJwcm15cXFwd2NvZmthYXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTc4NzEsImV4cCI6MjA5NDY3Mzg3MX0.85NtVma5cplLuhm_fRHga3Z1ZlyNuFQBOqlxGeQggJ0',

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
