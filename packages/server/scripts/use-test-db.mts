/**
 * Переключение на тестовую базу.
 *
 * Подключается **первым** импортом в проверочных скриптах: в ESM оценка модулей
 * идёт по порядку, поэтому подмена переменной происходит до того, как
 * `src/env.js` и `src/db/client.js` успеют прочитать `DATABASE_URL` и создать
 * клиента Prisma.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────────
 *
 * Скрипт сокетов поднимает настоящий сервер, а тот при подключении берёт
 * `DATABASE_URL`. В CI это одноразовая база в контейнере, и вопроса нет. Но
 * локально `DATABASE_URL` указывает на **рабочую** базу, и каждый запуск
 * `npm run test:socket` оставлял бы в ней трёх пользователей, комнату и книгу.
 *
 * Проверка на `rdcloud_test` в имени — та же, что и в `migrate-test.mjs`: если
 * подмена не сработала, лучше отказаться работать, чем писать в рабочую базу.
 * Молчаливый отказ выглядел бы как «скрипт ничего не делает», а поломка базы
 * обнаружилась бы позже и не здесь.
 */

import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
// `scripts/` → `packages/server` → `packages` → корень репозитория с `.env`.
loadEnv({ path: resolve(here, '../../../.env'), quiet: true });

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl === undefined || testUrl === '') {
  console.error('Не задан TEST_DATABASE_URL в .env — проверочные скрипты не запускаются');
  console.error('Без него скрипт писал бы в рабочую базу.');
  process.exit(1);
}

if (!/rdcloud_test/i.test(testUrl)) {
  console.error('TEST_DATABASE_URL должен указывать на базу rdcloud_test');
  console.error(`  получено: ${testUrl.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@')}`);
  process.exit(1);
}

// dotenv не перезаписывает уже заданные переменные, поэтому значение,
// выставленное в окружении CI, переживёт загрузку `.env` — и подмена не
// испортит CI-окружение.
process.env.DATABASE_URL = testUrl;
