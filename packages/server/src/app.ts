import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import type { App } from './lib/app-type.js';
import { AppError, type ErrorBody } from './lib/errors.js';
import { registerHealth } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { roomRoutes } from './routes/rooms.js';
import { bookRoutes } from './routes/books.js';
import { registerDataFiles } from './plugins/data-files.js';

/**
 * Сборка приложения без запуска.
 *
 * Отдельный файл от `index.ts` не для красоты: `index.ts` вызывает `main()` при
 * загрузке модуля, и тест, импортирующий его ради `buildServer`, тут же
 * поднял бы сервер и не завершился бы — порт занят, процесс живой. Здесь
 * ничего не запускается при импорте, и тесты берут приложение через `inject()`
 * без сети вообще.
 */

/** Верхняя страховка для загрузки; настоящий лимит — по `kind`, в потоке. */
const AUDIO_LIMIT = 2 * 1_024 * 1_024 * 1_024;

/**
 * Код ответа из произвольной ошибки.
 *
 * Ошибка приходит как `unknown`, и полагаться на то, что у неё есть
 * `statusCode`, нельзя: у Prisma и у внутренних сбоев его нет. Значение
 * проверяется по диапазону, потому что `reply.code()` бросает на значениях вне
 * 100–599, и ошибка при выборе кода должна была бы стать 500, а не упасть.
 */
function statusCodeOf(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
      return value;
    }
  }
  return 500;
}

export async function buildServer(): Promise<App> {
  const app = Fastify({
    loggerInstance: logger,
    // Клиент шлёт X-Forwarded-For от Cloudflare Tunnel. Без `trustProxy`
    // rate-limit считал бы всех клиентов одним адресом — 127.0.0.1 — и первая
    // же компания из двадцати человек упёрлась бы в общий лимит.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  // ─── CORS ───────────────────────────────────────────────────────────────────
  // Ровно один origin. `credentials` нужен для cookie: без него браузер не
  // пришлёт `rd_token` на запросы к API.
  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // ─── Rate limit ────────────────────────────────────────────────────────────
  // Общий предел защищает сервер в целом.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  // ─── Ошибки ────────────────────────────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } } as ErrorBody);
    }

    // Нарушение схемы Zod — это ошибка запроса, а не сервера. Отдаём 400 с
    // перечнем полей: иначе клиент покажет пользователю «что-то пошло не так».
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'validation_failed',
          message: 'Проверьте заполнение полей',
          details: { fields: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        },
      } as ErrorBody);
    }

    // Всё остальное — внутреннее. Клиенту нейтральный текст, подробности в лог:
    // в сообщении Prisma названия таблиц и колонок.
    const statusCode = statusCodeOf(error);
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'внутренняя ошибка');
    } else {
      request.log.warn({ err: error, statusCode }, 'запрос отклонён');
    }
    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'internal_error' : 'request_failed',
        message: statusCode >= 500 ? 'Внутренняя ошибка сервера' : 'Запрос отклонён',
      },
    } as ErrorBody);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'not_found', message: `Маршрут ${request.method} ${request.url} не найден` },
    } as ErrorBody),
  );

  // ─── Cookie ─────────────────────────────────────────────────────────────────
  // Нужен для `rd_token`: статику браузер не умеет отдавать с заголовком
  // Authorization, а защищать её надо — иначе файлы книги доступны всем, кто
  // знает путь.
  //
  // Подпись не нужна: токен не читается из cookie как из сессии, он в ней
  // просто лежит и идёт в sha256 наравне с заголовком. Проверять подпись всё
  // равно нечем — сервер сверяет токен с базой.
  await app.register(cookie);

  // ─── Загрузка файлов ───────────────────────────────────────────────────────
  // Предел здесь — только верхняя страховка (2 ГБ + немного на поля формы).
  // Настоящий лимит проверяется в потоке по полю `kind`: 50 МБ для текста и
  // 2 ГБ для аудио. Общий предел не может быть один, потому что текст и аудио
  // отличаются на порядок.
  await app.register(multipart, {
    limits: {
      fileSize: AUDIO_LIMIT + 1_024 * 1_024,
      files: 1,
      fields: 20,
      // Поля формы приходят раньше файла; суммарно они весят копейки, но
      // ограничение защищает от запроса с тысячей мелких полей.
      fieldSize: 8 * 1_024,
    },
  });

  // ─── Маршруты и плагины ────────────────────────────────────────────────────
  await registerHealth(app);

  // Строгий лимит живёт в одном encapsulated-контексте с маршрутами входа.
  //
  // Отдельная регистрация с `prefix: '/api/auth'` не сработала бы: хук
  // @fastify/rate-limit висит на маршрутах, объявленных в его же контексте, а
  // пока таких маршрутов нет, запрос уходит в общий 404 мимо ограничения. Это
  // было проверено — 12 запросов при лимите 10 дали 12 ответов 404 и ни одного
  // 429. Теперь маршруты здесь же, и лимит применяется к ним.
  await app.register(
    async (scope) => {
      await scope.register(rateLimit, {
        // Именно true, а не false. У @fastify/rate-limit `global: false`
        // означает «не вешать хуки автоматически, а ограничивать только маршруты
        // с явным config.rateLimit». С ним в этом контексте не было бы ни одного
        // хука, и лимит не срабатывал бы ни разу. `true` означает «вешаем хуки
        // на все маршруты текущего контекста» — а контекст у нас ровно один,
        // это и есть /api/auth.
        global: true,
        max: 10,
        timeWindow: '1 minute',
        // Ключ — адрес, а не токен: иначе перебор разными токенами обходил бы
        // счётчик, и предел на перебор не значил бы ничего.
        keyGenerator: (request) => request.ip,
      });
      await scope.register(authRoutes);
    },
    { prefix: '/api/auth' },
  );

  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(roomRoutes, { prefix: '/api/rooms' });
  await app.register(bookRoutes, { prefix: '/api' });

  await registerDataFiles(app);

  return app;
}