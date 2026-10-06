import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { requireAdmin, requireAuth, currentUser } from '../auth/guards.js';
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
import {
  discardStagedUpload,
  dropPlacedFiles,
  placeStagedFiles,
  stageMultipartFiles,
  type FileSpec,
  type PlacedFile,
} from '../storage/stage.js';
import { bookAdded, bookRemoved, catalogBookAdded } from '../ws/broadcast.js';
import type { BookEventPayload } from '../ws/types.js';

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
/**
 * Предел обложки.
 *
 * Пять мегабайт хватает для обложки с любого магазина, а ресайз отложен на 7.6.
 * Здесь важно другое: без предела картинка на 80 МБ уехала бы в каталог при
 * одной загрузке.
 */
const COVER_LIMIT = 5 * 1_024 * 1_024;

/**
 * Расширения обложек.
 *
 * HEIC намеренно нет: браузеры его не показывают, и админ загрузил бы обложку,
 * которой не увидит никто.
 */
const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

/** Файлы формы каталога. Вид несёт имя поля, формат — расширение. */
const CATALOG_SPECS: readonly FileSpec[] = [
  { field: 'text', extensions: ['epub', 'fb2', 'pdf'], maxBytes: TEXT_LIMIT, label: 'Текст' },
  { field: 'audio', extensions: ['mp3', 'm4b'], maxBytes: AUDIO_LIMIT, label: 'Аудио' },
  { field: 'cover', extensions: COVER_EXTENSIONS, maxBytes: COVER_LIMIT, label: 'Обложка' },
];

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
/** Пара пары «комната + книга»: снятие связи, а не адрес книги. */
const roomBookParams = z.object({ roomId: z.string().min(1), bookId: z.string().min(1) });
const chapterParams = z.object({ id: z.string().min(1), n: z.coerce.number().int().min(0) });
const fileQuery = z.object({ kind: z.enum(['text', 'audio']) });
const fromCatalogBody = z.object({ catalogBookId: z.string().min(1) });
const catalogQuery = z.object({
  q: z.string().trim().max(128).optional(),
  author: z.string().trim().max(300).optional(),
  hasAudio: z.coerce.boolean().optional(),
});

/**
 * Поиск книг.
 *
 * Два символа — минимум осмысленного запроса: на одном символе выдача
 * совпадает почти со всем каталогом, и человек получил бы список, в котором
 * ничего не выделяется. Короче — пустой ответ и ни одного запроса к базе.
 */
const MIN_SEARCH_LEN = 2;
const SEARCH_LIMIT = 20;

const searchQuery = z.object({ q: z.string().trim().max(128).optional() });

/**
 * Поля книги, принимаемые формой каталога.
 *
 * Отдельная схема, а не расширение `uploadFields`: `authorBio` есть только у
 * каталога. Обычный участник не может дописать биографию автору книги, которую
 * он загрузил в комнату, — иначе текст попал бы в общий каталог из комнаты.
 */
const catalogFields = z.object({
  title: z.string().trim().min(1, 'Укажите название').max(300),
  author: z.string().trim().min(1, 'Укажите автора').max(300),
  description: z.string().trim().max(2_000).optional(),
  authorBio: z.string().trim().max(4_000).optional(),
  language: z.string().trim().max(16).optional(),
  year: z.coerce.number().int().min(-3000).max(3000).optional(),
});

/** Поля приходят строками; пустое значение равносильно отсутствующему. */
function readCatalogMetadata(fields: MultipartFields) {
  const candidate: Record<string, unknown> = {
    title: fields['title'],
    author: fields['author'],
  };
  for (const key of ['description', 'authorBio', 'language', 'year'] as const) {
    if (fields[key] !== undefined && fields[key] !== '') candidate[key] = fields[key];
  }
  return catalogFields.parse(candidate);
}

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
  authorBio: true,
  coverPath: true,
  isCatalog: true,
  language: true,
  year: true,
  uploadedById: true,
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
  authorBio: string | null;
  coverPath: string | null;
  isCatalog: boolean;
  language: string | null;
  year: number | null;
  uploadedById: string | null;
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
    authorBio: book.authorBio,
    /*
      Адрес обложки не содержит пути на диске и не меняется при замене файла:
      расширение может быть любым, а клиент шлёт обложку под именем `cover.jpg`
      или `cover.webp`. Раздача идёт через `/files/**`, где есть проверка токена
      и Range, — дублировать её в `/api` значит со временем получить два разных
      ответа на один файл.
    */
    coverUrl: book.coverPath === null ? null : `/api/books/${book.id}/cover`,
    isCatalog: book.isCatalog,
    language: book.language,
    year: book.year,
    uploadedById: book.uploadedById,
    createdAt: book.createdAt,
    /*
      `hasText` и `hasAudio` — не замена `files`, а короткий ответ на вопрос
      «что открывать». Разбирать список файлов на клиенте ради пары логических
      значений незачем, а спрашивать сервер об этом отдельно — лишний запрос.
    */
    hasText: book.files.some((f) => f.kind === 'text'),
    hasAudio: book.files.some((f) => f.kind === 'audio'),
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

/**
 * Сузить книгу до того, что уходит в событие.
 *
 * Отдельная функция, а не отдача полного `BookSummary`: список файлов с
 * адресами в событии о каждой книге — это трафик на каждого подписчика комнаты,
 * а читателю достаточно знать, что книга появилась.
 */
