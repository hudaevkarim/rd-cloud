import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { requireAuth, currentUser } from '../auth/guards.js';
import { memberRole } from '../rooms/membership.js';
import {
  PARSER_VERSION,
  chapterPath,
  indexPath,
  parseAndStoreText,
  readDerived,
  removeDerived,
  rmDerivedDir,
} from '../storage/parse.js';
import { audioDurationSec } from '../storage/duration.js';
import { streamMultipartFile, removeUploaded, type MultipartFields } from '../storage/upload.js';

/**
 * Книги: загрузка, каталог, чтение производных файлов.
 *
 * ─── Порядок частей multipart ────────────────────────────────────────────────
 *
 * Обязателен: сначала текстовые поля, потом файл. Лимит зависит от `kind` —
 * 50 МБ для текста и 2 ГБ для аудио, — а знать его нужно в процессе стриминга.
 * Пришёл файл первым — отказ с внятным текстом, а не «принять 2 ГБ и
 * разобраться потом».
 */

const TEXT_LIMIT = 50 * 1_024 * 1_024;
const AUDIO_LIMIT = 2 * 1_024 * 1_024 * 1_024;

const EXT_BY_FORMAT: Record<string, string> = {
  epub: 'epub',
  fb2: 'fb2',
  pdf: 'pdf',
  mp3: 'mp3',
  m4b: 'm4b',
};

const MIME_BY_FORMAT: Record<string, string> = {
  epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook+xml',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4b: 'audio/mp4',
};

/** Какие форматы допустимы для каждого kind. */
const FORMATS_BY_KIND: Record<'text' | 'audio', readonly string[]> = {
  text: ['epub', 'fb2', 'pdf'],
  audio: ['mp3', 'm4b'],
};

const roomParams = z.object({ roomId: z.string().min(1) });
const bookParams = z.object({ id: z.string().min(1) });
const chapterParams = z.object({ id: z.string().min(1), n: z.coerce.number().int().min(0) });
const fileQuery = z.object({ kind: z.enum(['text', 'audio']) });
const fromCatalogBody = z.object({ catalogBookId: z.string().min(1) });
const catalogQuery = z.object({
  q: z.string().trim().max(128).optional(),
  hasAudio: z.coerce.boolean().optional(),
});

/**
 * Метаданные из текстовых полей формы.
 *
 * `isCatalog` здесь не принимается: пополнять каталог может админ через
 * отдельный маршрут, и обычный участник не должен решать, станет ли его
 * загрузка общей.
 */
const uploadFields = z.object({
  kind: z.enum(['text', 'audio']),
  format: z.enum(['epub', 'fb2', 'pdf', 'mp3', 'm4b']),
  title: z.string().trim().min(1, 'Укажите название').max(300),
  author: z.string().trim().min(1, 'Укажите автора').max(300),
  description: z.string().trim().max(2_000).optional(),
  language: z.string().trim().max(16).optional(),
  year: z.coerce.number().int().min(-3000).max(3000).optional(),
});

/** Поля приходят строками; пустое значение равносильно отсутствующему. */
function readMetadata(fields: MultipartFields) {
  const candidate: Record<string, unknown> = {
    kind: fields['kind'],
    format: fields['format'],
    title: fields['title'],
    author: fields['author'],
  };
  if (fields['description'] !== undefined && fields['description'] !== '') {
    candidate['description'] = fields['description'];
  }
  if (fields['language'] !== undefined && fields['language'] !== '') {
    candidate['language'] = fields['language'];
  }
  if (fields['year'] !== undefined && fields['year'] !== '') {
    candidate['year'] = fields['year'];
  }
  return uploadFields.parse(candidate);
}

/** Поля книги в ответе. Пути на диске наружу не идут. */
const bookWithFilesSelect = {
  id: true,
  title: true,
  author: true,
  description: true,
  coverPath: true,
  isCatalog: true,
  language: true,
  year: true,
  createdAt: true,
  files: {
    select: {
      kind: true,
      format: true,
      fileSize: true,
      mimeType: true,
      durationSec: true,
      parserVersion: true,
      derivedPath: true,
    },
  },
} as const;

type BookWithFiles = {
  id: string;
  title: string;
  author: string;
  description: string | null;
  coverPath: string | null;
  isCatalog: boolean;
  language: string | null;
  year: number | null;
  createdAt: Date;
  files: Array<{
    kind: string;
    format: string;
    fileSize: number;
    mimeType: string;
    durationSec: number | null;
    parserVersion: string | null;
    derivedPath: string | null;
  }>;
};

