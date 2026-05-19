-- Миграция: добавить колонку purchases_total_byn и обновить триггер
-- update_purchases_total так, чтобы он копил суммы и в USD, и в BYN.
--
-- Запустить один раз в SQL Editor Supabase.

-- 1. Новая колонка для суммы выкупа в BYN
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS purchases_total_byn NUMERIC(12,2) NOT NULL DEFAULT 0;

-- 2. Переписываем триггер: теперь обновляет обе колонки
CREATE OR REPLACE FUNCTION update_purchases_total() RETURNS TRIGGER AS $$
BEGIN
  -- Заказ помечен как оплаченный
  IF (TG_OP = 'UPDATE' AND OLD.is_paid = FALSE AND NEW.is_paid = TRUE) THEN
    UPDATE customers
      SET purchases_total     = purchases_total     + COALESCE(NEW.total_usd, 0),
          purchases_total_byn = purchases_total_byn + COALESCE(NEW.total_byn, 0)
      WHERE tg_id = NEW.customer_tg_id;
  END IF;

  -- Заказ снят с оплаты (возврат)
  IF (TG_OP = 'UPDATE' AND OLD.is_paid = TRUE AND NEW.is_paid = FALSE) THEN
    UPDATE customers
      SET purchases_total     = GREATEST(0, purchases_total     - COALESCE(OLD.total_usd, 0)),
          purchases_total_byn = GREATEST(0, purchases_total_byn - COALESCE(OLD.total_byn, 0))
      WHERE tg_id = OLD.customer_tg_id;
  END IF;

  -- Заказ создаётся уже оплаченным (редко, но возможно — если менеджер вручную создаёт оплаченный заказ)
  IF (TG_OP = 'INSERT' AND NEW.is_paid = TRUE) THEN
    UPDATE customers
      SET purchases_total     = purchases_total     + COALESCE(NEW.total_usd, 0),
          purchases_total_byn = purchases_total_byn + COALESCE(NEW.total_byn, 0)
      WHERE tg_id = NEW.customer_tg_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Пересчитать существующие данные (на случай если в БД уже есть оплаченные заказы)
UPDATE customers c
  SET purchases_total_byn = COALESCE(s.total, 0)
  FROM (
    SELECT customer_tg_id, SUM(total_byn) AS total
    FROM orders
    WHERE is_paid = TRUE
    GROUP BY customer_tg_id
  ) s
  WHERE c.tg_id = s.customer_tg_id;
