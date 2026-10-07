import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestApp,
  createTestApp,
  createTestRoom,
  createTestUser,
  resetDb,
  testDb,
} from './helpers/test-app.js';

/**
 * Комментарии.
 *
 * Проверяется не «сработало ли», а что именно отвергается. Комментарий с
 * некорректным якорем не ломает интерфейс сразу — он ломает его позже и в
 * другом месте: якорь не находится в книге, и человек не понимает, куда
 * смотрит его реплика. Поэтому проверки структуры якоря и прав важнее
 * счастливого пути.
 */

const app = await createTestApp();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Текстовый якорь: глава 0, блок 0, выделение «Ветер». */
const TEXT_ANCHOR = {
  kind: 'text',
  chapterIndex: 0,
  blockIndex: 0,
  start: 0,
  end: 5,
  quote: 'Ветер',
  prefix: '',
  suffix: ' гулял',
};

/** Аудио-якорь: 90-я секунда. */
const AUDIO_ANCHOR = { kind: 'audio', timeSec: 90, quote: 'Глава 3' };

/**
 * Книга с текстовым и аудиофайлом.
 *
 * Создаётся напрямую через Prisma, а не загрузкой файла: комментарии интересует
 * лишь существование `BookFile` нужного типа и его `format`, а загрузка ради
 * этого подняла бы лишние два десятка мегабайт на каждый тест.
 */
async function createBook(roomId: string, opts: { audio?: boolean; format?: string } = {}) {
  const book = await testDb.book.create({
    data: {
      title: 'Проверка комментариев',
      author: 'Тестовый Автор',
      files: {
        create: [
          {
            kind: 'text',
            format: opts.format ?? 'epub',
            filePath: `files/fake-text/${Date.now()}.epub`,
            fileSize: 1,
            mimeType: 'application/epub+zip',
          },
          ...(opts.audio === false
            ? []
            : [
                {
                  kind: 'audio',
                  format: 'mp3',
                  filePath: `files/fake-audio/${Date.now()}.mp3`,
                  fileSize: 1,
                  mimeType: 'audio/mpeg',
                  durationSec: 3600,
                },
              ]),
        ],
      },
    },
    select: { id: true },
  });
  // Связь с комнатой — отдельная запись `RoomBook`, а не поле на Book: книга
  // может лежать в нескольких комнатах, и это же объясняет, почему в каталоге
  // она одна, а комнаты ссылаются на неё ссылками.
  await testDb.roomBook.create({ data: { roomId, bookId: book.id } });
  return book.id;
}

/**
 * Комментарии напрямую в базу — для проверки пагинации без шестидесяти запросов.
 *
 * Метки времени задаются явно и с шагом `gapMs`, а не «сейчас»: проверка
 * пагинации должна быть повторяемой, а `now()` у шестидесяти записей подряд даёт
 * метки, отличающиеся на микросекунды, и порядок становится случайным.
 */
