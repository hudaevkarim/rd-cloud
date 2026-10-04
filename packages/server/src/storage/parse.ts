import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseFb2, parseEpub, type ParsedEpub } from '@rd/library/parse';

/**
 * Разбор книги на сервере и раскладка по файлам.
 *
 * ─── Зачем сервер, а не клиент ───────────────────────────────────────────────
 *
 * В проекте `rd` клиент скачивал книгу целиком и разбирал её у себя. На
 * телефоне это и было главным препятствием: мегабайтная загрузка вместо
 * открытия. Здесь файл разбирается один раз при загрузке, а клиент берёт
 * `index.json` (десятки килобайт) и подгружает главы по мере надобности.
 *
 * ─── Что уходит на диск ─────────────────────────────────────────────────────
 *
 *   derived/<id>/index.json   оглавление, число глав и блоков, без дерева
 *   derived/<id>/ch/0000.json блоки одной главы
 *
 * Дерево блоков (`EpubBlock.node`) в `index.json` не кладём: это основной объём
 * данных, а клиенту оглавление нужно целиком и содержимое глав — по одной.
 */

/**
 * Версия разбора.
 *
 * Меняется при изменении формата `index.json` или `ch/*.json`. Загруженная книга
 * хранит версию в `BookFile.parserVersion`; если она не совпадёт, derived-файлы
 * считаются устаревшими и разбор повторяется.
 *
 * Строка сравнивается целиком, а не по semver: формат derived здесь не
 * меняется по расписанию, а переход с одной версии на другую всегда требует
 * полного переразбора всех книг.
 */
export const PARSER_VERSION = '1';

export interface ChapterSummary {
  index: number;
  id: string;
  href: string;
  title: string;
  blockCount: number;
}

export interface BookIndexFile {
  version: 1;
  parserVersion: string;
  title: string;
  author: string;
  language: string;
  totalBlocks: number;
  chapters: ChapterSummary[];
  toc: Array<{ label: string; chapterIndex: number; blockIndex: number }>;
  coverHref: string | null;
}

export interface ParseResult {
  index: BookIndexFile;
  chaptersWritten: number;
}

/** `0000`, `0001`, … — глава 10000 должна сортироваться после 0999. */
function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Определение формата по содержимому, а не по имени файла.
 *
 * Имя приходит от клиента и может быть каким угодно, а `parseFb2` и `parseEpub`
 * бросают разные исключения. Понятная ошибка в ответе полезнее стектрейса в
 * логе.
 */
export function detectFormat(bytes: Uint8Array): 'epub' | 'fb2' {
  // FB2 — текст, поэтому ищем не сигнатуру, а корневой тег. Достаточно первых
  // 4 КБ: объявление XML и открывающий элемент всегда в самом начале.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4_096));
  if (/<fictionbook/i.test(head)) return 'fb2';

  // EPUB — zip, сигнатура `PK\x03\x04` в начале файла.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return 'epub';
  }

  throw new Error('Не удалось определить формат: ожидался EPUB (zip) или FB2 (XML)');
}

/**
 * Разбор и запись derived-файлов.
 *
 * Пишем во временный каталог и переименовываем в конце. Иначе при падении на
 * середине на диске осталось бы оглавление, обещающее несуществующие главы:
 * клиент запросил бы `ch/0003.json` и получил бы 404 без видимой причины.
 */
