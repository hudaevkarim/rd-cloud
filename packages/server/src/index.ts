import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import type { App } from './lib/app-type.js';
import { AppError, type ErrorBody } from './lib/errors.js';
import { connectDatabase, disconnectDatabase } from './db/client.js';
import { registerHealth } from './routes/health.js';
import { registerDataFiles } from './plugins/data-files.js';
import { registerAuthRateLimit } from './plugins/auth-rate-limit.js';

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

/**
 * Точка входа сервера.
 *
 * Сейчас это проверка связи с базой, три плагина и `/health`. Маршруты
 * `/api/*` и Socket.IO появятся после аутентификации: без неё любой обработчик
 * `/api` был бы доступен всем подряд, и проверять токен в каждом из них
 * пришлось бы заново.
 */
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
  // Ровно один origin. `credentials` нужен, когда клиент перейдёт на cookie;
  // сейчас токен идёт заголовком, но флаг оставлен сразу, чтобы его включение
  // не выглядело забытым.
  await app.register(cors, {
    origin: env.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // ─── Rate limit ────────────────────────────────────────────────────────────
  // Общий предел защищает сервер в целом. Строгий предел на /api/auth — там,
  // где перебирают токены, — живёт отдельным плагином: ограничение на префикс
  // внутри @fastify/rate-limit не срабатывает, пока не объявлен хотя бы один
  // маршрут в этом префиксе.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });
  registerAuthRateLimit(app);

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

  // ─── Маршруты и плагины ────────────────────────────────────────────────────
  await registerHealth(app);
  await registerDataFiles(app);

  return app;
}

/** Запуск сервера с корректным закрытием. */
async function main(): Promise<void> {
  const app = await buildServer();

  // База проверяется до `listen`: подняться и не уметь отвечать хуже, чем не
  // подняться вовсе — с туннелем это выглядит как «сайт иногда недоступен».
  await connectDatabase();

  const address = await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ address, env: env.NODE_ENV }, 'сервер запущен');

  // ─── Корректное завершение ─────────────────────────────────────────────────
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'завершение работы');

    // Сначала перестаём принимать соединения, потом закрываем пул. Обратный
    // порядок оставил бы запросы, для которых база уже недоступна.
    const timer = setTimeout(() => {
      logger.error('не дождались завершения за 10 с, выхожу принудительно');
      process.exit(1);
    }, 10_000);
    timer.unref();

    try {
      await app.close();
      await disconnectDatabase();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'ошибка при завершении');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // Windows не отправляет SIGTERM, а сочетание Ctrl+C иной раз обрывает
  // процесс без всякого завершения. Поэтому дополнительно ловим
  // необработанные ошибки: иначе они тихо уронили бы сервер без записи в лог.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'необработанное отклонение промиса');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'необработанное исключение');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // Ошибка на старте (нет базы, занятый порт, битая переменная окружения)
  // должна быть видна в консоли, а не раствориться в промис-отклонении.
  logger.fatal({ err: error }, 'сервер не запустился');
  process.exit(1);
});
