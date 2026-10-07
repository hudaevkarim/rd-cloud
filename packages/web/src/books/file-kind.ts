/**
 * Определение вида книги по файлу.
 *
 * ─── Почему это на клиенте ───────────────────────────────────────────────────
 *
 * Сервер тоже знает форматы, но человек узнаёт о неподдерживаемом формате раньше,
 * чем отправит файл: выбор файла — это первый шаг формы, и отказ на нём дешевле,
 * чем полминуты загрузки пятидесяти мегабайт до сообщения об ошибке.
 *
 * Здесь же живут лимиты — по тем же причинам, что и на сервере, но показанные
 * заранее.
 */

/** Вид книги. `text` читают, `audio` слушают. */
export type BookKind = 'text' | 'audio';

/** Формат, который понимает сервер. */
export type BookFormat = 'epub' | 'fb2' | 'pdf' | 'mp3' | 'm4b';

export interface DetectedFile {
  kind: BookKind;
  format: BookFormat;
  extension: string;
}

/**
 * Лимиты. Ровно те же числа, что на сервере.
 *
 * Дублирование здесь осознанное: показывать лимит надо **до** отправки, а
 * спрашивать сервер ради одного числа — лишний запрос на каждое открытие формы.
 * Расхождение чисел не приведёт к тихой поломке: сервер всё равно откажет
 * слишком большой файл, и человек увидит сообщение — просто позже.
 */
export const TEXT_LIMIT_BYTES = 50 * 1_024 * 1_024;
export const AUDIO_LIMIT_BYTES = 2 * 1_024 * 1_024 * 1_024;
/** Обложка: пять мегабайт хватает для картинки с любого магазина. */
export const COVER_LIMIT_BYTES = 5 * 1_024 * 1_024;

/** Расширения, которые сервер примет как книгу. */
const BY_EXTENSION: Record<string, DetectedFile> = {
  epub: { kind: 'text', format: 'epub', extension: 'epub' },
  fb2: { kind: 'text', format: 'fb2', extension: 'fb2' },
  pdf: { kind: 'text', format: 'pdf', extension: 'pdf' },
  mp3: { kind: 'audio', format: 'mp3', extension: 'mp3' },
  m4b: { kind: 'audio', format: 'm4b', extension: 'm4b' },
  // m4a — тот же контейнер, что и m4b, и звучит так же. Сервер примет его по
  // расширению `m4b`: имя файла на сервере задаёт сам.
  m4a: { kind: 'audio', format: 'm4b', extension: 'm4b' },
};

/** Расширения обложек. HEIC намеренно нет: браузеры его не показывают. */
const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/** Расширение в нижнем регистре, без точки. `''`, если расширения нет. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Определить вид и формат по имени файла.
 *
 * `null`, а не исключение: файл выбирают мышью, и «это не похоже на книгу» —
 * это состояние формы, а не сбой программы.
 */
export function detectBookFile(filename: string): DetectedFile | null {
  return BY_EXTENSION[extensionOf(filename)] ?? null;
}

/** Похоже ли имя файла на обложку. */
export function isCoverFile(filename: string): boolean {
  return COVER_EXTENSIONS.includes(extensionOf(filename));
}

/**
 * Человеческий размер: «12,4 МБ», а не «12996646».
 *
 * Целая часть без дробной: «не больше 50,0 МБ» читается как машинный вывод, а
 * человек думает о «50 МБ». Запятая — разделитель дробной части, проект русский,
 * и точка среди русского текста выглядела бы как опечатка.
 */
export function humanSize(bytes: number): string {
  const trim = (value: number): string => String(Number(value.toFixed(1))).replace('.', ',');

  if (bytes < 1_024) return `${bytes} Б`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} КБ`;
  if (bytes < 1_024 * 1_024 * 1_024) return `${trim(bytes / (1_024 * 1_024))} МБ`;
  return `${trim(bytes / (1_024 * 1_024 * 1_024))} ГБ`;
}

/** Лимит по виду. */
export function limitFor(kind: BookKind): number {
  return kind === 'text' ? TEXT_LIMIT_BYTES : AUDIO_LIMIT_BYTES;
}

/**
 * Размер файла против лимита.
 *
 * Сообщение возвращается готовым: подставлять его в разные места значило бы
 * разойтись в формулировке, а человек читает именно его.
 */
export function oversizeMessage(kind: BookKind, bytes: number): string | null {
  const limit = limitFor(kind);
  if (bytes <= limit) return null;
  return kind === 'text'
    ? `Текст не больше ${humanSize(limit)}. Этот файл — ${humanSize(bytes)}.`
    : `Аудио не больше ${humanSize(limit)}. Этот файл — ${humanSize(bytes)}.`;
}

/** Проверка обложки: формат и размер. */
export function coverProblem(file: File): string | null {
  if (!isCoverFile(file.name)) {
    return 'Обложка: только .jpg, .png или .webp. Другие форматы браузеры могут не показать.';
  }
  if (file.size > COVER_LIMIT_BYTES) {
    return `Обложка не больше ${humanSize(COVER_LIMIT_BYTES)}. Этот файл — ${humanSize(file.size)}.`;
  }
  return null;
}

/**
 * Имя файла без расширения — для предзаполнения названия.
 *
 * Человек почти всегда называет файл по названию книги, и пустая форма с полем
 * «название» — это лишний вопрос там, где ответ уже есть.
 */
export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot === -1 ? filename : filename.slice(0, dot);
  return base.replace(/_+/g, ' ').trim();
}