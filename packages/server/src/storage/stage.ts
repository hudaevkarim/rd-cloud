import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Приёмка нескольких файлов из одного multipart.
 *
 * ─── Зачем отдельная функция, а не доработка `streamMultipartFile` ────────────
 *
 * Одиночная функция обрывает чтение на первом файле (`break`): тело запроса
 * читается один раз, и второй файл просто не попал бы в обработку. Для формы
 * каталога, где текст и аудио необязательны, это не годится.
 *
 * Разные задачи — разные функции. Одиночная нужна для загрузки в комнату: там
 * файл ровно один, контракт «поля раньше файла» проверяется и работает, а
 * лишняя обобщённость в ней была бы неоправданным усложнением.
 *
 * ─── Имя поля несёт вид файла ────────────────────────────────────────────────
 *
 * `text`, `audio`, `cover` — вид известен из имени, поэтому зависимости
 * «поля раньше файла» здесь нет вовсе: лимит каждого файла известен до того,
 * как пришёл хоть один его байт. Формат берётся из расширения.
 *
 * ─── Две фазы ────────────────────────────────────────────────────────────────
 *
 * Первая пишет всё в `DATA_DIR/tmp/<uploadId>/` и разбирает текст. Вторая
 * переносит в `files/<bookFileId>/` и создаёт записи в базе.
 *
 * Порядок выбран из одного сценария: админ присылает валидный EPUB и аудио на
 * 3 ГБ при лимите 2 ГБ. Если писать сразу в `files/`, первый файл уже лежит на
 * диске, второй отвалился, транзакция откатилась — а на диске остался мусор,
 * на который больше никто не ссылается. При двух фазах отказ случается до
 * появления чего-либо в `files/`.
 *
 * То же самое с разбором: EPUB разбирается в первой фазе, и упавший разбор
 * не оставляет ни строки в базе, ни оглавления, обещающего несуществующие
 * главы.
 *
 * ─── Почему «перенести», а не «скопировать» ─────────────────────────────────
 *
 * `rename` в пределах одного диска атомарен и не читает файл: книга на 50 МБ
 * не копируется дважды. Разные каталоги внутри `DATA_DIR` — одна файловая
 * система, поэтому атомарность сохраняется.
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

/** Какой файл ожидается в поле. */
export interface FileSpec {
  /** Имя поля в multipart. */
  field: string;
  /** Расширения без точки, в нижнем регистре. */
  extensions: readonly string[];
  /** Предел на этот файл. */
  maxBytes: number;
  /** Человеческое имя в сообщении об отказе. */
  label: string;
}

/** Принятый файл: лежит во временном каталоге, в базе записей ещё нет. */
export interface StagedFile {
  field: string;
  /** Расширение, каким файл оказался на диске. */
  ext: string;
  /** Относительно `DATA_DIR`: `tmp/<uploadId>/<field>.<ext>`. */
  stagedPath: string;
  /** Абсолютный путь — для разбора, который читает файл целиком. */
  absolutePath: string;
  size: number;
}

export interface StagedUpload {
  /** Идентификатор попытки: имя каталога во временной папке. */
  uploadId: string;
  dataRoot: string;
  fields: MultipartFields;
  /** Ключ — имя поля из `FileSpec`. */
  files: Map<string, StagedFile>;
}

/** Расширение файла в нижнем регистре, без точки. `''`, если его нет. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Принять файлы из multipart во временный каталог.
 *
 * Возвращает принятое; при любой ошибке временный каталог убирается целиком, и
 * вызывающий получает чистое состояние — ничего не придётся домывать вручную.
 */
