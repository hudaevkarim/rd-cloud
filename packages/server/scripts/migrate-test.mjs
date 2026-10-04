import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Применение миграций к тестовой базе.
 *
 * Зачем скрипт, а не строка в package.json: `prisma.config.ts` читает
 * `DATABASE_URL`, и без подмены `migrate deploy` применял бы миграции к рабочей
 * базе. Тот же вызов в CI и на машине отличался бы только тем, куда упал, —
 * а разница между тестовой базой и рабочей обнаруживается слишком поздно.
 *
 * Механика: dotenv не перезаписывает уже заданные переменные, поэтому
 * выставленный здесь `DATABASE_URL` переживёт загрузку `.env`. Этим и пользуемся.
 *
 * `migrate deploy`, а не `migrate dev`: у тестовой базы нет никакого состояния,
 * которое нужно сохранить, а `dev` заодно удаляет базу целиком — с данными,
 * которые на тестовой базе может держать параллельный прогон.
 */
// Отсчёт от scripts/: `..` — это packages/server, `../..` — packages,
// и только `../../..` — корень репозитория, где лежит `.env`.
const here = fileURLToPath(new URL('.', import.meta.url));
loadEnv({ path: resolve(here, '../../../.env'), quiet: true });

const testUrl = process.env.TEST_DATABASE_URL;
if (testUrl === undefined || testUrl === '') {
  console.error('Не задан TEST_DATABASE_URL в .env');
  process.exit(1);
}

if (!/rdcloud_test/i.test(testUrl)) {
  console.error('TEST_DATABASE_URL должен указывать на базу rdcloud_test');
  process.exit(1);
}

process.env.DATABASE_URL = testUrl;
console.log(`Миграции применяются к: ${testUrl.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@')}`);

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', 'migrate', 'deploy'],
  { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' },
);

process.exit(result.status ?? 1);