async function seedComments(
  roomId: string,
  bookId: string,
  userId: string,
  count: number,
  opts: { chapterIndex?: number; gapMs?: number } = {},
) {
  const base = new Date('2026-01-01T00:00:00.000Z');
  const gap = opts.gapMs ?? 1;

  await testDb.comment.createMany({
    data: Array.from({ length: count }, (_unused, i) => ({
      roomId,
      bookId,
      bookFileKind: 'text',
      userId,
      text: `Комментарий ${i}`,
      anchor: {
        kind: 'text',
        chapterIndex: opts.chapterIndex ?? 0,
        blockIndex: 0,
        start: 0,
        end: 4,
        quote: 'abcd',
        prefix: '',
        suffix: '',
      },
      anchorType: 'text',
      createdAt: new Date(base.getTime() + i * gap),
    })),
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
});

// ─── Создание ─────────────────────────────────────────────────────────────────

describe('создание комментария', () => {
  it('валидный текстовый якорь даёт 201, anchorType вычислен сервером', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Ветер — хорошая метафора', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    expect(response.statusCode).toBe(201);
    const comment = response.json().comment;
    expect(comment.anchorType).toBe('text');
    expect(comment.anchor).toEqual(TEXT_ANCHOR);
    expect(comment.author.id).toBe(owner.user.id);
    expect(comment.editedAt).toBeNull();
    expect(comment.reactions).toEqual([]);

    // Колонка индекса заполнена вычисленным значением, а не присланным.
    const stored = await testDb.comment.findUniqueOrThrow({ where: { id: comment.id } });
    expect(stored.anchorType).toBe('text');
  });

  it('валидный аудио-якорь у аудиофайла даёт anchorType timestamp', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Здесь смешно', bookFileKind: 'audio', anchor: AUDIO_ANCHOR },
    });

    expect(response.statusCode).toBe(201);
    // «timestamp», а не «audio»: в базе так, и клиент по этому значению
    // выбирает нужное представление шкалы.
    expect(response.json().comment.anchorType).toBe('timestamp');
  });

  it('невалидный якорь — 400 с перечислением проблем', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    // Отрицательное смещение и перевёрнутые границы: такой якорь не разрешится
    // никогда, и записать его — значит создать комментарий навсегда.
    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: {
        text: 'Битый якорь',
        bookFileKind: 'text',
        anchor: { kind: 'text', chapterIndex: -1, blockIndex: 0, start: 9, end: 2, quote: 'x' },
      },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message as string;
    expect(message).toContain('anchor.chapterIndex');
    expect(message).toContain('anchor.end');
    expect(await testDb.comment.count()).toBe(0);
  });

  it('audio-файл с текстовым якорем — 400: ждём якорь «audio»', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      // kind=audio, но якорь текстовый. Это и есть «bookFileKind: audio,
      // а якорь от текста» из задания, только anchorType сюда не присылается:
      // он и не принимается, его вычисляют.
      payload: { text: 'Не тот якорь', bookFileKind: 'audio', anchor: TEXT_ANCHOR },
    });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message as string;
    expect(message).toContain('anchor.kind');
    expect(message).toContain('audio');
    expect(await testDb.comment.count()).toBe(0);
  });

  it('якорь страницы у EPUB — 400, у PDF — 201', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const epub = await createBook(roomId, { audio: false });
    const notPdf = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${epub}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Стр. 5', bookFileKind: 'text', anchor: { kind: 'page', page: 5 } },
    });
    expect(notPdf.statusCode).toBe(400);

    const pdfRoom = await createTestRoom({ ownerId: owner.user.id, name: 'PDF' });
    const pdf = await createBook(pdfRoom.roomId, { format: 'pdf', audio: false });
    const isPdf = await app.inject({
      method: 'POST',
      url: `/api/rooms/${pdfRoom.roomId}/books/${pdf}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Стр. 5', bookFileKind: 'text', anchor: { kind: 'page', page: 5 } },
    });

    expect(isPdf.statusCode).toBe(201);
    expect(isPdf.json().comment.anchorType).toBe('page');
  });

  it('anchorType от клиента — 400 «только для чтения», даже если он верный', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: {
        text: 'Пробую подсунуть',
        bookFileKind: 'text',
        anchor: TEXT_ANCHOR,
        // Значение правильное — и всё равно отказ. Клиент не должен решать,
        // чему равен индекс: рассинхрон колонки с содержимым якоря означал бы,
        // что поиск по главам молча теряет комментарии.
        anchorType: 'page',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json().error;
    expect(body.message).toContain('только для чтения');
    // Не «лишний ключ от zod»: человек должен понять причину.
    expect(body.message).not.toContain('anchorType:');
    expect(await testDb.comment.count()).toBe(0);
  });

  it('не-участник комнаты — 403', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(stranger.token),
      payload: { text: 'Меня тут нет', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    expect(response.statusCode).toBe(403);
    expect(await testDb.comment.count()).toBe(0);
  });

  it('книга не из этой комнаты — 404, даже если я её участник', async () => {
    const owner = await createTestUser();
    const roomA = await createTestRoom({ ownerId: owner.user.id, name: 'A' });
    const roomB = await createTestRoom({ ownerId: owner.user.id, name: 'B' });
    const bookInB = await createBook(roomB.roomId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomA.roomId}/books/${bookInB}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Не та книга', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    expect(response.statusCode).toBe(404);
  });

  it('пустой текст и слишком длинный — 400', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    const empty = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: '   ', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    expect(empty.statusCode).toBe(400);

    const long = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: 'я'.repeat(5_001), bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    expect(long.statusCode).toBe(400);
  });

  it('без токена — 401', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      payload: { text: 'Без входа', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    expect(response.statusCode).toBe(401);
  });
});

// ─── Вложенность ──────────────────────────────────────────────────────────────

describe('ответы', () => {
  it('ответ на корневой комментарий создаётся', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [guest.user.id] });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    const root = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: 'Корень', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const rootId = root.json().comment.id as string;

    const reply = await app.inject({
      method: 'POST',
      url,
      headers: auth(guest.token),
      payload: { text: 'Ответ', bookFileKind: 'text', anchor: TEXT_ANCHOR, parentId: rootId },
    });

    expect(reply.statusCode).toBe(201);
    expect(reply.json().comment.parentId).toBe(rootId);

    // Ответ приезжает вместе с корневым, а не отдельной страницей.
    const list = await app.inject({ method: 'GET', url, headers: auth(owner.token) });
    const comments = list.json().comments as Array<{ id: string; replies: unknown[] }>;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe(rootId);
    expect(comments[0]?.replies).toHaveLength(1);
  });

  it('ответ на ответ — 400: вложенность ограничена одним уровнем', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    const root = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: 'Первый', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const reply = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: 'Второй', bookFileKind: 'text', anchor: TEXT_ANCHOR, parentId: root.json().comment.id },
    });

    const third = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: 'Третий', bookFileKind: 'text', anchor: TEXT_ANCHOR, parentId: reply.json().comment.id },
    });

    expect(third.statusCode).toBe(400);
    expect(third.json().error.message).toContain('вложенность');
    // В базе осталось ровно два: корень и ответ.
    expect(await testDb.comment.count()).toBe(2);
  });

  it('родитель из другой комнаты — 404', async () => {
    const owner = await createTestUser();
    const roomA = await createTestRoom({ ownerId: owner.user.id, name: 'A' });
    const roomB = await createTestRoom({ ownerId: owner.user.id, name: 'B' });
    const bookB = await createBook(roomB.roomId);

    const inB = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomB.roomId}/books/${bookB}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Там', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    const bookA = await createBook(roomA.roomId);
    const cross = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomA.roomId}/books/${bookA}/comments`,
      headers: auth(owner.token),
      payload: {
        text: 'Ответ в другую комнату',
        bookFileKind: 'text',
        anchor: TEXT_ANCHOR,
        parentId: inB.json().comment.id,
      },
    });

    expect(cross.statusCode).toBe(404);
  });
});

