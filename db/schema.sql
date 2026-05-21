-- =============================================================
--  Схема для Supabase (PostgreSQL)
--  Запустите этот скрипт целиком в SQL Editor вашего проекта.
--
--  Содержимое:
--    1. ENUM статусов заказа
--    2. customers   — клиенты (по tg_id)
--    3. products    — каталог в наличии
--    4. orders      — заказы (с status и is_paid)
--    5. order_items — позиции в заказе
--    6. inquiries   — обращения клиентов (запросы на подбор, вопросы по товарам)
--    7. favorites   — избранное клиента
--    8. Триггер     — при is_paid TRUE прибавляет сумму к purchases_total клиента
--    9. RLS         — базовые политики (закомментированы; ОБЯЗАТЕЛЬНО настройте перед прод-релизом)
--
--  ВАЖНО ПО АРХИТЕКТУРЕ:
--
--  Хранение настроек профиля (язык/валюта/тема):
--    Сделано в customers.preferences JSONB. Аргумент: для трёх простых полей
--    нет смысла заводить отдельную таблицу. JSONB удобно расширять под новые
--    флаги в будущем.
--
--  Хранение онбординга:
--    В БД НЕ хранится — это локальный «видел приветствие» флаг (по устройству).
--    Если клиент сменил устройство, ему нормально снова увидеть приветствие.
--    Хранится в localStorage клиента.
--
--  Избранное:
--    Заведено в БД (таблица favorites) — это даёт синхронизацию между устройствами
--    и возможность аналитики «какие товары чаще всего избирают». Поля productId
--    и size позволяют запоминать конкретный размер (правка #3).
--
--  ВАЛИДАЦИЯ tg_id:
--    Перед прод-релизом обязательно настройте Edge Function, которая проверяет
--    подпись initData бота, чтобы пользователь не мог подменить tg_id в клиенте.
-- =============================================================

-- 1. ENUM статусов заказа (полная воронка под выкуп из Китая)
DO $$ BEGIN
  CREATE TYPE order_status AS ENUM (
    'new', 'in_progress', 'awaiting_payment', 'paid',
    'purchasing', 'shipping', 'ready', 'completed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 2. CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
  tg_id            BIGINT PRIMARY KEY,
  first_name       TEXT,
  last_name        TEXT,
  username         TEXT,
  photo_url        TEXT,
  phone            TEXT,                              -- доступен только если клиент сам поделился через Bot API
  birth_date       DATE,                              -- Telegram эту инфу не отдаёт мини-аппе — заполнять вручную/из бота
  purchases_total      NUMERIC(12,2) NOT NULL DEFAULT 0,  -- сумма оплаченных заказов в USD
  purchases_total_byn  NUMERIC(12,2) NOT NULL DEFAULT 0,  -- сумма оплаченных заказов в BYN
  onboarded            BOOLEAN NOT NULL DEFAULT FALSE,    -- видел ли клиент онбординг
  preferences          JSONB NOT NULL DEFAULT '{}'::jsonb,-- { lang, theme, currency }
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_username_idx ON customers(username);

-- 3. PRODUCTS
CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,                     -- 'c1', 'c2', ... (короткие id для удобства)
  name_ru      TEXT,
  name_en      TEXT,
  desc_ru      TEXT,
  desc_en      TEXT,
  price_usd    NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_byn    NUMERIC(10,2) NOT NULL DEFAULT 0,
  images       TEXT[] NOT NULL DEFAULT '{}',         -- массив URL картинок
  sizes        TEXT[] NOT NULL DEFAULT '{}',         -- например {'XS','S','M','L','XL'}
  stock        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- остатки по размерам {"S":5,"M":0}
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,        -- скрыть из выдачи без удаления
  badge_text   TEXT,                                 -- текст плашки (напр. «Топ», «Хит»). NULL = нет плашки
  badge_color  TEXT,                                 -- ключ цвета плашки из фиксированной палитры
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_is_active_idx ON products(is_active);

-- 4. ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id             BIGSERIAL PRIMARY KEY,
  customer_tg_id BIGINT NOT NULL REFERENCES customers(tg_id) ON DELETE CASCADE,
  total_usd      NUMERIC(12,2) NOT NULL,
  total_byn      NUMERIC(12,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',         -- валюта, в которой клиент видел сумму
  status         order_status NOT NULL DEFAULT 'new',
  is_paid        BOOLEAN NOT NULL DEFAULT FALSE,
  eta            DATE,                                -- ожидаемая дата доставки (заполняется, когда status='shipping')
  manager_note   TEXT,                                -- внутренние заметки
  manager_msg_id BIGINT,                              -- id карточки заказа в чате менеджера (для редактирования)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_tg_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);

-- 5. ORDER_ITEMS
CREATE TABLE IF NOT EXISTS order_items (
  id                  BIGSERIAL PRIMARY KEY,
  order_id            BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id          TEXT NOT NULL REFERENCES products(id),
  size                TEXT,
  qty                 INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  price_usd_snapshot  NUMERIC(10,2) NOT NULL,         -- цена на момент заказа (история не должна меняться при правке каталога)
  price_byn_snapshot  NUMERIC(10,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);

-- 6. INQUIRIES — обращения клиентов (запросы на подбор и вопросы по товарам).
-- Создаются ботом при переходе клиента из апки. Содержат активный статус
-- (new/in_progress/closed) и id карточки в чате менеджера для inline-кнопок.
-- В истории апки клиент видит свои обращения рядом с заказами.
CREATE TABLE IF NOT EXISTS inquiries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number         BIGSERIAL,                          -- человекочитаемый номер (Обращение №N)
  customer_tg_id BIGINT NOT NULL REFERENCES customers(tg_id) ON DELETE CASCADE,
  type           TEXT NOT NULL DEFAULT 'request',   -- 'request' | 'product_question'
  product_id     TEXT REFERENCES products(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'new',        -- 'new' | 'in_progress' | 'closed'
  manager_msg_id BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inquiries_status_idx ON inquiries(status);
CREATE INDEX IF NOT EXISTS inquiries_customer_idx ON inquiries(customer_tg_id);

-- 7. FAVORITES
CREATE TABLE IF NOT EXISTS favorites (
  customer_tg_id BIGINT NOT NULL REFERENCES customers(tg_id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size           TEXT NOT NULL DEFAULT '',             -- пустая строка = «без размера»
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_tg_id, product_id, size)
);

-- 7b. CART_ITEMS — корзина (до оформления заказа).
-- При checkout содержимое корзины превращается в order + order_items,
-- а записи отсюда удаляются.
CREATE TABLE IF NOT EXISTS cart_items (
  customer_tg_id BIGINT NOT NULL REFERENCES customers(tg_id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size           TEXT NOT NULL DEFAULT '',
  qty            INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_tg_id, product_id, size)
);

-- 8. ТРИГГЕР: пересчёт purchases_total в USD и BYN при оплате
CREATE OR REPLACE FUNCTION update_purchases_total() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND COALESCE(OLD.is_paid, FALSE) = FALSE AND NEW.is_paid = TRUE) THEN
    UPDATE customers
      SET purchases_total     = purchases_total     + COALESCE(NEW.total_usd, 0),
          purchases_total_byn = purchases_total_byn + COALESCE(NEW.total_byn, 0),
          updated_at = now()
      WHERE tg_id = NEW.customer_tg_id;
  ELSIF (TG_OP = 'UPDATE' AND COALESCE(OLD.is_paid, FALSE) = TRUE AND NEW.is_paid = FALSE) THEN
    UPDATE customers
      SET purchases_total     = GREATEST(0, purchases_total     - COALESCE(OLD.total_usd, 0)),
          purchases_total_byn = GREATEST(0, purchases_total_byn - COALESCE(OLD.total_byn, 0)),
          updated_at = now()
      WHERE tg_id = NEW.customer_tg_id;
  ELSIF (TG_OP = 'INSERT' AND NEW.is_paid = TRUE) THEN
    UPDATE customers
      SET purchases_total     = purchases_total     + COALESCE(NEW.total_usd, 0),
          purchases_total_byn = purchases_total_byn + COALESCE(NEW.total_byn, 0),
          updated_at = now()
      WHERE tg_id = NEW.customer_tg_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_paid_trigger ON orders;
CREATE TRIGGER orders_paid_trigger
  AFTER INSERT OR UPDATE OF is_paid ON orders
  FOR EACH ROW EXECUTE FUNCTION update_purchases_total();

-- Поддержание updated_at
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_touch ON customers;
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS products_touch ON products;
CREATE TRIGGER products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS orders_touch ON orders;
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 9. ROW LEVEL SECURITY
--
-- Supabase ВКЛЮЧАЕТ RLS на новых таблицах по умолчанию (зависит от способа создания).
-- Если RLS включён, а политик нет — ВСЕ запросы блокируются с ошибкой
--   "new row violates row-level security policy"
-- или "permission denied for table ...".
--
-- РЕЖИМ A (текущий, для теста — без RLS, без Edge Function):
--   Явно ВЫКЛЮЧАЕМ RLS на всех таблицах. ANY клиент с anon-ключом сможет читать
--   и писать всё. Это нормально для теста; для прода переходите на режим Б.
ALTER TABLE customers   DISABLE ROW LEVEL SECURITY;
ALTER TABLE products    DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders      DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE favorites   DISABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items  DISABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries   DISABLE ROW LEVEL SECURITY;

-- РЕЖИМ Б (для прод-релиза, требует Edge Function для валидации Telegram initData):
-- 1. Закомментируйте все ALTER TABLE ... DISABLE ROW LEVEL SECURITY выше
-- 2. Раскомментируйте блок ниже и адаптируйте под вашу Edge Function-авторизацию
--
-- ALTER TABLE customers   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE orders      ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE requests    ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE favorites   ENABLE ROW LEVEL SECURITY;
--
-- -- Каталог — публичный (читают все, пишет только service_role)
-- ALTER TABLE products ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "products are public" ON products FOR SELECT USING (TRUE);
--
-- -- ВАЖНО: Эти политики работают только если вы передаёте tg_id в JWT через Edge Function.
-- CREATE POLICY "customer sees own profile" ON customers
--   FOR SELECT USING (tg_id = (auth.jwt() ->> 'tg_id')::BIGINT);
-- CREATE POLICY "customer updates own profile" ON customers
--   FOR UPDATE USING (tg_id = (auth.jwt() ->> 'tg_id')::BIGINT);
-- CREATE POLICY "customer sees own orders" ON orders
--   FOR SELECT USING (customer_tg_id = (auth.jwt() ->> 'tg_id')::BIGINT);
-- CREATE POLICY "customer creates own orders" ON orders
--   FOR INSERT WITH CHECK (customer_tg_id = (auth.jwt() ->> 'tg_id')::BIGINT);
-- CREATE POLICY "customer manages own favorites" ON favorites
--   FOR ALL USING (customer_tg_id = (auth.jwt() ->> 'tg_id')::BIGINT)
--   WITH CHECK (customer_tg_id = (auth.jwt() ->> 'tg_id')::BIGINT);
-- CREATE POLICY "customer manages own requests" ON requests
--   FOR ALL USING (customer_tg_id = (auth.jwt() ->> 'tg_id')::BIGINT)
--   WITH CHECK (customer_tg_id = (auth.jwt() ->> 'tg_id')::BIGINT);

-- Готово.
