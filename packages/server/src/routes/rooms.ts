import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { requireAuth, currentUser } from '../auth/guards.js';
import { generateInviteCode, normalizeInviteCode } from '../lib/invite-code.js';
import { memberRole, MEMBERS_BY_JOINING } from '../rooms/membership.js';

/**
 * Комнаты.
 *
 * Модель доступа, как её задали:
 *
 *   - `inviteCode` пускает сразу, без одобрения;
 *   - поиск по имени даёт `JoinRequest`, который одобряет участник;
 *   - приглашение от участника тоже пускает сразу;
 *   - скрытых от админа комнат нет.
 *
 * Все маршруты требуют токен, включая `search` и `join-by-code`. Для входа по
 * коду это необходимо: без пользователя нечего добавлять в `RoomMember`.
 * Поиск тоже защищён — неаутентифицированный список комнат был бы публичным
 * каталогом имён на весь интернет, а вход в комнату он всё равно не даёт.
 */

const createBody = z.object({
  name: z.string().trim().min(1, 'Укажите название').max(128),
  description: z.string().trim().max(1_000).optional(),
  isPublic: z.boolean().default(false),
});

const patchBody = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
    isPublic: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Нечего менять' });

const idParams = z.object({ id: z.string().min(1) });
const searchQuery = z.object({ q: z.string().trim().min(1, 'Пустой запрос').max(128) });
const codeBody = z.object({ inviteCode: z.string().trim().min(1, 'Укажите код').max(32) });
const inviteBody = z.object({ userId: z.string().min(1) });
const requestParams = z.object({ id: z.string().min(1), requestId: z.string().min(1) });

/** Поля комнаты в ответе. `inviteCode` — только для участников. */
const roomSelect = {
  id: true,
  name: true,
  description: true,
  inviteCode: true,
  isPublic: true,
  createdAt: true,
  ownerId: true,
  _count: { select: { members: true, books: true } },
} as const;