// ─── Чтение и пагинация ────────────────────────────────────────────────────────

describe('список и пагинация', () => {
  it('60 комментариев: страницы 50 и 10, без пропусков и повторов', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    await seedComments(roomId, bookId, owner.user.id, 60, { gapMs: 5 });
    expect(await testDb.comment.count()).toBe(60);

    const first = await app.inject({ method: 'GET', url, headers: auth(owner.token) });
    const page1 = first.json();
    expect(page1.comments).toHaveLength(50);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    const second = await app.inject({
      method: 'GET',
      url: `${url}?cursor=${encodeURIComponent(page1.nextCursor as string)}`,
      headers: auth(owner.token),
    });
    const page2 = second.json();
    expect(page2.comments).toHaveLength(10);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const ids = [
      ...(page1.comments as Array<{ id: string }>).map((c) => c.id),
      ...(page2.comments as Array<{ id: string }>).map((c) => c.id),
    ];
    expect(new Set(ids).size).toBe(60);
  });

  it('одинаковые createdAt не ломают пагинацию', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    // gapMs: 0 — все комментарии с одной меткой времени. Без `id` в курсоре
    // вторая страница либо теряла бы записи, либо повторяла их.
    await seedComments(roomId, bookId, owner.user.id, 12, { gapMs: 0 });

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const suffix = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const response = await app.inject({ method: 'GET', url: `${url}${suffix}`, headers: auth(owner.token) });
      const body = response.json();
      for (const c of body.comments as Array<{ id: string }>) seen.add(c.id);
      if (!body.hasMore) break;
      cursor = body.nextCursor as string;
    }

    expect(seen.size).toBe(12);
  });

  it('фильтр по главе отбирает только нужную, и не такую книгу', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookA = await createBook(roomId);
    const bookB = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookA}/comments`;

    // Одна и та же книга, две главы: фильтр обязан отсечь главу 0.
    await seedComments(roomId, bookA, owner.user.id, 3, { chapterIndex: 0, gapMs: 5 });
    await seedComments(roomId, bookA, owner.user.id, 4, { chapterIndex: 3, gapMs: 5 });
    // Та же глава в другой книге: отсекается по книге, а не по главе.
    await seedComments(roomId, bookB, owner.user.id, 6, { chapterIndex: 3, gapMs: 5 });

    const response = await app.inject({
      method: 'GET',
      url: `${url}?chapter=3`,
      headers: auth(owner.token),
    });

    expect(response.statusCode).toBe(200);
    const comments = response.json().comments as Array<{ anchor: { chapterIndex: number } }>;
    expect(comments).toHaveLength(4);
    expect(comments.every((c) => c.anchor.chapterIndex === 3)).toBe(true);
  });

  it('фильтры по bookFileKind и anchorType сочетаются', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    await testDb.comment.create({
      data: {
        roomId,
        bookId,
        bookFileKind: 'audio',
        userId: owner.user.id,
        text: 'Аудио',
        anchor: AUDIO_ANCHOR,
        anchorType: 'timestamp',
      },
    });
    await seedComments(roomId, bookId, owner.user.id, 2, { gapMs: 5 });

    const response = await app.inject({
      method: 'GET',
      url: `${url}?bookFileKind=audio&anchorType=timestamp`,
      headers: auth(owner.token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().comments).toHaveLength(1);
  });

  it('посторонний список не читает — 403', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(stranger.token),
    });
    expect(response.statusCode).toBe(403);
  });

  it('повреждённый курсор — 400', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${bookId}/comments?cursor=${encodeURIComponent('не-курсор')}`,
      headers: auth(owner.token),
    });
    expect(response.statusCode).toBe(400);
  });
});

