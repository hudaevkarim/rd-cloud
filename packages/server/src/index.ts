import { env } from './env.js';
import { logger } from './lib/logger.js';
import { buildServer } from './app.js';
import { connectDatabase, disconnectDatabase } from './db/client.js';
import { createSocketServer, closeSocketServer } from './ws/io.js';
import { debugIo } from './ws/broadcast.js';

/**
 * Точка входа сервера.
 *
 * Сборка приложения живёт в `app.ts`, а этот файл только запускает. Разделение
 * нужно тестам: они импортируют `app.ts` и получают приложение без
 * побочных эффектов, тогда как импорт `index.ts` поднял бы сервер и занял порт.
 */

/** Запуск сервера с корректным закрытием. */
async function main(): Promise<void> {
  const app = await buildServer();

  // База проверяется до `listen`: подняться и не уметь отвечать хуже, чем не
  // подняться вовсе — с туннелем это выглядит как «сайт иногда недоступен».
  await connectDatabase();

  const address = await app.listen({ host: env.HOST, port: env.PORT });

  // Сокеты цепляются к уже слушающему серверу. Отдельный порт не нужен:
  // `engine.io` отдаёт запросы не-сокетов прежним слушателям, поэтому Fastify
  // продолжает обслуживать API и раздачу файлов без правок.
  const io = await createSocketServer(app.server);
  logger.info({ address, env: env.NODE_ENV, io: debugIo() }, 'сервер запущен');

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
      // Сокеты закрываются первыми: у них свои таймеры, и `engine.io` не дал бы
      // процессу завершиться. `app.close()` останавливает HTTP-сервер.
      await closeSocketServer(io);
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