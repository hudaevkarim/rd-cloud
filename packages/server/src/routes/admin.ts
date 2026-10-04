import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { requireAdmin, currentAdmin } from '../auth/guards.js';
import { generateToken, hashToken } from '../auth/tokens.js';

/**
 * Админ-панель.
 *
 * Все маршруты под `requireAdmin`. Отдельная функция проверки роли не
 * наследуется по цепочке хуков: любой маршрут может быть вызван с
 * `preHandler: [requireAdmin]` и обязан сам проверить и токен, и роль.
 */

const createUserBody = z.object({
  username: z
    .string()
    .trim()
    .min(1, 'Укажите имя пользователя')
    .max(64, 'Слишком длинное имя')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Только латиница, цифры, дефис и подчёркивание'),
  displayName: z.string().trim().min(1, 'Укажите отображаемое имя').max(128),
  role: z.enum(['user', 'admin']).default('user'),
});

const idParams = z.object({ id: z.string().min(1) });

/** Список пользователей. Токены не отдаются — даже хеши. */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAdmin);

  app.get('/users', async () => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        createdAt: true,
        lastSeenAt: true,
        _count: { select: { comments: true, memberships: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { users };
  });

  /**
   * Создание пользователя.
   *
   * Токен возвращается здесь и больше нигде: в базе лежит только его sha256,
   * и восстановить токен из хеша нельзя. Админ раздаёт его лично.
   *
   * Если username занят — 409, а не 500: это ожидаемое состояние, и отдельная
   * ошибка позволяет клиенту сказать человеку «имя занято», а не «что-то
   * пошло не так».
   */
  app.post('/users', async (request, reply) => {
    const body = createUserBody.parse(request.body ?? {});

    const token = generateToken();
    try {
      const user = await prisma.user.create({
        data: {
          username: body.username,
          displayName: body.displayName,
          role: body.role,
          tokenHash: hashToken(token),
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          createdAt: true,
          lastSeenAt: true,
        },
      });
      // 201: ресурс создан. Тело содержит токен — единственный раз, когда он
      // покидает сервер.
      return reply.code(201).send({ user, token });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw AppError.conflict(`Пользователь «${body.username}» уже есть`);
      }
      throw error;
    }
  });

  /**
   * Удаление пользователя.
   *
   * Себя удалить нельзя: администратор обычно один, и его удаление оставило бы
   * систему без возможности зайти. 400, а не 403 — запрос выполнить нельзя по
   * смыслу, а не из-за прав.
   *
   * Всё связанное уходит каскадом: комнаты, комментарии, реакции, уведомления,
   * загруженные книги остаются, но теряют автора (`SetNull` на `Book`).
   * На диске останутся файлы книг — их убирать нужно отдельно, на файловой
   * операции, а не каскадом в базе.
   */
  app.delete('/users/:id', async (request) => {
    const admin = currentAdmin(request);
    const { id } = idParams.parse(request.params);

    if (id === admin.id) {
      throw AppError.badRequest('Нельзя удалить самого себя');
    }

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (existing === null) throw AppError.notFound('Пользователь');

    await prisma.user.delete({ where: { id } });
    return { ok: true };
  });

  /** Список комнат с числом участников и книг — для глазами админа. */
  app.get('/rooms', async () => {
    const rooms = await prisma.room.findMany({
      select: {
        id: true,
        name: true,
        description: true,
        isPublic: true,
        inviteCode: true,
        createdAt: true,
        owner: { select: { id: true, username: true, displayName: true } },
        _count: { select: { members: true, books: true, comments: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return { rooms };
  });

  /**
   * Удаление комнаты.
   *
   * Каскад снесёт участников, книги-связи, комментарии, presence и заявки.
   * Сами книги останутся в каталоге: они могут быть в других комнатах.
   */
  app.delete('/rooms/:id', async (request) => {
    const { id } = idParams.parse(request.params);

    const existing = await prisma.room.findUnique({ where: { id }, select: { id: true } });
    if (existing === null) throw AppError.notFound('Комната');

    await prisma.room.delete({ where: { id } });
    return { ok: true };
  });

  /**
   * Статистика для главной страницы админки.
   *
   * Размер файлов берётся суммой по колонке, а не подсчётом файлов на диске:
   * на диске лежат ещё и производные главы, и их размер к размеру книг
   * отношения не имеет.
   */
  app.get('/stats', async () => {
    const [users, rooms, books, comments, fileStats] = await Promise.all([
      prisma.user.count(),
      prisma.room.count(),
      prisma.book.count(),
      prisma.comment.count(),
      prisma.bookFile.aggregate({ _sum: { fileSize: true }, _count: { id: true } }),
    ]);

    return {
      users,
      rooms,
      books,
      comments,
      files: fileStats._count.id,
      totalFileSize: fileStats._sum.fileSize ?? 0,
    };
  });
};

/**
 * Нарушение уникальности.
 *
 * Импорт типа Prisma и сравнение с `P2002` — единственное место в проекте, где
 * эта магическая строка появляется; в маршрутах её нет.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}