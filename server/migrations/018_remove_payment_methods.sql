-- 018_remove_payment_methods.sql
-- Способы перевода и счёта больше не хранятся в финансовых таблицах.
-- Колонка payment_method удаляется из salary_payouts, client_payments и expenses.
-- Данные сохраняются: удаление колонки не трогает остальные значения и строки.

ALTER TABLE salary_payouts DROP COLUMN payment_method;
ALTER TABLE client_payments DROP COLUMN payment_method;
ALTER TABLE expenses DROP COLUMN payment_method;
