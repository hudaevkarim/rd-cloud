import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { prisma } from '../db/client.js';
import { AppError } from '../lib/errors.js';
import { requireAuth, currentUser } from '../auth/guards.js';
import { canAccessRoom, memberRole } from '../rooms/membership.js';
import { describeIssues, validateAnchor, type AnyAnchor } from '@rd/shared/anchors';
import { notify, notifyMany } from '../lib/notify.js';
import {
  commentCreated,
  commentDeleted,
  commentUpdated,
  reactionChanged,
} from '../ws/broadcast.js';
import type { WireComment } from '../ws/types.js';

/**
 * Комментарии.
 *
 * ─── Якорь проверяется, а не принимается ─────────────────────────────────────
 *
 * `anchor` лежит в колонке `Json`, и Prisma не смотрит на её содержимое: туда
 * попадёт буквально что угодно. Без проверки на записи в базе копится мусор,
 * который не разрешится никогда: комментарий с `start: -5` или с аудио-якорем
 * у текстового файла нельзя ни найти в книге, ни показать в интерфейсе.
 *
 * `anchorType` вычисляется из якоря, а не принимается от клиента. Это не
 * формальность: колонка `anchorType` — индекс для выборок, и если бы клиент
 * мог её заполнить, индекс разошёлся бы с содержимым и поиск по «глава N»
 * молча терял бы комментарии. Значение приходит только из `validateAnchor` —
 * так они не могут разойтись.
 *
 * ─── Вложенность ровно один уровень ──────────────────────────────────────────
 *
 * Ответ на ответ — 400. Три уровня в комнате на телефоне не читаются, а
 * удаление такого треда одним каскадом пугает сильнее, чем польза от третьего
 * уровня.
 *
 * ─── Пагинация курсорная, по корневым ────────────────────────────────────────
 *
 * Страница считается по корневым комментариям, ответы приезжают вместе со
 * своими. Иначе страница могла бы оказаться целиком из ответов на один
 * комментарий — это не «ещё 50 просмотренных», а 50 повторов.
 */

/**
 * Реакции, на которые человек смотрит.
 *
 * Список закрытый не из декоративности: эмодзи попадают в интерфейс как
 * текст, и произвольная строка оттуда — это способ вставить в чужой интерфейс
 * что угодно, включая невидимые символы. Шесть значений покрывают реакцию,
 * от которой зависит чтение, и не дают превратить обсуждение в смайликовую
 * кашу.
 *
 * Пробелов внутри не должно быть: «🤔» и « 🤔» — разные строки, и опечатка
 * проявилась бы как «реакция на 🧐 не работает».
 */
const EMOJI = ['👍', '❤️', '😄', '🤔', '😢', '🎉'] as const;
export type ReactionEmoji = (typeof EMOJI)[number];

/** Сколько записей забираем за раз, пока клиент не попросит иначе. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const roomBookParams = z.object({
  roomId: z.string().min(1),
  bookId: z.string().min(1),
});

const commentParams = z.object({ id: z.string().min(1) });

const listQuery = z.object({
  chapter: z.coerce.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  bookFileKind: z.enum(['text', 'audio']).optional(),
  anchorType: z.enum(['text', 'timestamp', 'page']).optional(),
});

/**
 * Тело создания комментария.
 *
 * `anchorType` здесь нет намеренно: если бы он был в схеме, zod отверг бы его
 * как «лишний ключ», а человеку нужен ответ «поле только для чтения». Такая
 * проверка живёт в обработчике до разбора тела.
 */
const createBody = z.object({
  text: z.string().trim().min(1, 'Комментарий не может быть пустым').max(5_000),
  bookFileKind: z.enum(['text', 'audio']),
  anchor: z.unknown(),
  parentId: z.string().min(1).optional(),
  isSpoiler: z.boolean().default(false),
});

const patchBody = z.object({
  text: z.string().trim().min(1, 'Комментарий не может быть пустым').max(5_000),
});

const reactionBody = z.object({ emoji: z.enum(EMOJI) });

// ─── Курсор ────────────────────────────────────────────────────────────────────

