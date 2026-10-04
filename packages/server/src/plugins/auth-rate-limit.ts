import type { App } from '../lib/app-type.js';

/**
 * Строгий лимит для `/api/auth/*`.
 *
 * Почему не через `@fastify/rate-limit` в отдельном префиксе: такой плагин
 * вешает хук внутри encapsulated-контекста, и хук срабатывает только на
 * маршрутах, объявленных в этом контексте. Пока маршрутов аутентификации нет,
 * запрос уходит в общий 404, и лимит не срабатывает вообще.
 *
 * Это была не теория: при проверке 12 запросов подряд при лимите 10 в минуту
 * пришло 12 ответов 404 и ни одного 429. Код выглядел работающим и не
 * ограничивал ничего.
 *
 * Поэтому счётчик здесь свой, по префиксу пути: он работает независимо от того,
 * объявлен маршрут или нет, и переживёт добавление `/api/auth/login`.
 *
 * Что защищаем: перебор токенов. Ключ — адрес, а не токен: если бы ключом был
 * токен, атакующий, подставляя разные значения, обходил бы счётчик, и лимит на
 * перебор не значил бы ничего.
 *
 * Данные в памяти процесса. Redis в проекте нет, сервер один. После перезапуска
 * счётчик обнуляется — для ноутбука, который и так выключается на ночь, это
 * приемлемо.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const PREFIX = '/api/auth';

interface Bucket {
  count: number;
  resetAt: number;
}

export function registerAuthRateLimit(app: App): void {
  const buckets = new Map<string, Bucket>();

  // Уборка протухшего: иначе карта росла бы бесконечно, по записи на каждый
  // пришедший адрес.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, WINDOW_MS);
  // Таймер не должен держать процесс: сервер обязан завершаться по Ctrl+C.
  sweeper.unref();

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return;

    const now = Date.now();
    const key = request.ip;

    const existing = buckets.get(key);
    const bucket =
      existing === undefined || existing.resetAt <= now
        ? { count: 0, resetAt: now + WINDOW_MS }
        : existing;
    if (bucket !== existing) buckets.set(key, bucket);

    bucket.count += 1;

    if (bucket.count > MAX_REQUESTS) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      request.log.warn({ ip: key, count: bucket.count }, 'превышен лимит входа');
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({
          error: {
            code: 'rate_limited',
            message: 'Слишком много попыток. Попробуйте позже.',
          },
        });
    }
  });
}