import { prisma } from '../db/client.js';
import type { App } from '../lib/app-type.js';

/**
 * `/health` — две вещи: сервер жив и база отвечает.
 *
 * Проверка базы здесь не для красоты. Сервер может подняться с настроенной, но
 * недоступной базой — например, если Postgres ещё не запущен, а через минуту
 * кто-то перезапустит ноутбук и забудет про него. Если `/health` отвечает
 * только «сервер жив», такой экземпляр выглядит исправным, пока каждый запрос
 * к данным падает. С Cloudflare Tunnel, который сам перезапускает туннель, это
 * превращается в «сайт то работает, то нет» без внятной причины.
 */
export async function registerHealth(app: App): Promise<void> {
  app.get('/health', async (_request, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return reply.send({ status: 'ok' });
    } catch (error) {
      // 503, а не 500: «жив, но не готов» и «упал» — разные вещи, и по коду их
      // можно различить, не читая логов.
      app.log.error({ err: error }, 'база данных недоступна');
      return reply.code(503).send({ status: 'error', database: 'unavailable' });
    }
  });
}