interface Cursor {
  createdAt: string;
  id: string;
}

/**
 * Курсор — пара «время, идентификатор» в base64url.
 *
 * По одному `createdAt` курсор построить нельзя: комментарии одного часа
 * (`createdAt` с точностью до миллисекунды) делят метку, и страница либо
 * теряла бы записи, либо повторяла их. Идентификатор делает сравнение
 * строгим, а base64url — нечитаемым для пользователя, который подсмотрит его
 * в адресной строке.
 */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  const raw = `${row.createdAt.toISOString()}|${row.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeCursor(value: string): Cursor {
  let text: string;
  try {
    text = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw AppError.badRequest('Курсор повреждён');
  }
  const at = text.lastIndexOf('|');
  if (at <= 0) throw AppError.badRequest('Курсор повреждён');

  const createdAt = text.slice(0, at);
  const id = text.slice(at + 1);
  if (Number.isNaN(Date.parse(createdAt)) || id === '') {
    throw AppError.badRequest('Курсор повреждён');
  }
  return { createdAt, id };
}

// ─── Форма ответа ──────────────────────────────────────────────────────────────

const authorSelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
} as const;

const commentSelect = {
  id: true,
  roomId: true,
  bookId: true,
  bookFileKind: true,
  text: true,
  anchor: true,
  anchorType: true,
  isSpoiler: true,
  isResolved: true,
  parentId: true,
  createdAt: true,
  editedAt: true,
  user: { select: authorSelect },
  reactions: { select: { emoji: true, userId: true } },
} as const;

type CommentRow = {
  id: string;
  roomId: string;
  bookId: string;
  bookFileKind: string;
  text: string;
  anchor: unknown;
  anchorType: string;
  isSpoiler: boolean;
  isResolved: boolean;
  parentId: string | null;
  createdAt: Date;
  editedAt: Date | null;
  user: { id: string; username: string; displayName: string; avatar: string | null };
  reactions: Array<{ emoji: string; userId: string }>;
};

/**
 * Комментарий в том виде, в каком его видит клиент.
 *
 * Возвращается уже в **проводном** формате: даты — строками ISO, `anchorType` —
 * узким типом. Fastify сериализует `Date` в ISO сам, так что JSON-ответ от
 * этого не меняется, но сокет отдаёт объект напрямую, минуя сериализацию. Если
 * бы здесь остались `Date`, REST-ответ был бы правильным, а
 * `comment:new` — с датой в виде объекта, и клиент получил бы два разных
 * формата одного и того же поля.
 *
 * Реакции сворачиваются в группы: без группировки десять одинаковых «👍»
 * занимали бы столько же места, сколько десять разных эмодзи, а интерфейс
 * всё равно показывает «👍 ×10». `userIds` оставлены, чтобы интерфейс мог
 * показать, кто именно поставил.
 */
export function toComment(row: CommentRow): WireComment {
  const groups = new Map<string, string[]>();
  for (const reaction of row.reactions) {
    const list = groups.get(reaction.emoji);
    if (list === undefined) groups.set(reaction.emoji, [reaction.userId]);
    else list.push(reaction.userId);
  }

  // `anchorType` в базе — строка. Сужаем явно и всё остальное считаем
  // неизвестным: клиент выбирает представление по этому значению, и
  // незнакомое значение означало бы «показать как есть», то есть тихо.
  const anchorType =
    row.anchorType === 'text' || row.anchorType === 'timestamp' || row.anchorType === 'page'
      ? row.anchorType
      : 'text';

  return {
    id: row.id,
    bookFileKind: row.bookFileKind,
    text: row.text,
    anchor: row.anchor as AnyAnchor,
    anchorType,
    isSpoiler: row.isSpoiler,
    isResolved: row.isResolved,
    parentId: row.parentId,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt === null ? null : row.editedAt.toISOString(),
    author: row.user,
    reactions: [...groups.entries()]
      .map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }))
      .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji)),
  };
}

export const commentRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  /**
   * Проверка доступа: книга должна лежать в комнате, и пользователь — иметь доступ
   * к комнате.
   *
   * Именно участником или админом, а не «любым авторизованным»: комната
   * приватная, и её комментарии — её содержимое. Случайно знающий идентификатор
   * книги не должен открывать переписку.
   *
   * ─── Почему через `canAccessRoom`, а не своей проверкой ─────────────────────
   *
   * Здесь стояла своя проверка на `memberRole`, и она отличалась от соседних:
   * админ читал книгу, но не видел её комментариев. Расхождение между
   * проверками доступа хуже любого отдельного решения — при разборе невозможно
   * понять, что имелось в виду. Правило одно и живёт в `canAccessRoom`.
   */
  async function requireRoomAndBook(
    roomId: string,
    bookId: string,
    user: { id: string; role: string },
  ): Promise<void> {
    if (!(await canAccessRoom(prisma, roomId, user)).ok) {
      throw AppError.forbidden('Комментарии доступны только участникам комнаты');
    }
    const link = await prisma.roomBook.findUnique({
      where: { roomId_bookId: { roomId, bookId } },
      select: { bookId: true },
    });
    if (link === null) throw AppError.notFound('Книга в этой комнате');
  }

  // ─── Список ─────────────────────────────────────────────────────────────────

  app.get('/rooms/:roomId/books/:bookId/comments', async (request) => {
    const me = currentUser(request);
    const { roomId, bookId } = roomBookParams.parse(request.params);
    const query = listQuery.parse(request.query ?? {});

    await requireRoomAndBook(roomId, bookId, me);

    // Страница считается по корневым: `parentId IS NULL`. Ответы приезжают
    // вместе со своими корневыми.
    const conditions: Prisma.Sql[] = [
      Prisma.sql`"roomId" = ${roomId}`,
      Prisma.sql`"bookId" = ${bookId}`,
      Prisma.sql`"parentId" IS NULL`,
    ];
    if (query.bookFileKind !== undefined) {
      conditions.push(Prisma.sql`"bookFileKind" = ${query.bookFileKind}`);
    }
    if (query.anchorType !== undefined) {
      conditions.push(Prisma.sql`"anchorType" = ${query.anchorType}`);
    }
    if (query.chapter !== undefined) {
      // Глава живёт внутри JSON-якоря, и Prisma не умеет фильтровать по нему.
      // Текстовое ограничение обязательно: у аудио-якоря `chapterIndex` нет, и
      // без него `COALESCE` вернул бы −1 и в выборку попали бы чужие записи.
      conditions.push(
        Prisma.sql`"anchorType" = 'text' AND COALESCE((anchor->>'chapterIndex')::int, -1) = ${query.chapter}`,
      );
    }
    if (query.cursor !== undefined) {
      const cursor = decodeCursor(query.cursor);
      // ─── Здесь обязателен объект Date, а не строка ──────────────────────────
      //
      // Prisma 7 через `@prisma/adapter-pg` связывает параметры типа `Date` как
      // стенное время без смещения. На машине с `TimeZone = Europe/Saratov`
      // (+04) значение `2026-01-01T00:00:00.245Z` записывается в базу как
      // `2026-01-01 00:00:00.245+04` — это на четыре часа раньше.
      //
      // Обратно Prisma читает ту же строку обратно как `.245Z`, поэтому у себя
      // всё согласовано, и `findMany({ createdAt: { gt: Date } })` работает.
      // А вот Postgres, разбирая строковый литерал `'...Z'::timestamptz` по
      // правилам ISO 8601, понимает его правильно и получает
      // `2026-01-01 04:00:00.245+04` — на четыре часа позже. Сравнение с
      // сохранённым значением даёт «больше», то есть отсекает всё.
      //
      // Наблюдалось как пустая вторая страница: 60 комментариев, страница 1 из
      // 50, страница 2 — ноль строк при `total = 60`.
      //
      // Поэтому смещение не приводится и не передаётся строкой: параметр
      // связывается ровно так же, как Prisma связывает его при записи. Порядок
      // обхода задаёт та же база, что и запись, — смещение сокращается.
      //
      // Переход на строковые литералы в этом условии молча ломает пагинацию.
      const at = new Date(cursor.createdAt);
      if (Number.isNaN(at.getTime())) throw AppError.badRequest('Курсор повреждён');
      // Сравнение пары: строго «после», без пропусков и повторов при равных
      // метках времени.
      conditions.push(Prisma.sql`("createdAt", id) > (${at}, ${cursor.id})`);
    }

    // Забираем на одну строку больше, чтобы узнать про `hasMore`, не считая
    // всего остатка: `count` на каждой странице дорог и не нужен.
    const take = query.limit + 1;
    const ids = await prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>(
      Prisma.sql`
        SELECT id, "createdAt" FROM "Comment"
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY "createdAt" ASC, id ASC
        LIMIT ${take}
      `,
    );

    const hasMore = ids.length > query.limit;
    const page = ids.slice(0, query.limit);

    if (page.length === 0) {
      return { comments: [], hasMore: false, nextCursor: null };
    }

    const rows = await prisma.comment.findMany({
      where: { id: { in: page.map((r) => r.id) } },
      select: {
        ...commentSelect,
        replies: {
          select: commentSelect,
          orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
        },
      },
    });

    // Порядок задаёт выборка идентификаторов, а не `findMany`: тот вернёт
    // строки в произвольном порядке, и страница оказалась бы перемешанной.
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      comments: page.map((entry) => {
        const row = byId.get(entry.id);
        if (row === undefined) throw new Error(`Комментарий ${entry.id} исчез между запросами`);
        return { ...toComment(row), replies: row.replies.map(toComment) };
      }),
      hasMore,
      nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
    };
  });

  /**
   * Сводка для оглавления: сколько всего комментариев и как они разложены.
   *
   * Одна выборка вместо трёх: `groupBy` по `anchorType` не может разложить по
   * главам, а глава лежит в JSON, и два запроса означали бы два обхода таблицы
   * при открытии каждой книги.
   */
  app.get('/rooms/:roomId/books/:bookId/comments/count', async (request) => {
    const me = currentUser(request);
    const { roomId, bookId } = roomBookParams.parse(request.params);

    await requireRoomAndBook(roomId, bookId, me);

    const rows = await prisma.$queryRaw<
      Array<{
        bucket: string;
        anchorType: string;
        count: bigint;
      }>
    >`
      SELECT
        CASE WHEN "anchorType" = 'text' THEN 'chapter:' || COALESCE(anchor->>'chapterIndex', '?')
             ELSE 'type:' || "anchorType" END AS bucket,
        "anchorType",
        count(*) AS count
      FROM "Comment"
      WHERE "roomId" = ${roomId} AND "bookId" = ${bookId} AND "parentId" IS NULL
      GROUP BY 1, 2
    `;

    const byChapter: Record<string, number> = {};
    const byAnchorType: Record<string, number> = {};
    let total = 0;

    for (const row of rows) {
      // bigint не сериализуется в JSON: клиент получил бы ошибку разбора.
      const count = Number(row.count);
      total += count;
      // Итог прибавляется, а не заменяется: текстовые комментарии дают столько
      // строк, сколько глав, и простое присваивание оставляло бы число от
      // последней главы вместо суммы по всем.
      byAnchorType[row.anchorType] = (byAnchorType[row.anchorType] ?? 0) + count;

      if (row.anchorType === 'text' && row.bucket.startsWith('chapter:')) {
        const chapter = row.bucket.slice('chapter:'.length);
        byChapter[chapter] = count;
      }
    }

    return { total, byChapter, byAnchorType };
  });

  // ─── Создание ───────────────────────────────────────────────────────────────

  app.post('/rooms/:roomId/books/:bookId/comments', async (request, reply) => {
    const me = currentUser(request);
    const { roomId, bookId } = roomBookParams.parse(request.params);

    await requireRoomAndBook(roomId, bookId, me);

    // Проверка до разбора тела: иначе zod сказал бы «лишний ключ», и человек
    // не понял бы, что `anchorType` вообще нельзя присылать.
    const raw = (request.body ?? {}) as Record<string, unknown>;
    if ('anchorType' in raw) {
      throw AppError.badRequest(
        'anchorType — поле только для чтения: сервер вычисляет его из якоря',
        { field: 'anchorType' },
      );
    }

    const body = createBody.parse(raw);

    // Файл книги нужен по двум причинам: `kind` должен существовать, а
    // `format` определяет, какой якорь допустим (у PDF якорь страницы, у
    // EPUB — текстовый, и без формата проверка была бы угадыванием).
    const file = await prisma.bookFile.findUnique({
      where: { bookId_kind: { bookId, kind: body.bookFileKind } },
      select: { kind: true, format: true },
    });
    if (file === null) {
      throw AppError.badRequest(`У книги нет файла типа «${body.bookFileKind}»`);
    }

    // `kind` в базе — строка, а не перечисление: набор значений расширяем.
    // Сужаем явно, и всё остальное считаем недопустимым — для якоря это
    // безопасная сторона: неизвестный тип файла не должен проходить проверку.
    // Выборка шла по `body.bookFileKind`, так что расхождение скорее
    // недостижимо, чем вероятно, но полагаться на это в проверке якоря нельзя.
    if (file.kind !== 'text' && file.kind !== 'audio') {
      throw AppError.badRequest(`У книги файл неизвестного типа «${file.kind}»`);
    }

    const checked = validateAnchor(body.anchor, file.kind, file.format);
    if (!checked.ok) throw AppError.badRequest(`Якорь неверен: ${describeIssues(checked.issues)}`);

    // Один уровень вложенности: родитель обязан быть корневым и лежать в той
    // же книге той же комнаты. Проверка адресата — по базе, а не по телу
    // запроса, иначе можно было бы «ответить» на удалённую ветку.
    let parent: { id: string; userId: string; parentId: string | null } | null = null;
    if (body.parentId !== undefined) {
      parent = await prisma.comment.findFirst({
        where: { id: body.parentId, roomId, bookId },
        select: { id: true, userId: true, parentId: true },
      });
      if (parent === null) throw AppError.notFound('Комментарий, на который отвечаете');
      if (parent.parentId !== null) {
        throw AppError.badRequest('Отвечать на ответ нельзя: вложенность ограничена одним уровнем');
      }
    }

    const created = await prisma.comment.create({
      data: {
        roomId,
        bookId,
        bookFileKind: file.kind,
        userId: me.id,
        text: body.text,
        anchor: checked.anchor as unknown as Prisma.InputJsonValue,
        // Ключевая строка: колонка индекса заполняется вычисленным значением,
        // поэтому расходиться с содержимым якоря она не может.
        anchorType: checked.anchorType,
        isSpoiler: body.isSpoiler,
        parentId: parent?.id ?? null,
      },
      select: commentSelect,
    });

    // Ответ — повод написать автору корневого комментария. Не автору ответа:
    // это тот же человек, что и корневой.
    if (parent !== null && parent.userId !== me.id) {
      const members = await prisma.roomMember.findMany({
        where: { roomId },
        select: { userId: true },
      });
      await notifyMany(
        members.map((m) => m.userId),
        {
          type: 'reply',
          payload: {
            commentId: created.id,
            parentId: parent.id,
            bookId,
            roomId,
            preview: created.text.slice(0, 140),
          },
        },
        me.id,
      );
    }

    // Вещание после ответа: если сокет недоступен, маршрут всё равно отвечает.
    // Комментарий уже записан, и молчаливая рассылка ничего не ломает.
    const wire = toComment(created);
    commentCreated(roomId, bookId, wire, me.id);

    return reply.code(201).send({ comment: wire });
  });

  // ─── Правка и удаление ──────────────────────────────────────────────────────

  app.patch('/comments/:id', async (request) => {
    const me = currentUser(request);
    const { id } = commentParams.parse(request.params);
    const body = patchBody.parse(request.body ?? {});

    const existing = await prisma.comment.findUnique({ where: { id }, select: { userId: true } });
    if (existing === null) throw AppError.notFound('Комментарий');
    // Только автор. Администратор может удалить, но не переписать чужой текст:
    // правка с чужим именем — это подделка.
    if (existing.userId !== me.id) throw AppError.forbidden('Редактировать может только автор');

    const updated = await prisma.comment.update({
      where: { id },
      data: { text: body.text, editedAt: new Date() },
      select: commentSelect,
    });

    const wire = toComment(updated);
    commentUpdated(updated.roomId, wire);
    return { comment: wire };
  });

  app.delete('/comments/:id', async (request) => {
    const me = currentUser(request);
    const { id } = commentParams.parse(request.params);

    const existing = await prisma.comment.findUnique({
      where: { id },
      // `roomId` нужен для вещания `comment:deleted`: подписчики сидят именно
      // в комнате, и по одному идентификатору комментария их не найти.
      select: { userId: true, parentId: true, roomId: true },
    });
    if (existing === null) throw AppError.notFound('Комментарий');

    // Удалять может автор или администратор: администратор — потому что иначе
    // оскорбительный комментарий нельзя убрать, а второй уровень вложенности
    // уже не спасает.
    if (existing.userId !== me.id && me.role !== 'admin') {
      throw AppError.forbidden('Удалить может автор или администратор');
    }

    // Реакции и ответы уходят каскадом по схеме: отдельно удалять их не нужно,
    // иначе легко оставить висящие записи.
    await prisma.comment.delete({ where: { id } });

    // Без исключения автора: у него объект уже исчез из ответа, но во второй
    // вкладке он остался бы висеть.
    commentDeleted(existing.roomId, id);

    return { ok: true, id };
  });

  // ─── Реакции ────────────────────────────────────────────────────────────────

  /**
   * Реакция: поставить или снять.
   *
   * Toggle, а не два отдельных эндпоинта: пользователь нажимает на эмодзи и
   * ждёт, что состояние изменится. Два эндпоинта означали бы, что клиент
   * должен сначала узнать текущее состояние, а это лишний запрос на каждое
   * нажатие и окно для рассинхронизации между двумя вкладками.
   *
   * Уникальный индекс `(commentId, userId, emoji)` делает решение однозначным:
   * нажали ещё раз — реакция снята.
   */
  app.post('/comments/:id/reactions', async (request) => {
    const me = currentUser(request);
    const { id } = commentParams.parse(request.params);
    const body = reactionBody.parse(request.body ?? {});

    const comment = await prisma.comment.findUnique({
      where: { id },
      select: { id: true, roomId: true, bookId: true, userId: true },
    });
    if (comment === null) throw AppError.notFound('Комментарий');

    // То же правило, что у остальных маршрутов комнаты: участник или админ.
    // Своя проверка на `memberRole` отличалась от соседних, и админ не мог
    // поставить реакцию там, где мог читать.
    if (!(await canAccessRoom(prisma, comment.roomId, me)).ok) {
      throw AppError.forbidden('Реагировать могут только участники комнаты');
    }

    const existing = await prisma.reaction.findUnique({
      where: { commentId_userId_emoji: { commentId: id, userId: me.id, emoji: body.emoji } },
      select: { id: true },
    });

    if (existing !== null) {
      await prisma.reaction.delete({ where: { id: existing.id } });
      const rows = await prisma.comment.findUniqueOrThrow({
        where: { id },
        select: commentSelect,
      });
      const wire = toComment(rows);
      reactionChanged(comment.roomId, wire, false, me.id);
      return { active: false, comment: wire };
    }

    await prisma.reaction.create({ data: { commentId: id, userId: me.id, emoji: body.emoji } });

    // Автору комментария, кроме того, кто отреагировал: получить уведомление о
    // собственной реакции бессмысленно.
    if (comment.userId !== me.id) {
      await notify(comment.userId, {
        type: 'reaction',
        payload: { commentId: id, emoji: body.emoji, bookId: comment.bookId, roomId: comment.roomId },
      });
    }

    const rows = await prisma.comment.findUniqueOrThrow({ where: { id }, select: commentSelect });
    const wire = toComment(rows);
    reactionChanged(comment.roomId, wire, true, me.id);
    return { active: true, comment: wire };
  });
};
