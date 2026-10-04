import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { requireAuth, currentUser, TOKEN_COOKIE } from '../auth/guards.js';
import { hashToken } from '../auth/tokens.js';
import { env } from '../env.js';
import type { User } from '../generated/prisma/client.js';

/**
 * Маршруты аутентификации.
 *
 * Токен в ответе не возвращается: клиент его уже знает — он его прислал.
 * Возвращать его снова значило бы отправить секрет вторым независимым каналом,
 * и любая небрежность в логах на этой строке его бы засветила.
 */

const loginBody = z.object({
  token: z
    .string()
    .min(1, 'Укажите токен')
    .max(512, 'Слишком длинный токен'),
});

/** Публичное представление пользователя. То же самое отдаёт `GET /api/auth/me`. */
function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    avatar: user.avatar,
    bio: user.bio,
  };
}

/** Параметры cookie, общие для установки и удаления. */
function cookieOptions() {
  return {
    httpOnly: true,
    // Lax, а не Strict: Strict не отправил бы cookie при переходе по ссылке из
    // мессенджера — а именно так чаще всего попадают в приложение.
    //
    // Оговорка про разработку: Lax не переносит cookie в XHR и в `<img>` с
    // ДРУГОГО origin. На :5173 против :3000 это ровно тот случай, и там cookie
    // не приедет. Поэтому клиент в разработке обязан ходить через прокси Vite
    // (тогда всё одноorigin) либо передавать токен заголовком и в `?t=`.
    sameSite: 'lax' as const,
    // Secure обязателен в production: иначе cookie уедет открытым текстом.
    // В development его нет — иначе браузер не примет cookie с http://localhost.
    secure: env.isProduction,
    path: '/',
    // Токен бессрочный, поэтому и cookie бессрочная: год — достаточно, чтобы
    // не пришлось вводить его каждый год заново, но достаточно мало, чтобы
    // устаревший не жил вечно.
    maxAge: 60 * 60 * 24 * 365,
  };
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * `POST /api/auth/login` — проверка токена.
   *
   * Стоит cookie, чтобы статику можно было отдавать защищённо: заголовок
   * `Authorization` браузер не умеет навесить на `<img>` и `<audio>`.
   */
  app.post('/login', async (request, reply) => {
    const body = loginBody.parse(request.body ?? {});

    const user = await prisma.user.findUnique({
      where: { tokenHash: hashToken(body.token) },
    });
    if (user === null) {
      // Тот же текст, что и при пустом токене: различие выдало бы, какие
      // токены настоящие.
      throw AppError.unauthorized('Неверный токен');
    }

    // Пишем здесь, а не в requireAuth: захода на /api/auth/me в лог истины
    // не было, а «когда человек последний раз появлялся» — полезно знать.
    // Ошибку обновления глушим: не записали метку — не повод отказывать в
    // успешном входе.
    await prisma.user
      .update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);

    return reply
      .setCookie(TOKEN_COOKIE, body.token, cookieOptions())
      .send({ user: publicUser(user) });
  });

  /** `GET /api/auth/me` — кто я. Нужен клиенту при загрузке страницы. */
  app.get('/me', { preHandler: requireAuth }, async (request) => {
    return { user: publicUser(currentUser(request)) };
  });

  /**
   * `POST /api/auth/logout` — на сервере ничего не происходит.
   *
   * Токен бессрочный и хранится на сервере, отзывать его нечем: он перестанет
   * работать, только если админ сменит его. Метод оставлен, потому что клиенту
   * нужно единое место, где он забывает токен, и «выход» без такого места
   * рано или поздно станет причиной того, что токен остаётся в localStorage.
   * Сбрасывается только cookie — именно то, что сервер и умеет.
   */
  app.post('/logout', async (_request, reply) => {
    return reply.clearCookie(TOKEN_COOKIE, { path: '/' }).send({ ok: true });
  });
};