export async function parseAndStoreText(
  dataRoot: string,
  bookFileId: string,
  bytes: Uint8Array,
): Promise<ParseResult> {
  const format = detectFormat(bytes);
  const book: ParsedEpub = format === 'fb2' ? parseFb2(bytes) : parseEpub(bytes);

  const finalDir = join(dataRoot, 'derived', bookFileId);
  const tempDir = join(dataRoot, 'derived', `.tmp-${bookFileId}`);

  // Остатки прошлой попытки: без этого она осталась бы навсегда.
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(join(tempDir, 'ch'), { recursive: true });

  // Заголовок главы ищем в оглавлении: там он уже приведён к читаемому виду.
  // Поиск по массиву для каждой главы дал бы O(главы × оглавление), а в книге
  // на 800 главах это уже заметно.
  const tocByChapter = new Map<number, string>();
  for (const entry of book.toc) {
    if (!tocByChapter.has(entry.chapterIndex)) tocByChapter.set(entry.chapterIndex, entry.label);
  }

  try {
    const chapters: ChapterSummary[] = [];

    for (const chapter of book.chapters) {
      await writeFile(
        join(tempDir, 'ch', `${pad(chapter.index)}.json`),
        JSON.stringify(chapter.blocks),
        'utf8',
      );

      // Заголовок главы: из оглавления, иначе из первого блока — он обычно и
      // есть заголовок.
      const title =
        tocByChapter.get(chapter.index) ??
        chapter.blocks[0]?.text.slice(0, 120) ??
        `Глава ${chapter.index + 1}`;

      chapters.push({
        index: chapter.index,
        id: chapter.id,
        href: chapter.href,
        title,
        blockCount: chapter.blocks.length,
      });
    }

    const index: BookIndexFile = {
      version: 1,
      parserVersion: PARSER_VERSION,
      title: book.title,
      author: book.author,
      language: book.language,
      totalBlocks: book.totalBlocks,
      chapters,
      toc: book.toc.map((t) => ({
        label: t.label,
        chapterIndex: t.chapterIndex,
        blockIndex: t.blockIndex,
      })),
      coverHref: book.coverHref,
    };

    await writeFile(join(tempDir, 'index.json'), JSON.stringify(index), 'utf8');

    await rm(finalDir, { recursive: true, force: true });
    await rename(tempDir, finalDir);

    return { index, chaptersWritten: chapters.length };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Путь к оглавлению относительно DATA_DIR.
 *
 * Аргумент — `derivedPath` из `BookFile`, а не идентификатор записи: каталог на
 * диске назван по UUID, который был у файла в момент загрузки, и он не совпадает
 * с `BookFile.id`, выданным базой. Именно `derivedPath` и хранит правильное имя.
 */
export function indexPath(derivedPath: string): string {
  return `${derivedPath}/index.json`;
}

/** Путь к файлу главы относительно DATA_DIR. */
export function chapterPath(derivedPath: string, chapterIndex: number): string {
  return `${derivedPath}/ch/${pad(chapterIndex)}.json`;
}

/**
 * Чтение derived-файла с проверкой, что путь не вышел за DATA_DIR.
 *
 * `relativePath` приходит из базы, а не от клиента, но проверка всё равно
 * стоит: стоимость — одно сравнение строк, цена ошибки — чтение
 * произвольного файла с диска.
 */
export async function readDerived(dataRoot: string, relativePath: string): Promise<string | null> {
  const root = resolve(dataRoot);
  const target = resolve(join(root, relativePath));
  const rel = relative(root, target);

  // Пустой результат означает «вышли за пределы каталога» или «файла нет» —
  // в обоих случаях клиенту положено получить 404, а не разницу в поведении.
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) return null;

  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Удаление каталога разбора по относительному пути.
 *
 * Принимает именно `derivedPath` из базы, а не идентификатор записи: каталог на
 * диске назван по UUID, который был у файла при загрузке, и он не совпадает с
 * `BookFile.id`. Передача id приводила бы к удалению несуществующего пути и
 * каталоги копились бы на диске.
 */
export async function rmDerivedDir(dataRoot: string, derivedPath: string): Promise<void> {
  const root = resolve(dataRoot);
  const target = resolve(join(root, derivedPath));
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) return;
  await rm(target, { recursive: true, force: true });
}

/** Удаление каталога разбора по идентификатору файла. */
export async function removeDerived(dataRoot: string, bookFileId: string): Promise<void> {
  await rmDerivedDir(dataRoot, `derived/${bookFileId}`);
}

/** Путь незавершённой загрузки: рядом с целью, чтобы rename был атомарным. */
export function tempUploadPath(dataRoot: string, bookFileId: string): string {
  return join(dataRoot, 'files', bookFileId, 'original.part');
}

/** Итоговый путь файла относительно DATA_DIR. */
export function uploadPath(bookFileId: string, ext: string): string {
  return `files/${bookFileId}/original.${ext}`;
}

/** Абсолютный путь файла относительно DATA_DIR. */
export function absolutePath(dataRoot: string, relativePath: string): string {
  return resolve(join(resolve(dataRoot), relativePath));
}