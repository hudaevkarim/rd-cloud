import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Окружение сервера.
 *
 * Проверка переменных происходит один раз, при импорте модуля, и падает сразу.
 * Смысл не в том, чтобы «валидировать», а в том, чтобы сервер не поднялся
 * наполовину: без DATABASE_URL он стартует, но каждый запрос к базе падает, и
 * по логу это выглядит как ошибка базы, а не как забытая переменная.
 *
 * Модуль кэшируется сам собой: повторный импорт не перечитывает `.env`.
 */

/**
 * Корень репозитория.
 *
 * Отсчёт от `import.meta.url` файла `src/env.ts`: `../` — это `src/`, `../../`
 * — `packages/server/`, и только `../../../` — корень репозитория. С
 * относительным путём на уровень меньше `.env` не нашёлся бы, и проверка
 * переменных падала бы с «DATABASE_URL не задан» вместо того, чтобы читать файл,
 * который лежит рядом.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

// `.env` лежит в корне репозитория. Явный путь вместо `dotenv/config`, потому
// что тот ищет файл в текущем каталоге, а `npm run dev` запускается из
// packages/server, и файл там не виден.
loadEnv({ path: resolve(ROOT, '.env'), quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HOST: z.string().min(1).default('127.0.0.1'),

  // 0 — «случайный свободный порт». Полезно для тестов, где параллельно
  // поднимается несколько экземпляров сервера.
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),

  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL обязателен: сервер без базы данных не работает')
    .refine(
      (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
      'DATABASE_URL должен начинаться с postgresql://',
    ),

  /**
   * Каталог файлов книг. Относительный путь разрешается от корня репозитория,
   * а не от текущего каталога: иначе `npm run dev` из packages/server и
   * запуск собранного dist/index.js положили бы файлы в разные места.
   */
  DATA_DIR: z.string().min(1).default('./data'),

  /**
   * Origin клиента для CORS. Ровно один: приложение живёт на своём домене, и
   * разрешать больше нечего. Значение `*` здесь означало бы, что любой сайт
   * может дёргать API от имени пользователя, у которого в localStorage лежит
   * токен, — то есть полностью обойти отсутствие настоящей аутентификации.
   */
  WEB_ORIGIN: z.string().min(1).default('http://localhost:5173'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Собираем сообщение самостоятельно вместо вывода JSON: список в одну строку
  // на каждую переменную читается в консоли сразу, без прокрутки.
  const lines = parsed.error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(корень)'}: ${issue.message}`,
  );
  throw new Error(
    `Некорректное окружение, сервер не запущен:\n${lines.join('\n')}\n\n` +
      'Подсказка: скопируйте .env.example в .env и заполните значения.',
  );
}

const raw = parsed.data;

/** Абсолютный путь к каталогу данных — его и отдаёт наружу проверка путей. */
const dataDir = isAbsolute(raw.DATA_DIR) ? raw.DATA_DIR : resolve(ROOT, raw.DATA_DIR);

export const env = {
  ...raw,
  ROOT,
  DATA_DIR: dataDir,
  /** true в production: включает строгие настройки безопасности и полные логи. */
  isProduction: raw.NODE_ENV === 'production',
} as const;

export type Env = typeof env;