// ─── Сводка ────────────────────────────────────────────────────────────────────

describe('сводка для оглавления', () => {
  it('считает всего, по главам и по типам якорей', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    await seedComments(roomId, bookId, owner.user.id, 5, { chapterIndex: 0, gapMs: 5 });
    await seedComments(roomId, bookId, owner.user.id, 3, { chapterIndex: 2, gapMs: 5 });
    await testDb.comment.create({
      data: {
        roomId,
        bookId,
        bookFileKind: 'audio',
        userId: owner.user.id,
        text: 'Минута ninety',
        anchor: AUDIO_ANCHOR,
        anchorType: 'timestamp',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${bookId}/comments/count`,
      headers: auth(owner.token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(9);
    expect(body.byChapter).toEqual({ '0': 5, '2': 3 });
    expect(body.byAnchorType).toEqual({ text: 8, timestamp: 1 });
    // bigint из Postgres обязан стать числом: иначе JSON.parse у клиента падает.
    expect(typeof body.total).toBe('number');
  });

  it('пустая книга — нули, а не пустой объект без ключей', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${bookId}/comments/count`,
      headers: auth(owner.token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ total: 0, byChapter: {}, byAnchorType: {} });
  });
});

// ─── Правка и удаление ─────────────────────────────────────────────────────────

describe('правка и удаление', () => {
  it('автор правит, и появляется editedAt', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Черновик', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const id = created.json().comment.id as string;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/comments/${id}`,
      headers: auth(owner.token),
      payload: { text: 'Исправлено' },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().comment.text).toBe('Исправлено');
    expect(patched.json().comment.editedAt).not.toBeNull();
    // Якорь при правке текста не трогается: он указывает на место в книге,
    // а не на слова автора.
    expect(patched.json().comment.anchor).toEqual(TEXT_ANCHOR);
  });

  it('чужой комментарий править нельзя — 403', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [guest.user.id] });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Моё', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const id = created.json().comment.id as string;

    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/comments/${id}`,
      headers: auth(guest.token),
      payload: { text: 'Теперь моё' },
    });
    expect(denied.statusCode).toBe(403);

    // Администратор может удалить, но не переписать: правка с чужим именем —
    // это подделка.
    const admin = await createTestUser({ role: 'admin' });
    const adminPatch = await app.inject({
      method: 'PATCH',
      url: `/api/comments/${id}`,
      headers: auth(admin.token),
      payload: { text: 'Отредактировано админом' },
    });
    expect(adminPatch.statusCode).toBe(403);
  });

  it('удаляет автор, удаляет админ, посторонний не удаляет', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const admin = await createTestUser({ role: 'admin' });
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    const make = async () => {
      const created = await app.inject({
        method: 'POST',
        url,
        headers: auth(owner.token),
        payload: { text: 'Комментарий', bookFileKind: 'text', anchor: TEXT_ANCHOR },
      });
      return created.json().comment.id as string;
    };

    const first = await make();
    const denied = await app.inject({ method: 'DELETE', url: `/api/comments/${first}`, headers: auth(stranger.token) });
    expect(denied.statusCode).toBe(403);

    const byAuthor = await app.inject({ method: 'DELETE', url: `/api/comments/${first}`, headers: auth(owner.token) });
    expect(byAuthor.statusCode).toBe(200);

    const second = await make();
    const byAdmin = await app.inject({ method: 'DELETE', url: `/api/comments/${second}`, headers: auth(admin.token) });
    expect(byAdmin.statusCode).toBe(200);
    expect(await testDb.comment.count()).toBe(0);
  });

  it('удаление корня уносит ответы и реакции каскадом', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [guest.user.id] });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    const root = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: 'Корень', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const rootId = root.json().comment.id as string;

    const reply = await app.inject({
      method: 'POST',
      url,
      headers: auth(guest.token),
      payload: { text: 'Ответ', bookFileKind: 'text', anchor: TEXT_ANCHOR, parentId: rootId },
    });
    await app.inject({
      method: 'POST',
      url: `/api/comments/${rootId}/reactions`,
      headers: auth(guest.token),
      payload: { emoji: '👍' },
    });

    expect(await testDb.comment.count()).toBe(2);
    expect(await testDb.reaction.count()).toBe(1);

    await app.inject({ method: 'DELETE', url: `/api/comments/${rootId}`, headers: auth(owner.token) });

    // Висячих записей быть не должно: иначе они копились бы и занимали место.
    expect(await testDb.comment.count()).toBe(0);
    expect(await testDb.reaction.count()).toBe(0);
    void reply;
  });
});

// ─── Реакции ───────────────────────────────────────────────────────────────────

describe('реакции', () => {
  it('toggle: поставил — снял, и наоборот', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [guest.user.id] });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Что думаете', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const id = created.json().comment.id as string;
    const url = `/api/comments/${id}/reactions`;

    const first = await app.inject({ method: 'POST', url, headers: auth(guest.token), payload: { emoji: '👍' } });
    expect(first.statusCode).toBe(200);
    expect(first.json().active).toBe(true);
    expect(first.json().comment.reactions).toEqual([
      { emoji: '👍', count: 1, userIds: [guest.user.id] },
    ]);

    const second = await app.inject({ method: 'POST', url, headers: auth(guest.token), payload: { emoji: '👍' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().active).toBe(false);
    expect(second.json().comment.reactions).toEqual([]);

    // Уникальный индекс не дал накопиться мусору от двух нажатий.
    expect(await testDb.reaction.count()).toBe(0);

    const third = await app.inject({ method: 'POST', url, headers: auth(guest.token), payload: { emoji: '👍' } });
    expect(third.json().active).toBe(true);
    expect(await testDb.reaction.count()).toBe(1);
  });

  it('реакции разных людей группируются по эмодзи', async () => {
    const owner = await createTestUser();
    const a = await createTestUser();
    const b = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [a.user.id, b.user.id],
    });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Обсуждаем', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const id = created.json().comment.id as string;
    const url = `/api/comments/${id}/reactions`;

    await app.inject({ method: 'POST', url, headers: auth(a.token), payload: { emoji: '👍' } });
    await app.inject({ method: 'POST', url, headers: auth(b.token), payload: { emoji: '👍' } });
    await app.inject({ method: 'POST', url, headers: auth(b.token), payload: { emoji: '🎉' } });

    const list = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
    });
    const comment = (list.json().comments as Array<{ reactions: unknown[] }>)[0];
    // Сначала более частое — интерфейс показывает верхушку без сортировки.
    expect(comment?.reactions).toEqual([
      { emoji: '👍', count: 2, userIds: [a.user.id, b.user.id] },
      { emoji: '🎉', count: 1, userIds: [b.user.id] },
    ]);
  });

  it('эмодзи вне списка — 400', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Реакции', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    for (const emoji of ['🤖', '', '👍👍', 'x']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/comments/${created.json().comment.id}/reactions`,
        headers: auth(owner.token),
        payload: { emoji },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await testDb.reaction.count()).toBe(0);
  });

  it('посторонний не реагирует — 403', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Моё', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/comments/${created.json().comment.id}/reactions`,
      headers: auth(stranger.token),
      payload: { emoji: '👍' },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ─── Уведомления ───────────────────────────────────────────────────────────────

describe('уведомления', () => {
  it('ответ пишет уведомление автору корневого и не себе', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [guest.user.id] });
    const bookId = await createBook(roomId);
    const url = `/api/rooms/${roomId}/books/${bookId}/comments`;

    const root = await app.inject({
      method: 'POST',
      url,
      headers: auth(owner.token),
      payload: { text: 'Корень', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    await app.inject({
      method: 'POST',
      url,
      headers: auth(guest.token),
      payload: { text: 'Ответ', bookFileKind: 'text', anchor: TEXT_ANCHOR, parentId: root.json().comment.id },
    });

    const notifications = await testDb.notification.findMany({
      where: { userId: owner.user.id },
      select: { type: true },
    });
    expect(notifications.map((n) => n.type)).toEqual(['reply']);
    // Отвечавший не должен получать уведомление о собственном ответе.
    expect(await testDb.notification.count({ where: { userId: guest.user.id } })).toBe(0);
  });

  it('реакция уведомляет автора, кроме случая «своя реакция»', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [guest.user.id] });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Моё', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const id = created.json().comment.id as string;

    await app.inject({
      method: 'POST',
      url: `/api/comments/${id}/reactions`,
      headers: auth(owner.token),
      payload: { emoji: '🎉' },
    });
    expect(await testDb.notification.count({ where: { userId: owner.user.id } })).toBe(0);

    await app.inject({
      method: 'POST',
      url: `/api/comments/${id}/reactions`,
      headers: auth(guest.token),
      payload: { emoji: '🎉' },
    });
    const notes = await testDb.notification.findMany({
      where: { userId: owner.user.id },
      select: { type: true },
    });
    expect(notes.map((n) => n.type)).toEqual(['reaction']);
  });
});

