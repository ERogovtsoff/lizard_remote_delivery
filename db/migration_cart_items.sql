-- Миграция: добавляет таблицу cart_items для существующей БД.
-- Запустить один раз в SQL Editor Supabase.

CREATE TABLE IF NOT EXISTS cart_items (
  customer_tg_id BIGINT NOT NULL REFERENCES customers(tg_id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  size           TEXT NOT NULL DEFAULT '',
  qty            INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_tg_id, product_id, size)
);

ALTER TABLE cart_items DISABLE ROW LEVEL SECURITY;
