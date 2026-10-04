/**
 * Видимость блоков и глав.
 *
 * Функции переехали сюда из `render/reader.ts`, где они лежали в модуле про DOM.
 * Они чистые: работают только с разобранной книгой и не касаются `document`.
 * Разделение нужно для одной конкретной вещи: сервер тоже должен знать, какие
 * главы непустые, — иначе он отдаст клиенту оглавление с пунктами, на которые
 * нечего открыть. Импорт `@rd/library/render` на сервере упал бы с
 * «рендерер доступен только в браузере», а здесь ничего трогать не нужно.
 *
 * Второй довод в пользу раздельного модуля — правило «пустой блок не виден»
 * теперь живёт в одном месте. `renderBlock` возвращает `null` для пустых
 * абзацев и картинок без подписи, и если бы проверка осталась в рендерере,
 * рано или поздно она разошлась бы с самим рендерером: глава выглядела бы
 * пустой страницей, и единственный способ добраться до текста — жать
 * «Следующая».
 */

import type { EpubBlock, EpubChapter } from './epub.js';

/**
 * Даст ли блок видимый элемент.
 *
 * `renderBlock` возвращает null для пустых абзацев и картинок без подписи, и на
 * практике встречаются главы, где ВСЕ блоки такие: страница с обложкой,
 * файл с одним `<img>` или набор пустых `<p>` от вёрстки.
 */
export function isBlockVisible(block: EpubBlock): boolean {
  if (block.kind === 'hr') return true;
  if (block.text.trim() !== '') return true;
  // Блок с одной картинкой и без подписи тоже даёт пустой элемент.
  return false;
}

/** Есть ли в главе хоть один видимый блок. */
export function hasVisibleBlocks(chapter: { blocks: EpubBlock[] } | undefined): boolean {
  return chapter !== undefined && chapter.blocks.some(isBlockVisible);
}

/**
 * Первая глава с видимым текстом, начиная с `from`.
 *
 * Возвращает `from`, если у него есть текст, иначе ищет дальше. Используется
 * читалкой при открытии книги: иначе пользователь попадает на пустую страницу
 * и не понимает, что произошло.
 */
export function firstVisibleChapter(
  book: { chapters: EpubChapter[] },
  from: number,
): number {
  for (let i = Math.max(0, from); i < book.chapters.length; i++) {
    if (hasVisibleBlocks(book.chapters[i])) return i;
  }
  return Math.max(0, Math.min(from, Math.max(0, book.chapters.length - 1)));
}