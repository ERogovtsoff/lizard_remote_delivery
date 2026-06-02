// Конфигурация приложения.
//
// Перед запуском: создайте проект на supabase.com, выполните db/schema.sql,
// заполните SUPABASE_URL и SUPABASE_ANON_KEY значениями из Project Settings → API.

export const CONFIG = {
  SUPABASE_URL: 'https://nhnbprmyqqpwcofkaasi.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obmJwcm15cXFwd2NvZmthYXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTc4NzEsImV4cCI6MjA5NDY3Mzg3MX0.85NtVma5cplLuhm_fRHga3Z1ZlyNuFQBOqlxGeQggJ0',

  // Источник каталога-сидера: при первом запуске (когда таблица products пустая)
  // апка автоматически заполнит её содержимым catalog.json. Дальше БД — источник правды.
  CATALOG_URL: './catalog.json',

  // Имя бота, через которого ведётся коммуникация между клиентом и менеджером.
  // Бот должен быть запущен (см. bot.py) и менеджер должен сделать /start.
  // ВАЖНО: укажите имя БЕЗ @
  BOT_USERNAME: 'your_shop_bot',

  STORAGE: {
    STATE: 'tg_shop_state_v5',
    CATALOG: 'tg_shop_catalog_v5',
    ONBOARDING: 'tg_shop_onboarded_v1',
  },
};
