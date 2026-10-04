import type { FastifyReply, FastifyRequest } from 'fastify';
import type { User } from '../generated/prisma/client.js';
import { prisma } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { hashToken } from './tokens.js';

/**
 * Тип пользователя в запросе.
 *
 * Объявление модуля добавляет поле в `FastifyRequest`, поэтому в обработчиках
 * после `requireAuth` поле доступно без приведения типов. Оно опциональное:
 * хук мог не отработать, и утверждать обратное значило бы врать компилятору.
 * Забрать пользователя помогает `currentUser` — он падает, если хук забыли.
 */
declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
}

export {};

/** Имя cookie с токеном. Одно на всё приложение. */
export const TOKEN_COOKIE = 'rd_token';

/**
 * Токен из запроса.
 *
 * Три источника, и это не избыточность:
 *
 *   1. `Authorization: Bearer` — основной для `/api`. Клиент держит токен в
 *      localStorage и шлёт заголовком; заголовок не попадает в историю
 *      браузера и не в `Referer`.
 *   2. Cookie `rd_token` — для статики. Браузер не умеет вешать
 *      `Authorization` на `<img>` и `<audio>`, а в `<video src>` тем более.
 *   3. `?t=` — только для статики, и только по явному разрешению вызывающего.
 *
 * Про query-параметр: он нужен `<audio>` и `<img>`, но на `/api` его быть не
 * должно — токен в URL попадает в логи веб-сервера, в историю браузера и в
 * заголовок `Referer` при переходе на другой сайт. Поэтому `allowQuery`
 * выключен по умолчанию, а включается только плагином раздачи файлов.
 */
export function extractToken(
  request: FastifyRequest,
  options: { allowQuery?: boolean } = {},
): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    const value = match?.[1]?.trim();
    if (value !== undefined && value !== '') return value;
  }

  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  const fromCookie = cookies?.[TOKEN_COOKIE];
  if (typeof fromCookie === 'string' && fromCookie !== '') return fromCookie;

  if (options.allowQuery === true) {
    const query = request.query as { t?: unknown } | undefined;
    const fromQuery = query?.t;
    if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
  }

  return null;
}

/**
 * Хук `preHandler`: требует действующий токен и кладёт пользователя в запрос.
 *
 * Порядок проверок выбран так, чтобы наружу не утекло, что именно не так:
 * пустой токен и неверный токен дают один и тот же 401 с одинаковым текстом.
 * Различать их не нужно, а вот различать полезно было бы — если бы злоумышленник
 * знал, какие токены настоящие, он знал бы и границу возможного перебора.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractToken(request, { allowQuery: false });
  if (token === null) throw AppError.unauthorized('Требуется токен');

  // Ищем по хешу, а не сверяем пользователей в цикле: в базе 20–1000 записей,
  // а хеш уникален и индексован.
  const user = await prisma.user.findUnique({ where: { tokenHash: hashToken(token) } });
  if (user === null) throw AppError.unauthorized('Неверный токен');

  request.user = user;
}

/**
 * Хук `preHandler`: `requireAuth` плюс проверка роли.
 *
 * Токен проверяется здесь же, а не «наследуется» из предыдущего хука: любой
 * обработчик может быть вызван с `preHandler: [requireAdmin]` без
 * `requireAuth`, и отсутствие пользователя должно давать 401, а не
 * `undefined.role`.
 */
export async function requireAdmin(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  await requireAuth(request, _reply);

  if (request.user?.role !== 'admin') {
    throw AppError.forbidden('Недостаточно прав');
  }
}

/**
 * Пользователь из запроса, с проверкой.
 *
 * Вызывать из обработчиков, которые защищены `requireAuth`/`requireAdmin`.
 * Бросает 401, если хук по какой-то причине не отработал: тихо вернуть
 * «пользователя нет» значило бы выполнить запрос без проверки прав.
 */
export function currentUser(request: FastifyRequest): User {
  const user = request.user;
  if (user === undefined) throw AppError.unauthorized();
  return user;
}

/**
 * То же, но для администратора — для страниц, где действие доступно только ему.
 * Дублирует проверку `requireAdmin` нарочно: проверка прав не должна зависеть от
 * того, как именно собрана цепочка хуков маршрута.
 */
export function currentAdmin(request: FastifyRequest): User {
  const user = currentUser(request);
  if (user.role !== 'admin') throw AppError.forbidden('Недостаточно прав');
  return user;
}