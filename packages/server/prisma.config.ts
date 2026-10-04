import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

/**
 * Конфигурация Prisma CLI.
 *
 * В Prisma 7 отсюда берётся всё, чего больше нет в schema.prisma: подключение
 * к базе, путь к миграциям и команда seed.
 *
 * Два неочевидных решения:
 *
 * 1. `.env` лежит в корне репозитория, а не рядом с этим файлом. CLI ищет его
 *    в текущем каталоге, и если запустить `prisma` из packages/server, файл не
 *    найдётся: `env('DATABASE_URL')` упадёт с «не удаётся разрешить переменную».
 *    Поэтому путь задаётся явно, относительно этого файла, и миграции можно
 *    запускать из любого каталога.
 *
 * 2. `dotenv` вызывается вручную, а не через `import 'dotenv/config'`: седьмая
 *    версия Prisma перестала читать `.env` сама, и без этой строки переменная
 *    была бы не задана.
 */
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx src/prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});