describe('доступ к комментариям', () => {
  /*
    Правило одно на все маршруты комнаты — `canAccessRoom`: участник или админ.
    Здесь стояла своя проверка на `memberRole`, и админ читал книгу, но не видел
    её комментариев. Расхождение между проверками доступа хуже любого отдельного
    решения: при разборе невозможно понять, что имелось в виду.
  */
  it('админ читает комментарии чужой комнаты, посторонний — нет', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ role: 'admin' });
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Комментарий', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });

    const byAdmin = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(admin.token),
    });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().comments).toHaveLength(1);

    const byStranger = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(stranger.token),
    });
    expect(byStranger.statusCode).toBe(403);
  });

  it('админ реагирует в чужой комнате', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser({ role: 'admin' });
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const bookId = await createBook(roomId);

    const created = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/${bookId}/comments`,
      headers: auth(owner.token),
      payload: { text: 'Комментарий', bookFileKind: 'text', anchor: TEXT_ANCHOR },
    });
    const id = created.json().comment.id as string;

    const byAdmin = await app.inject({
      method: 'POST',
      url: `/api/comments/${id}/reactions`,
      headers: auth(admin.token),
      payload: { emoji: '🎉' },
    });

    /*
      Реакция — не только код ответа: проверяется, что она записалась. Иначе
      проверка «200» прошла бы и при молча потерянной реакции.
    */
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json().active).toBe(true);
    expect(await testDb.reaction.count({ where: { commentId: id } })).toBe(1);
  });
});
