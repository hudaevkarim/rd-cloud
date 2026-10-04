import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Тесты сервера.
 *
 * Отдельный конфиг, а не расширение корневого: серверные тесты бьют по живой
 * базе и поднимают Fastify целиком, у них своя среда и свой таймаут. Смешивать
 * их с тестами библиотеки в один прогон нельзя — при падении базы упали бы и
 * тесты парсера, которые к базе отношения не имеют.
 *
 * `pool: forks` с одним воркером — тот же довод, что и в корневом конфиге:
 * тесты делят одну базу, и параллельный запуск приводил бы к взаимным
 * блокировкам и недетерминированным падениям.
 */
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/helpers/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
  },
});

// `.env` в корне репозитория — тот же путь, что и у prisma.config.ts. Нужен
// `TEST_DATABASE_URL`; если его нет, setup-файл падает с понятным текстом
// вместо «не удалось подключиться к базе».
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });