import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Потоковая приёмка файла из multipart.
 *
 * ─── Один проход, и это не оптимизация ───────────────────────────────────────
 *
 * `request.parts()` — асинхронный итератор, и тело запроса можно прочитать
 * только раз. Поэтому «сначала собрать поля, потом записать файл» в два
 * захода невозможно: после первого прохода поток исчерпан. Поля и файл
 * обрабатываются в одном цикле.
 *
 * ─── Порядок частей ──────────────────────────────────────────────────────────
 *
 * Отсюда же следует требование: текстовые поля должны приходить **раньше
 * файла**. Лимит зависит от `kind` — 50 МБ для текста и 2 ГБ для аудио, — а
 * знать его нужно до того, как байты лягут на диск. Файл раньше нужных полей
 * отклоняется: принять 2 ГБ и потом обнаружить, что это книга, нельзя.
 *
 * Это контракт к клиенту, а не деталь реализации, и он проверяется явно.
 *
 * ─── Обрыв соединения ───────────────────────────────────────────────────────
 *
 * Пока файл не дописан, на диске лежит только `original.part`, и записей в
 * базе нет вообще. Обрыв, отмена и ошибка записи приводят к удалению
 * недописанного файла. Строка в базе появляется лишь после успешного конца —
 * то есть строки без файла не бывает.
 */

/** Поля запроса. Значения — строки, их немного и они маленькие. */
export type MultipartFields = Record<string, string>;

/**
 * Предел на размер одного текстового поля: 8 КБ.
 *
 * Без него клиент может прислать «поле» размером с книгу, и оно целиком
 * осядет в памяти до того, как начнётся проверка общего лимита.
 */
const MAX_FIELD_BYTES = 8 * 1_024;

const DEFAULT_FILE_FIELD = 'file';

export interface StreamedFile {
  /** Путь относительно DATA_DIR: `files/<id>/original.<ext>`. */
  relativePath: string;
  absolutePath: string;
  size: number;
  fields: MultipartFields;
}

export interface StreamOptions {
  bookFileId: string;
  dataRoot: string;
  /**
   * Лимит и расширение — вычисляются из уже собранных полей.
   *
   * Вызывается в момент, когда встретился файл: к этому моменту все поля, шёлшие
   * раньше, уже лежат в аргументе. Если нужного поля нет, выбрасывается ошибка
   * про порядок частей.
   */
  resolve: (fields: MultipartFields) => { maxBytes: number; ext: string };
  /** Имя поля с файлом. */
  fileField?: string;
}

export async function streamMultipartFile(
  request: FastifyRequest,
  options: StreamOptions,
): Promise<StreamedFile> {
  if (!request.isMultipart()) {
    throw AppError.badRequest('Ожидается multipart/form-data');
  }

  const { bookFileId, dataRoot } = options;
  const fileField = options.fileField ?? DEFAULT_FILE_FIELD;

  const dir = join(dataRoot, 'files', bookFileId);
  const tempPath = join(dir, 'original.part');

  await mkdir(dir, { recursive: true });

  const fields: MultipartFields = {};
  let finalPath: string | null = null;
  let received = 0;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== fileField) {
          // Чужое поле с файлом: содержимое пропускается, иначе клиент,
          // приславший его по ошибке, упрётся в лимит.
          part.file.resume();
          continue;
        }

        const { maxBytes, ext } = options.resolve(fields);

        finalPath = join(dir, `original.${ext}`);
        const limiter = new ByteLimit(maxBytes, (total) => {
          received = total;
        });

        // `wx` — не перезаписывать. Остаток прошлой попытки обязан обнаружиться
        // ошибкой, а не молча затёрться.
        await pipeline(part.file, limiter, createWriteStream(tempPath, { flags: 'wx' }));
        break;
      }

      // Текстовое поле. Содержимое приходит буфером, но мы его не копируем
      // целиком, а отрезаем по лимиту.
      const buffer = part.value as Buffer;
      if (buffer.length > MAX_FIELD_BYTES) {
        throw AppError.badRequest(`Поле «${part.fieldname}» слишком велико`);
      }
      fields[part.fieldname] = buffer.toString('utf8');
    }

    if (finalPath === null || received === 0) {
      await rm(tempPath, { force: true });
      throw AppError.badRequest(`Не найден файл в поле «${fileField}»`);
    }

    // Один каталог, поэтому rename атомарен: читатель не увидит ни половины
    // файла, ни файла под временным именем.
    await rename(tempPath, finalPath);

    return {
      relativePath: `files/${bookFileId}/original.${finalPath.slice(finalPath.lastIndexOf('.') + 1)}`,
      absolutePath: finalPath,
      size: received,
      fields,
    };
  } catch (error) {
    // Убираем не только недописанный файл, но и каталог: он остался бы пустым,
    // и после десятка неудачных загрузок в DATA_DIR копились бы пустые папки,
    // в которых ничего не разобрать и не удалить.
    await rm(tempPath, { force: true }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    // Обрыв соединения и отмена приходят сюда как обычные ошибки потока. Для
    // клиента это «загрузка прервана», а не 500: он ничего не испортил и может
    // повторить.
    logger.warn({ err: error, bookFileId }, 'загрузка прервана, временный файл удалён');
    throw new AppError(400, 'upload_aborted', 'Загрузка прервана, файл не сохранён');
  }
}

/** Удаление файла книги с диска вместе с опустевшим каталогом. */
export async function removeUploaded(dataRoot: string, relativePath: string): Promise<void> {
  await rm(join(dataRoot, relativePath), { force: true }).catch(() => undefined);
  const parts = relativePath.split(/[\\/]/);
  const idx = parts.indexOf('files');
  const id = parts[idx + 1];
  if (idx >= 0 && id !== undefined) {
    await rm(join(dataRoot, 'files', id), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Ограничитель размера, вставленный в поток.
 *
 * Transform, а не проверка после `pipeline`: превышение лимита обязано остановить
 * запись на середине. Проверка «после» пропустила бы на диск все 2 ГБ файла с
 * лимитом 50 МБ, и отказ пришлось бы ловить уже на заполненном диске.
 */
class ByteLimit extends Transform {
  readonly #max: number;
  readonly #onTotal: (total: number) => void;
  #total = 0;

  constructor(max: number, onTotal: (total: number) => void) {
    super();
    this.#max = max;
    this.#onTotal = onTotal;
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (err?: Error | null) => void,
  ): void {
    this.#total += chunk.length;
    this.#onTotal(this.#total);

    if (this.#total > this.#max) {
      done(
        new AppError(
          413,
          'file_too_large',
          `Файл больше лимита в ${Math.round(this.#max / 1_048_576)} МБ`,
        ),
      );
      return;
    }

    // Без `push` данные до файла не дойдут: Transform передаёт дальше только то,
    // что положил в буфер сам. Счётчик при этом честно покажет принятый объём —
    // файл получится пустым, а счётчик скажет, что всё в порядке.
    this.push(chunk);
    done();
  }
}