export async function stageMultipartFiles(
  request: FastifyRequest,
  options: { dataRoot: string; uploadId: string; specs: readonly FileSpec[] },
): Promise<StagedUpload> {
  if (!request.isMultipart()) {
    throw AppError.badRequest('Ожидается multipart/form-data');
  }

  const { dataRoot, uploadId, specs } = options;
  const byField = new Map(specs.map((s) => [s.field, s]));

  const dir = join(dataRoot, 'tmp', uploadId);
  await mkdir(dir, { recursive: true });

  const fields: MultipartFields = {};
  const files = new Map<string, StagedFile>();

  try {
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        const spec = byField.get(part.fieldname);
        if (spec === undefined) {
          // Чужое поле с файлом: содержимое пропускается, иначе клиент,
          // приславший его по ошибке, упрётся в лимит.
          part.file.resume();
          continue;
        }

        // Второй файл в том же поле — ошибка формы, а не файла: одна книга
        // не может иметь два текста.
        if (files.has(part.fieldname)) {
          part.file.resume();
          throw AppError.badRequest(`В поле «${spec.field}» уже есть файл`);
        }

        const ext = extensionOf(part.filename);
        if (!spec.extensions.includes(ext)) {
          part.file.resume();
          throw AppError.badRequest(
            `${spec.label}: формат «${ext === '' ? 'без расширения' : `.${ext}`}» не поддерживается`,
          );
        }

        // Сначала во временное имя с тем же расширением: `rename` не переименовывает
        // файл, только запись, и итоговое имя получается на месте.
        const finalPath = join(dir, `${spec.field}.${ext}`);

        let received = 0;
        const limiter = new ByteLimit(spec.maxBytes, (total) => {
          received = total;
        });

        await pipeline(part.file, limiter, createWriteStream(finalPath, { flags: 'wx' }));

        if (received === 0) {
          throw AppError.badRequest(`${spec.label}: файл пустой`);
        }

        files.set(spec.field, {
          field: spec.field,
          ext,
          stagedPath: join('tmp', uploadId, `${spec.field}.${ext}`),
          absolutePath: finalPath,
          size: received,
        });
        continue;
      }

      // Текстовое поле. Содержимое приходит буфером, но мы его не копируем
      // целиком, а отрезаем по лимиту.
      const buffer = part.value as Buffer;
      if (buffer.length > MAX_FIELD_BYTES) {
        throw AppError.badRequest(`Поле «${part.fieldname}» слишком велико`);
      }
      fields[part.fieldname] = buffer.toString('utf8');
    }

    return { uploadId, dataRoot, fields, files };
  } catch (error) {
    await discardStagedUpload({ dataRoot, uploadId });
    if (error instanceof AppError) throw error;
    // Обрыв соединения и отмена приходят сюда как обычные ошибки потока. Для
    // клиента это «загрузка прервана», а не 500: он ничего не испортил и может
    // повторить.
    logger.warn({ err: error, uploadId }, 'загрузка прервана, временные файлы удалены');
    throw new AppError(400, 'upload_aborted', 'Загрузка прервана, файлы не сохранены');
  }
}

/**
 * Принятый файл, поднятый до своей конечной папки.
 *
 * Папка — своя у каждого файла книги: идентификатор выдаётся базой уже после
 * вставки, а переименовывать каталог на месте дороже, чем создать новый.
 */
export interface PlacedFile {
  /** Поле multipart, из которого пришёл файл: `text`, `audio` или `cover`. */
  field: string;
  /** Идентификатор папки файла. */
  fileId: string;
  /** Относительно `DATA_DIR`: `files/<fileId>/original.<ext>`. */
  filePath: string;
  absolutePath: string;
  ext: string;
  size: number;
}

/**
 * Вторая фаза: перенести принятые файлы на место.
 *
 * Вызывается после проверки метаданных и разбора, но до вставки в базу: если
 * вставка не пройдёт, `dropPlacedFiles` вернёт всё на место отсутствия.
 */
export async function placeStagedFiles(
  upload: StagedUpload,
  specs: readonly FileSpec[],
): Promise<PlacedFile[]> {
  const placed: PlacedFile[] = [];
  const byField = new Map(specs.map((s) => [s.field, s]));

  try {
    for (const staged of upload.files.values()) {
      // `FileSpec` нужен только ради расширения: поле могло встретиться один раз,
      // а найти его по имени нечем — если специфика нет, поле неизвестно.
      if (!byField.has(staged.field)) throw new Error(`нет специфика для поля ${staged.field}`);

      const fileId = randomUUID();
      const dir = join(upload.dataRoot, 'files', fileId);
      await mkdir(dir, { recursive: true });

      const finalPath = join(dir, `original.${staged.ext}`);
      await rename(staged.absolutePath, finalPath);

      placed.push({
        field: staged.field,
        fileId,
        filePath: join('files', fileId, `original.${staged.ext}`),
        absolutePath: finalPath,
        ext: staged.ext,
        size: staged.size,
      });
    }
    return placed;
  } catch (error) {
    await dropPlacedFiles(upload.dataRoot, placed);
    throw error;
  }
}

/** Убрать поднятые файлы, если вставка в базу не прошла. */
export async function dropPlacedFiles(
  dataRoot: string,
  placed: readonly PlacedFile[],
): Promise<void> {
  for (const file of placed) {
    await rm(join(dataRoot, 'files', file.fileId), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Убрать временный каталог попытки вместе со всем принятым. */
export async function discardStagedUpload(upload: {
  dataRoot: string;
  uploadId: string;
}): Promise<void> {
  await rm(join(upload.dataRoot, 'tmp', upload.uploadId), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
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