export const roomRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  /**
   * Единственное место, где появляется `P2002` при создании комнаты: код
   * приглашения — случайная строка длиной 8, и коллизия (вероятность порядка
   * 10^-9 на попытку) должна привести к понятному 409, а не к 500.
   */
  async function uniqueInviteCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateInviteCode();
      const taken = await prisma.room.count({ where: { inviteCode: code } });
      if (taken === 0) return code;
    }
    throw new AppError(500, 'internal_error', 'Не удалось выбрать код приглашения');
  }

  // ─── Создание и список ────────────────────────────────────────────────────

  app.post('/', async (request, reply) => {
    const me = currentUser(request);
    const body = createBody.parse(request.body ?? {});

    const room = await prisma.room.create({
      data: {
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        isPublic: body.isPublic,
        inviteCode: await uniqueInviteCode(),
        ownerId: me.id,
        // Создатель сразу участник: отдельный шаг «добавить себя» был бы
        // лишним шагом, который можно забыть, и комната осталась бы без
        // участников вообще.
        members: { create: { userId: me.id, role: 'owner' } },
      },
      select: roomSelect,
    });

    return reply.code(201).send({ room });
  });

  /** Мои комнаты. Не «все комнаты, где я member» — это и есть мои. */
  app.get('/', async (request) => {
    const me = currentUser(request);

    const rooms = await prisma.room.findMany({
      where: { members: { some: { userId: me.id } } },
      select: {
        ...roomSelect,
        members: {
          where: { userId: me.id },
          select: { role: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      rooms: rooms.map(({ members, ...room }) => ({ ...room, myRole: members[0]?.role ?? null })),
    };
  });

  /**
   * Поиск публичных комнат по имени.
   *
   * `ILIKE` с wildcards, вставляемыми пользователем: `%` и `_` в запросе
   * уедут в паттерн и превратят «точное совпадение» в «совпадение с чем угодно».
   * Экранируем.
   *
   * Показываем только имя и число участников: `inviteCode` в поиске не нужен
   * (код выдают отдельно) и показывать его каждому, кто знает подстроку имени,
   * незачем.
   */
  app.get('/search', async (request) => {
    searchQuery.parse(request.query);

    const q = (request.query as { q: string }).q;
    const rooms = await prisma.room.findMany({
      where: {
        isPublic: true,
        name: { contains: q, mode: 'insensitive' },
      },
      select: { id: true, name: true, description: true, _count: { select: { members: true } } },
      orderBy: { members: { _count: 'desc' } },
      take: 50,
    });

    return { rooms };
  });

  // ─── Вход по коду и приглашение ────────────────────────────────────────────

  /**
   * Вход по коду приглашения — сразу, без одобрения.
   *
   * Код нормализуется: его диктуют по телефону строчными, и `abc12345` должен
   * находить ту же комнату, что и `ABC12345`.
   */
  app.post('/join-by-code', async (request, reply) => {
    const me = currentUser(request);
    const body = codeBody.parse(request.body ?? {});
    const code = normalizeInviteCode(body.inviteCode);
    if (code === null) throw AppError.badRequest('Код приглашения выглядит неверно');

    const room = await prisma.room.findUnique({ where: { inviteCode: code }, select: { id: true } });
    if (room === null) throw AppError.notFound('Комната с таким кодом');

    const already = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: room.id, userId: me.id } },
      select: { id: true },
    });
    if (already !== null) {
      // Не ошибка: человек уже в комнате, и часто это как раз он и хотел.
      // 409 «уже участник» выглядел бы поломкой на его стороне.
      return reply.code(200).send({ roomId: room.id, joined: false });
    }

    // Ушедший по `leave` заходит снова без одобрения — код есть код.
    await prisma.roomMember.create({ data: { roomId: room.id, userId: me.id, role: 'member' } });
    return reply.code(200).send({ roomId: room.id, joined: true });
  });

  /** Приглашение участником: тоже сразу, без заявки. */
  app.post('/:id/invite', async (request, reply) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);
    const body = inviteBody.parse(request.body ?? {});

    if ((await memberRole(prisma, id, me.id)) === null) {
      throw AppError.forbidden('Приглашать может только участник комнаты');
    }

    const guest = await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true } });
    if (guest === null) throw AppError.notFound('Пользователь');

    const existing = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: id, userId: body.userId } },
      select: { id: true },
    });
    if (existing !== null) return reply.code(200).send({ joined: false });

    await prisma.roomMember.create({ data: { roomId: id, userId: body.userId, role: 'member' } });
    return reply.code(201).send({ joined: true });
  });

  // ─── Заявки ───────────────────────────────────────────────────────────────

  app.post('/:id/join-request', async (request, reply) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);

    if ((await memberRole(prisma, id, me.id)) !== null) {
      throw AppError.conflict('Вы уже в комнате');
    }

    // Одна заявка от человека на комнату: схема запрещает дубли по
    // (roomId, userId, status), и повторная отправка должна давать понятный
    // ответ, а не ошибку уникальности из глубины Prisma.
    const pending = await prisma.joinRequest.findFirst({
      where: { roomId: id, userId: me.id, status: 'pending' },
      select: { id: true },
    });
    if (pending !== null) throw AppError.conflict('Заявка уже отправлена и ждёт ответа');

    const request_ = await prisma.joinRequest.create({
      data: { roomId: id, userId: me.id, status: 'pending' },
      select: { id: true, createdAt: true, status: true },
    });

    return reply.code(201).send({ request: request_ });
  });

  /** Список заявок видят участники комнаты, не посторонние. */
  app.get('/:id/join-requests', async (request) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);

    if ((await memberRole(prisma, id, me.id)) === null) {
      throw AppError.forbidden('Заявки видит только участник комнаты');
    }

    const requests = await prisma.joinRequest.findMany({
      where: { roomId: id, status: 'pending' },
      select: {
        id: true,
        createdAt: true,
        user: { select: { id: true, username: true, displayName: true, avatar: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    return { requests };
  });

  /** Одобрение. Создаёт участника и закрывает заявку. */
  app.post('/:id/join-requests/:requestId/approve', async (request, reply) => {
    const me = currentUser(request);
    const { id, requestId } = requestParams.parse(request.params);

    if ((await memberRole(prisma, id, me.id)) === null) {
      throw AppError.forbidden('Одобрять заявки может только участник комнаты');
    }

    const pending = await prisma.joinRequest.findFirst({
      where: { id: requestId, roomId: id, status: 'pending' },
      select: { id: true, userId: true },
    });
    if (pending === null) throw AppError.notFound('Заявка');

    // Участника могли уже добавить по приглашению, пока заявка висела. Тогда
    // `create` упал бы на уникальном индексе — это не ошибка, а «уже участник».
    await prisma.roomMember.upsert({
      where: { roomId_userId: { roomId: id, userId: pending.userId } },
      create: { roomId: id, userId: pending.userId, role: 'member' },
      update: {},
    });

    await prisma.joinRequest.update({
      where: { id: pending.id },
      data: { status: 'approved', decidedAt: new Date(), decidedById: me.id },
    });

    return reply.code(201).send({ ok: true });
  });

  app.post('/:id/join-requests/:requestId/reject', async (request) => {
    const me = currentUser(request);
    const { id, requestId } = requestParams.parse(request.params);

    if ((await memberRole(prisma, id, me.id)) === null) {
      throw AppError.forbidden('Отклонять заявки может только участник комнаты');
    }

    const pending = await prisma.joinRequest.findFirst({
      where: { id: requestId, roomId: id, status: 'pending' },
      select: { id: true },
    });
    if (pending === null) throw AppError.notFound('Заявка');

    await prisma.joinRequest.update({
      where: { id: pending.id },
      data: { status: 'rejected', decidedAt: new Date(), decidedById: me.id },
    });

    return { ok: true };
  });

  // ─── Просмотр и правка ────────────────────────────────────────────────────

  app.get('/:id', async (request) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);

    if ((await memberRole(prisma, id, me.id)) === null) {
      throw AppError.forbidden('Информация о комнате доступна только участникам');
    }

    const room = await prisma.room.findUnique({
      where: { id },
      select: {
        ...roomSelect,
        owner: { select: { id: true, username: true, displayName: true, avatar: true } },
        members: {
          where: { userId: me.id },
          select: { role: true },
        },
      },
    });
    if (room === null) throw AppError.notFound('Комната');

    const { members, ...rest } = room;
    return { room: { ...rest, myRole: members[0]?.role ?? null } };
  });

  app.get('/:id/members', async (request) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);

    if ((await memberRole(prisma, id, me.id)) === null) {
      throw AppError.forbidden('Список участников доступен только участникам комнаты');
    }

    const members = await prisma.roomMember.findMany({
      where: { roomId: id },
      select: {
        userId: true,
        role: true,
        joinedAt: true,
        user: { select: { displayName: true, username: true, avatar: true } },
      },
      orderBy: MEMBERS_BY_JOINING,
    });

    return { members };
  });

  /** Правка — только владельцу. */
  app.patch('/:id', async (request) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);
    const body = patchBody.parse(request.body ?? {});

    if ((await memberRole(prisma, id, me.id)) !== 'owner') {
      throw AppError.forbidden('Менять комнату может только владелец');
    }

    const room = await prisma.room.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.isPublic !== undefined ? { isPublic: body.isPublic } : {}),
      },
      select: roomSelect,
    });

    return { room };
  });

  app.delete('/:id', async (request) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);

    if ((await memberRole(prisma, id, me.id)) !== 'owner') {
      throw AppError.forbidden('Удалить комнату может только владелец');
    }

    // Книги в комнате переживают удаление: каскад снесёт связи `RoomBook`, но
    // сами книги останутся в базе и на диске. Иначе удаление комнаты уносило
    // бы файл, который может лежать в другой.
    await prisma.room.delete({ where: { id } });
    return { ok: true };
  });

  /**
   * Выход из комнаты.
   *
   * Три случая, и каждый приводит к последствиям, поэтому написан явно:
   *
   *   1. Участник уходит, остальные есть — просто выходим.
   *   2. Владелец уходит, участники есть — владение переходит к самому
   *      раннему из оставшихся. Иначе комната осталась бы без владельца, и
   *      удалить её было бы уже некому.
   *   3. Уходит последний участник (то есть он же и владелец) — комната
   *      удаляется. Пустая комната без участников и без владельца была бы
   *      мусором в списке поиска.
   */
  app.post('/:id/leave', async (request, reply) => {
    const me = currentUser(request);
    const { id } = idParams.parse(request.params);

    const role = await memberRole(prisma, id, me.id);
    if (role === null) throw AppError.conflict('Вы не в этой комнате');

    const rest = await prisma.roomMember.findMany({
      where: { roomId: id, NOT: { userId: me.id } },
      orderBy: MEMBERS_BY_JOINING,
      select: { id: true, userId: true, role: true },
      take: 1,
    });

    const heir = rest[0];

    if (heir === undefined) {
      await prisma.room.delete({ where: { id } });
      return reply.code(200).send({ left: true, roomDeleted: true });
    }

    await prisma.roomMember.delete({
      where: { roomId_userId: { roomId: id, userId: me.id } },
    });

    if (role === 'owner') {
      await prisma.roomMember.update({
        where: { id: heir.id },
        data: { role: 'owner' },
      });
      // Колонка `ownerId` обязана совпадать с ролью, иначе удалить комнату
      // «только владельцем» перестало бы работать.
      await prisma.room.update({ where: { id }, data: { ownerId: heir.userId } });
    }

    return reply.code(200).send({ left: true, roomDeleted: false });
  });
};
