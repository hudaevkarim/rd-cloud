-- Создание баз rd-cloud.
--
-- Запускать от суперпользователя кластера, подключившись к любой базе:
--   psql -h 127.0.0.1 -U rdcloud -d postgres -f tools/setup-databases.sql
--
-- ─── Почему LOCALE_PROVIDER icu, а не просто UTF8 ───────────────────────────
--
-- База, созданная по умолчанию, получает коллацию `C`. В ней Postgres умеет
-- приводить регистр ТОЛЬКО для ASCII, и потому:
--
--   select 'анна' ILIKE '%Анна%';            -- false
--   select lower('Анна') = lower('анна');    -- false
--
-- Это не мелочь, а поломка поиска: запрос «анна» не нашёл бы комнату «Анна
-- Каренина», а сортировка книг по автору шла бы по байтам, а не по алфавиту.
-- Проверено на этой машине до переключения.
--
-- ICU_COLLATION ru-RU даёт нормальное сравнение для кириллицы. LOCALE 'C'
-- оставлен потому, что на Windows других вариантов нет, а сортировку и
-- сравнение теперь всё равно делает ICU.
--
-- Если бы проект был английским, `ICU_LOCALE 'en-US'` дал бы тот же эффект.

-- Рабочая база. Удаление и пересоздание сносят все данные, включая
-- администратора: токен придётся получить заново через `npm run db:seed`.
DROP DATABASE IF EXISTS rdcloud;
CREATE DATABASE rdcloud
  ENCODING 'UTF8'
  TEMPLATE template0
  LOCALE_PROVIDER icu
  ICU_LOCALE 'ru-RU'
  LOCALE 'C';

-- Тестовая база. Серверные тесты делают TRUNCATE, поэтому она обязана быть
-- отдельной от рабочей.
DROP DATABASE IF EXISTS rdcloud_test;
CREATE DATABASE rdcloud_test
  ENCODING 'UTF8'
  TEMPLATE template0
  LOCALE_PROVIDER icu
  ICU_LOCALE 'ru-RU'
  LOCALE 'C';

-- Служебная, из проверки коллации. Убрана, чтобы не путать с рабочими.
DROP DATABASE IF EXISTS coll_probe;