function toEventPayload(book: ReturnType<typeof toBookSummary>): BookEventPayload {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    coverUrl: book.coverUrl,
    hasText: book.hasText,
    hasAudio: book.hasAudio,
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

      const summary = toBookSummary(book);

      /*
        Событие — после записи в базу и до ответа.

        Порядок именно такой: уведомление, пришедшее раньше записи, показало бы
        человеку книгу, которой ещё нет, и по F5 она бы исчезла.
      */
      if (opts.roomId !== null) {
        bookAdded(opts.roomId, toEventPayload(summary), { id: me.id, displayName: me.displayName }, 'upload');
      }

      return { book: summary };
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

  // ─── Каталог ──────────────────────────────────────────────────────────────

  /**
   * Пополнение каталога.
   *
   * Отдельная функция, а не вызов `upload`: там ровно один файл, а здесь их до
   * трёх (`text`, `audio`, `cover`), любые из которых необязательны, кроме
   * требования «хотя бы один текст или аудио». Разбирается это `stageMultipartFiles`
   * — с двумя фазами, потому что с двумя файлами отказ на втором оставил бы
   * первый на диске навсегда.
   */
  app.post('/admin/catalog', { preHandler: requireAdmin }, async (request, reply) => {
    const me = currentUser(request);
    const uploadId = randomUUID();

    const staged = await stageMultipartFiles(request, {
      dataRoot: env.DATA_DIR,
      uploadId,
      specs: CATALOG_SPECS,
    });

    // Сначала проверка «хотя бы один файл» и только потом разбор: при отказе
    // нечего разбирать, и сообщение должно называть причину, а не падать внутри
    // парсера.
    if (!staged.files.has('text') && !staged.files.has('audio')) {
      await discardStagedUpload(staged);
      throw AppError.badRequest(
        'Нужен хотя бы один файл: текст (.epub, .fb2, .pdf) или аудио (.mp3, .m4b)',
      );
    }

    const meta = readCatalogMetadata(staged.fields);

    /*
      Разбор в первой фазе, до появления чего-либо в `files/`.

      Это не перестраховка, а требование двухфазной записи: оглавление, обещающее
      главы, появится раньше самой книги, если разбор перенести после
      перемещения. Упавший разбор оставляет после себя только пустой
      `tmp/<uploadId>/`, который снимает `catch`.
    */
    const derived = new Map<string, string>();
    try {
      for (const [field, file] of staged.files) {
        if (field === 'text' && (file.ext === 'epub' || file.ext === 'fb2')) {
          const bytes = new Uint8Array(await readFile(file.absolutePath));
          const parseFileId = randomUUID();
          await parseAndStoreText(env.DATA_DIR, parseFileId, bytes);
          derived.set(file.field, `derived/${parseFileId}`);
        }
      }
    } catch (error) {
      for (const path of derived.values()) {
        await rmDerivedDir(env.DATA_DIR, path).catch(() => undefined);
      }
      await discardStagedUpload(staged);
      throw error;
    }

    let placed: PlacedFile[] = [];
    try {
      placed = await placeStagedFiles(staged, CATALOG_SPECS);

      const cover = placed.find((f) => f.field === 'cover');
      const text = placed.find((f) => f.field === 'text');
      const audio = placed.find((f) => f.field === 'audio');

      /*
        Идентификатор книги нужен до переноса обложки: она лежит в
        `covers/<bookId>/cover.<ext>`, то есть имя папки задаёт сама книга, а не
        UUID файла. Поэтому книра создаётся первой, а обложка переносится сразу
        после и обновляет ту же запись.
      */
      const created = await prisma.$transaction(async (tx) => {
        const book = await tx.book.create({
          data: {
            title: meta.title,
            author: meta.author,
            ...(meta.description !== undefined ? { description: meta.description } : {}),
            ...(meta.authorBio !== undefined ? { authorBio: meta.authorBio } : {}),
            ...(meta.language !== undefined ? { language: meta.language } : {}),
            ...(meta.year !== undefined ? { year: meta.year } : {}),
            isCatalog: true,
            uploadedById: me.id,
          },
          select: { id: true },
        });

        const files = [];
        if (text !== undefined) {
          files.push(
            await tx.bookFile.create({
              data: {
                bookId: book.id,
                kind: 'text',
                format: text.ext,
                filePath: text.filePath,
                fileSize: text.size,
                mimeType: MIME_BY_FORMAT[text.ext] as string,
                // PDF не разбираем: его показывает pdf.js на клиенте, оглавление
                // глав строит он сам.
                parserVersion: derived.get('text') ?? null,
                derivedPath: derived.get('text') ?? null,
              },
              select: { id: true },
            }),
          );
        }
        if (audio !== undefined) {
          files.push(
            await tx.bookFile.create({
              data: {
                bookId: book.id,
                kind: 'audio',
                format: audio.ext,
                filePath: audio.filePath,
                fileSize: audio.size,
                mimeType: MIME_BY_FORMAT[audio.ext] as string,
                durationSec: await audioDurationSec(audio.absolutePath, audio.ext),
              },
              select: { id: true },
            }),
          );
        }

        let coverPath: string | null = null;
        if (cover !== undefined) {
          const dir = join(env.DATA_DIR, 'covers', book.id);
          await mkdir(dir, { recursive: true });
          await rename(cover.absolutePath, join(dir, `cover.${cover.ext}`));
          coverPath = join('covers', book.id, `cover.${cover.ext}`);
          await tx.book.update({ where: { id: book.id }, data: { coverPath } });
        }

        const full = await tx.book.findUniqueOrThrow({
          where: { id: book.id },
          select: bookWithFilesSelect,
        });
        return full;
      });

      await discardStagedUpload(staged);

      const summary = toBookSummary(created);
      // Каталог общий: событие уходит всем подключённым, а не только админу.
      catalogBookAdded(toEventPayload(summary), { id: me.id, displayName: me.displayName });
      return reply.code(201).send({ book: summary });
    } catch (error) {
      // Всё, что успело появиться, — убираем: записи в базе откатила транзакция,
      // а файлы и разбор остались бы на диске без единой ссылки.
      await dropPlacedFiles(env.DATA_DIR, placed);
      for (const path of derived.values()) {
        await rmDerivedDir(env.DATA_DIR, path).catch(() => undefined);
      }
      await discardStagedUpload(staged);
      throw error;
    }
  });

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
        ...(query.author !== undefined
          ? { author: { contains: query.author, mode: 'insensitive' as const } }
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
   * Карточка книги каталога.
   *
   * Отдельный маршрут, а не `GET /books/:id`: каталог виден всем вошедшим, и
   * страница книги нужна именно как страница каталога. `GET /books/:id` открыт
   * любому вошедшему тоже, но он про файл книги, а не про каталог, и смешивать
   * два разных вопроса в один адрес не стоит.
   *
   * Каталог — общий, поэтому проверки на участие в комнате здесь нет: книга из
   * каталога доступна всем, кому доступен сам каталог.
   */
  app.get('/catalog/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = bookParams.parse(request.params);
    const book = await prisma.book.findFirst({
      where: { id, isCatalog: true },
      select: bookWithFilesSelect,
    });
    if (book === null) throw AppError.notFound('Книга в каталоге');
    return { book: toBookSummary(book) };
  });

  /**
   * Убрать из каталога.
   *
   * Если книга уже лежит в комнатах, флаг снимается, а сама книга остаётся: она
   * больше не в каталоге, но по-прежнему нужна тем, кто её добавил. Удалять
   * вместе с файлами книгу, лежащую в чужой комнате, нельзя.
   */
  app.delete('/admin/catalog/:id', { preHandler: requireAdmin }, async (request) => {
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
    // Книга уже в комнате: событие не шлём. Иначе второй участник получил бы
    // «Борис добавил книгу» для книги, которая уже стояла, — и её список
    // пополнился бы дубликатом.
    if (existing !== null) return reply.code(200).send({ added: false, bookId: source.id });

    await prisma.roomBook.create({ data: { roomId, bookId: source.id } });

    const book = await prisma.book.findUniqueOrThrow({
      where: { id: source.id },
      select: bookWithFilesSelect,
    });
    bookAdded(roomId, toEventPayload(toBookSummary(book)), { id: me.id, displayName: me.displayName }, 'catalog');

    return reply.code(201).send({ added: true, bookId: source.id });
  });

  /**
   * Убрать книгу из комнаты.
   *
   * Снимается связь `RoomBook`, а сама книга и файлы остаются: книга из каталога
   * принадлежит не этой комнате, и удаление здесь снесло бы её у всех, кто её
   * добавил.
   *
   * Права не «все равны», как у одобрения заявок. Убирает владелец комнаты любую
   * книгу, участник — только ту, которую загрузил сам, админ — любую.
   *
   * ─── Почему не «все равны» ─────────────────────────────────────────────────
   *
   * Одобрение заявок ничего не разрушает: книга просто появляется, и лишнее
   * действие никому не мешает. Здесь же участник, не загружавший книгу, мог бы
   * убрать чужую — а это молчаливая порча чужой работы, которую хозяин комнаты
   * потом не найдёт.
   */
  app.delete('/rooms/:roomId/books/:bookId', { preHandler: requireAuth }, async (request) => {
    const me = currentUser(request);
    const { roomId, bookId } = roomBookParams.parse(request.params);

    const role = await memberRole(prisma, roomId, me.id);
    /*
      Админ — всегда, даже не состоя в комнате.

      Иначе «админ может убрать любую» оказывалось бы правдой только для книг в его
      собственных комнатах, а админка выглядела бы бессильной ровно там, где
      нужна: в чужой комнате, где книгу завёл не он.
    */
    if (role === null && me.role !== 'admin') {
      throw AppError.forbidden('Убирать книги может только участник комнаты');
    }

    const link = await prisma.roomBook.findUnique({
      where: { roomId_bookId: { roomId, bookId } },
      select: { id: true, book: { select: { id: true, uploadedById: true, title: true } } },
    });
    if (link === null) throw AppError.notFound('Книга в комнате');

    const canRemove =
      me.role === 'admin' || role === 'owner' || link.book.uploadedById === me.id;
    if (!canRemove) {
      throw AppError.forbidden('Убрать книгу может владелец комнаты или тот, кто её загрузил');
    }

    await prisma.roomBook.delete({ where: { id: link.id } });
    bookRemoved(roomId, bookId);

    return { ok: true };
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
   * Обложка.
   *
   * Адрес стабильный: расширение файла может быть любым, а клиент шлёт обложку
   * под именем `cover.jpg` или `cover.webp`. Если бы адрес содержал путь на диск,
   * он менялся бы при замене обложки — и старые ссылки в письмах и закладках
   * перестали бы открывать картинку.
   *
   * Отдаётся переадресацией на `/files/**`, а не своим потоком: раздача файлов
   * уже написана, в ней есть проверка токена и Range, и дублировать её во втором
   * месте — значит со временем получить два разных ответа на один файл.
   */
  app.get('/books/:id/cover', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookParams.parse(request.params);
    const book = await prisma.book.findUnique({
      where: { id },
      select: { coverPath: true },
    });
    if (book?.coverPath == null) throw AppError.notFound('Обложка');
    return reply.redirect(`/files/${book.coverPath.split(sep).join('/')}`, 302);
  });

  /**
   * Поиск книг: в своих комнатах и в каталоге.
   *
   * Один маршрут, а не «взять список комнат, потом запрос в каждую»: при пяти
   * комнатах это шесть запросов на каждый ввод, и каждый из них ходит по книгам
   * этой комнаты. Здесь один запрос с двумя выборками.
   *
   * ─── Почему не по описанию ─────────────────────────────────────────────────
   *
   * Запрос «Пушкин» нашёл бы всё, где фамилия упомянута в аннотации, и человек
   * получил бы сорок книг вместо одной. Поиск идёт по названию и автору: это то,
   * что человек помнит наверняка.
   *
   * ─── Почему админ видит только свои комнаты ─────────────────────────────────
   *
   * Фильтр идёт по членству в комнатах, а не по роли, и это не опечатка: поиск
   * отвечает на вопрос «что я читаю», и чужие комнаты к этому вопросу не имеют
   * отношения. Админский поиск по всем книгам — другой вопрос и другой адрес.
   */
  app.get('/books/search', { preHandler: requireAuth }, async (request) => {
    const { q } = searchQuery.parse(request.query ?? {});
    if (q === undefined || q.length < MIN_SEARCH_LEN) {
      return { inRooms: [], catalog: [] };
    }

    const me = currentUser(request);
    const byTitleOrAuthor = [
      { title: { contains: q, mode: 'insensitive' as const } },
      { author: { contains: q, mode: 'insensitive' as const } },
    ];

    const [links, catalog] = await Promise.all([
      prisma.roomBook.findMany({
        where: { room: { members: { some: { userId: me.id } } }, book: { OR: byTitleOrAuthor } },
        select: { roomId: true, room: { select: { name: true } }, book: { select: bookWithFilesSelect } },
        orderBy: { addedAt: 'desc' },
        take: SEARCH_LIMIT,
      }),
      prisma.book.findMany({
        where: { isCatalog: true, OR: byTitleOrAuthor },
        select: bookWithFilesSelect,
        orderBy: [{ author: 'asc' }, { title: 'asc' }],
        take: SEARCH_LIMIT,
      }),
    ]);

    return {
      inRooms: links.map((l) => {
        const summary = toBookSummary(l.book);
        return {
          id: summary.id,
          title: summary.title,
          author: summary.author,
          coverUrl: summary.coverUrl,
          hasText: summary.hasText,
          hasAudio: summary.hasAudio,
          // Комната нужна, чтобы клик вёл в читалку этой комнаты, а не в любую:
          // книга может лежать в нескольких сразу.
          roomId: l.roomId,
          roomName: l.room.name,
        };
      }),
      catalog: catalog.map((b) => {
        const summary = toBookSummary(b);
        return {
          id: summary.id,
          title: summary.title,
          author: summary.author,
          coverUrl: summary.coverUrl,
          hasText: summary.hasText,
          hasAudio: summary.hasAudio,
          isCatalog: true,
        };
      }),
    };
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

  /**
   * Удаление книги целиком, с файлами.
   *
   * Только администратор. Раньше правило было «владелец любой комнаты, где лежит
   * книга, либо админ», и оно выглядело справедливо ровно до появления каталога:
   * книга из каталога лежит сразу во многих комнатах, и кнопка в одной комнате
   * сносила её у всех остальных.
   *
   * В комнате теперь `DELETE /rooms/:roomId/books/:bookId` — снятие связи, без
   * последствий для самой книги.
   */
  app.delete('/books/:id', { preHandler: requireAdmin }, async (request) => {
    const { id } = bookParams.parse(request.params);

    const book = await prisma.book.findUnique({ where: { id }, select: { id: true } });
    if (book === null) throw AppError.notFound('Книга');

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