function toBookSummary(book: BookWithFiles) {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    description: book.description,
    coverUrl: book.coverPath === null ? null : `/files/${book.coverPath}`,
    isCatalog: book.isCatalog,
    language: book.language,
    year: book.year,
    createdAt: book.createdAt,
    files: book.files.map((f) => ({
      kind: f.kind,
      format: f.format,
      fileSize: f.fileSize,
      mimeType: f.mimeType,
      durationSec: f.durationSec,
      /** Есть ли разбор: клиент по флагу решает, запрашивать ли главы. */
      parsed: f.derivedPath !== null,
      url: `/api/books/${book.id}/file?kind=${f.kind}`,
    })),
  };
}

export const bookRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Загрузка: поля → файл → запись в базу.
   *
   * Запись последней по двум причинам. До успешного завершения файла её
   * существование было бы ложью — строка указывала бы на файл, которого нет.
   * И если что-то упадёт уже после записи, файла на диске тоже не окажется:
   * приходится убирать и его, и запись.
   */
  async function upload(
    request: FastifyRequest,
    opts: { roomId: string | null },
  ): Promise<{ book: ReturnType<typeof toBookSummary> }> {
    const me = currentUser(request);

    if (opts.roomId === null) {
      if (me.role !== 'admin') throw AppError.forbidden('Каталог пополняет только администратор');
    } else if ((await memberRole(prisma, opts.roomId, me.id)) === null) {
      throw AppError.forbidden('Загружать книги может только участник комнаты');
    }

    const bookFileId = randomUUID();

    // Один проход по частям. `resolve` вызывается в момент, когда встретился
    // файл, и к этому моменту все поля, шёлшие раньше, уже собраны.
    const stored = await streamMultipartFile(request, {
      bookFileId,
      dataRoot: env.DATA_DIR,
      resolve: (fields) => {
        // Файл раньше нужных полей: лимит неизвестен, и принимать нечего.
        if (fields['kind'] === undefined || fields['format'] === undefined) {
          throw new AppError(
            400,
            'field_order',
            'Файл должен идти после полей kind и format: лимит размера зависит от них',
          );
        }
        const meta = readMetadata(fields);
        const allowed = FORMATS_BY_KIND[meta.kind] as readonly string[];
        if (!allowed.includes(meta.format)) {
          throw AppError.badRequest(`Формат «${meta.format}» не подходит для kind «${meta.kind}»`);
        }
        return {
          maxBytes: meta.kind === 'text' ? TEXT_LIMIT : AUDIO_LIMIT,
          ext: EXT_BY_FORMAT[meta.format] as string,
        };
      },
    });

    const meta = readMetadata(stored.fields);

    let derivedPath: string | null = null;
    let durationSec: number | null = null;

    try {
      if (meta.kind === 'text' && (meta.format === 'epub' || meta.format === 'fb2')) {
        // Разбор на сервере, один раз при загрузке: клиент сходит за
        // `index.json`, а не за всей книгой.
        const bytes = new Uint8Array(await readFile(stored.absolutePath));
        await parseAndStoreText(env.DATA_DIR, bookFileId, bytes);
        derivedPath = `derived/${bookFileId}`;
      } else if (meta.kind === 'audio') {
        durationSec = await audioDurationSec(stored.absolutePath, meta.format);
      }
      // PDF не разбираем: его показывает pdf.js на клиенте, оглавление глав
      // строит он сам.

      const book = await prisma.book.create({
        data: {
          title: meta.title,
          author: meta.author,
          ...(meta.description !== undefined ? { description: meta.description } : {}),
          ...(meta.language !== undefined ? { language: meta.language } : {}),
          ...(meta.year !== undefined ? { year: meta.year } : {}),
          isCatalog: opts.roomId === null,
          uploadedById: me.id,
          files: {
            create: {
              kind: meta.kind,
              format: meta.format,
              filePath: stored.relativePath,
              fileSize: stored.size,
              mimeType: MIME_BY_FORMAT[meta.format] as string,
              durationSec,
              parserVersion: derivedPath === null ? null : PARSER_VERSION,
              derivedPath,
            },
          },
        },
        select: bookWithFilesSelect,
      });

      if (opts.roomId !== null) {
        await prisma.roomBook.create({ data: { roomId: opts.roomId, bookId: book.id } });
      }

      return { book: toBookSummary(book) };
    } catch (error) {
      // Файл на диске есть, а записи в базе нет — убираем, иначе на диске
      // копится по файлу на каждую неудачную загрузку.
      await removeUploaded(env.DATA_DIR, stored.relativePath);
      await removeDerived(env.DATA_DIR, bookFileId).catch(() => undefined);
      throw error;
    }
  }

  // ─── Загрузка ─────────────────────────────────────────────────────────────

  app.post('/rooms/:roomId/books/upload', { preHandler: requireAuth }, async (request, reply) => {
    const { roomId } = roomParams.parse(request.params);
    const result = await upload(request, { roomId });
    return reply.code(201).send(result);
  });

  app.post('/admin/catalog', { preHandler: requireAuth }, async (request, reply) => {
    const result = await upload(request, { roomId: null });
    return reply.code(201).send(result);
  });

  // ─── Каталог ──────────────────────────────────────────────────────────────

  app.get('/catalog', async (request) => {
    const query = catalogQuery.parse(request.query ?? {});
    const books = await prisma.book.findMany({
      where: {
        isCatalog: true,
        ...(query.q !== undefined
          ? {
              OR: [
                { title: { contains: query.q, mode: 'insensitive' as const } },
                { author: { contains: query.q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(query.hasAudio === true ? { files: { some: { kind: 'audio' } } } : {}),
      },
      select: bookWithFilesSelect,
      orderBy: [{ author: 'asc' }, { title: 'asc' }],
      take: 200,
    });
    return { books: books.map(toBookSummary) };
  });

  /**
   * Убрать из каталога.
   *
   * Если книга уже лежит в комнатах, флаг снимается, а сама книга остаётся: она
   * больше не в каталоге, но по-прежнему нужна тем, кто её добавил. Удалять
   * вместе с файлами книгу, лежащую в чужой комнате, нельзя.
   */
  app.delete('/admin/catalog/:id', { preHandler: requireAuth }, async (request) => {
    const me = currentUser(request);
    if (me.role !== 'admin') throw AppError.forbidden('Недостаточно прав');
    const { id } = bookParams.parse(request.params);

    const existing = await prisma.book.findUnique({
      where: { id },
      select: { id: true, _count: { select: { rooms: true } } },
    });
    if (existing === null) throw AppError.notFound('Книга');

    if (existing._count.rooms > 0) {
      await prisma.book.update({ where: { id }, data: { isCatalog: false } });
      return { ok: true, removedFromCatalog: true, deleted: false };
    }

    await deleteBookCascade(id);
    return { ok: true, removedFromCatalog: true, deleted: true };
  });

  /**
   * Добавление книги из каталога в комнату.
   *
   * Создаётся связь `RoomBook` на существующую `Book`, а не её копия: копия
   * означала бы два `BookFile` на один файл, и удаление любого снесло бы файл,
   * который нужен другому.
   */
  app.post('/rooms/:roomId/books/from-catalog', { preHandler: requireAuth }, async (request, reply) => {
    const me = currentUser(request);
    const { roomId } = roomParams.parse(request.params);
    const body = fromCatalogBody.parse(request.body ?? {});

    if ((await memberRole(prisma, roomId, me.id)) === null) {
      throw AppError.forbidden('Добавлять книги может только участник комнаты');
    }

    const source = await prisma.book.findUnique({
      where: { id: body.catalogBookId },
      select: { id: true, isCatalog: true },
    });
    if (source === null || !source.isCatalog) throw AppError.notFound('Книга в каталоге');

    const existing = await prisma.roomBook.findUnique({
      where: { roomId_bookId: { roomId, bookId: source.id } },
      select: { id: true },
    });
    if (existing !== null) return reply.code(200).send({ added: false, bookId: source.id });

    await prisma.roomBook.create({ data: { roomId, bookId: source.id } });
    return reply.code(201).send({ added: true, bookId: source.id });
  });

  // ─── Чтение ───────────────────────────────────────────────────────────────

  app.get('/rooms/:roomId/books', { preHandler: requireAuth }, async (request) => {
    const me = currentUser(request);
    const { roomId } = roomParams.parse(request.params);

    if ((await memberRole(prisma, roomId, me.id)) === null) {
      throw AppError.forbidden('Список книг доступен только участникам комнаты');
    }

    const links = await prisma.roomBook.findMany({
      where: { roomId },
      select: { addedAt: true, book: { select: bookWithFilesSelect } },
      orderBy: { addedAt: 'desc' },
    });

    return { books: links.map((l) => toBookSummary(l.book)) };
  });

  app.get('/books/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = bookParams.parse(request.params);
    const book = await prisma.book.findUnique({ where: { id }, select: bookWithFilesSelect });
    if (book === null) throw AppError.notFound('Книга');
    return { book: toBookSummary(book) };
  });

  /**
   * Оглавление.
   *
   * Отдаётся как есть, без JSON-обёртки: тело уже JSON, и лишний слой заставил бы
   * клиент разбирать его дважды. `max-age` большой: оглавление меняется только
   * при перезагрузке книги, а её загрузка создаёт новую запись.
   */
  app.get('/books/:id/index.json', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookParams.parse(request.params);

    const file = await prisma.bookFile.findFirst({
      where: { bookId: id, kind: 'text', derivedPath: { not: null } },
      select: { derivedPath: true },
    });
    if (file === null || file.derivedPath === null) throw AppError.notFound('Книга не разобрана');

    const content = await readDerived(env.DATA_DIR, indexPath(file.derivedPath));
    if (content === null) throw AppError.notFound('Оглавление');

    return reply
      .header('cache-control', 'private, max-age=3600')
      .type('application/json')
      .send(content);
  });

  /**
   * Одна глава.
   *
   * 409, а не 404: «файла нет» и «книга не разобрана» — разные вещи. Клиенту
   * полезно знать, что это чинится повторной загрузкой, а не повреждённой
   * ссылкой.
   */
  app.get('/books/:id/ch/:n.json', { preHandler: requireAuth }, async (request, reply) => {
    const { id, n } = chapterParams.parse(request.params);

    const file = await prisma.bookFile.findFirst({
      where: { bookId: id, kind: 'text' },
      select: { id: true, derivedPath: true },
    });
    if (file === null) throw AppError.notFound('У книги нет текстового файла');
    if (file.derivedPath === null) {
      throw new AppError(409, 'not_parsed', 'Книга не разобрана: загрузите заново');
    }

    const content = await readDerived(env.DATA_DIR, chapterPath(file.derivedPath, n));
    if (content === null) throw AppError.notFound('Глава');

    return reply
      .header('cache-control', 'private, max-age=86400')
      .type('application/json')
      .send(content);
  });

  /**
   * Ссылка на оригинал.
   *
   * Файл не отдаётся здесь: клиенту возвращается адрес `/files/**`, где уже
   * есть и проверка токена, и Range для аудио. Дублировать раздачу в двух
   * местах — значит со временем получить два разных ответа на один файл.
   */
  app.get('/books/:id/file', { preHandler: requireAuth }, async (request) => {
    const me = currentUser(request);
    const { id } = bookParams.parse(request.params);
    const { kind } = fileQuery.parse(request.query);

    const book = await prisma.book.findUnique({
      where: { id },
      select: { id: true, isCatalog: true, rooms: { select: { roomId: true } } },
    });
    if (book === null) throw AppError.notFound('Книга');

    const file = await prisma.bookFile.findUnique({
      where: { bookId_kind: { bookId: id, kind } },
      select: { filePath: true, mimeType: true },
    });
    if (file === null) throw AppError.notFound(`У книги нет файла типа «${kind}»`);

    // Закрытая комната: файл её участникам доступен, посторонним нет.
    if (book.rooms.length > 0 && !book.isCatalog) {
      const roles = await Promise.all(
        book.rooms.map((r) => memberRole(prisma, r.roomId, me.id)),
      );
      if (!roles.some((r) => r !== null)) {
        throw AppError.forbidden('Файл доступен только участникам комнаты');
      }
    }

    return { url: `/files/${file.filePath}`, mimeType: file.mimeType };
  });

  /** Удаление: владелец любой комнаты, где лежит книга, либо админ. */
  app.delete('/books/:id', { preHandler: requireAuth }, async (request) => {
    const me = currentUser(request);
    const { id } = bookParams.parse(request.params);

    const book = await prisma.book.findUnique({
      where: { id },
      select: { id: true, rooms: { select: { roomId: true } } },
    });
    if (book === null) throw AppError.notFound('Книга');

    if (me.role !== 'admin') {
      const roles = await Promise.all(
        book.rooms.map((r) => memberRole(prisma, r.roomId, me.id)),
      );
      if (!roles.includes('owner')) {
        throw AppError.forbidden('Удалить книгу может владелец комнаты или администратор');
      }
    }

    await deleteBookCascade(id);
    return { ok: true };
  });
};

/**
 * Удаление книги с диска и из базы.
 *
 * Порядок именно такой: сначала запись, потом файлы. Обратный порядок оставил
 * бы на диске файлы книги, на которую уже никто не ссылается, и они копились бы
 * при каждой неудачной загрузке.
 */
async function deleteBookCascade(bookId: string): Promise<void> {
  const files = await prisma.bookFile.findMany({
    where: { bookId },
    select: { filePath: true, derivedPath: true },
  });

  await prisma.book.delete({ where: { id: bookId } });

  for (const file of files) {
    await removeUploaded(env.DATA_DIR, file.filePath);
    // Каталог разбора берётся из `derivedPath`, а не из идентификатора записи:
    // на диске каталог назван по UUID, который был у файла при загрузке, и он не
    // совпадает с `BookFile.id`, выданным базой. По id удалялось бы несуществующее.
    if (file.derivedPath !== null) {
      await rmDerivedDir(env.DATA_DIR, file.derivedPath);
    }
  }
}