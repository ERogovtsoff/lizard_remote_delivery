// Конфигурация панели управления (dashboard).
// Те же данные Supabase, что и у приложения — общая база.
export const CONFIG = {
  SUPABASE_URL: 'https://nhnbprmyqqpwcofkaasi.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5obmJwcm15cXFwd2NvZmthYXNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwOTc4NzEsImV4cCI6MjA5NDY3Mzg3MX0.85NtVma5cplLuhm_fRHga3Z1ZlyNuFQBOqlxGeQggJ0',

  // Суперадмин — всегда имеет доступ (не обязан быть в таблице managers).
  SUPERADMIN_USERNAME: 'rogovtsoff',

  // Ключ localStorage для запоминания вошедшего менеджера
  AUTH_KEY: 'lizard_dashboard_auth',

  // Как часто обновлять список чатов / переписку (мс)
  REFRESH_INTERVAL: 5000,
};
