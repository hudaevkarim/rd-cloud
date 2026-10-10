import { findQuote, type TextAnchor } from '@rd/library/anchor';
import type { WireComment } from '../api/types.js';

/**
 * Маркеры комментариев в тексте главы.
 *
 * ─── Почему маркер ставится после рендера, а не в рендерере ───────────────────
 *
 * Рендерер библиотеки строит DOM из недоверенного дерева книги и намеренно не
 * знает ничего о комментариях. Маркер — это разметка интерфейса чтения, и
 * держать её в рендерере значило бы смешать два разных источника правды: текст
 * книги и чужие заметки к нему.
 *
 * Поэтому маркер — отдельный проход по готовому DOM. Он ищет блок по
 * `data-block`, находит в нём цитату и оборачивает её в `<mark>`.
 *
 * ─── Почему цитата ищется, а не берутся координаты как есть ─────────────────
 *
 * Координаты в якоре — от той сборки книги, которая была у автора комментария.
 * Книгу могли пересобрать из другого издания, и тогда `start/end` указывают не на
 * то место. Поэтому сначала проверяется точное совпадение, а при несовпадении
 * цитата ищется заново — сначала в том же блоке, потом в главе, потом по книге.
 * Это тот же порядок, что в `resolveTextAnchor`, и он нужен для книг, у которых
 * у разных участников разное разбиение на абзацы.
 *
 * ─── Почему обёртка не ломает координаты следующих маркеров ──────────────────
 *
 * `textContent` блока от обёртки не меняется: `<mark>` добавляет разметку, но не
 * текст. Поэтому смещения остальных комментариев остаются верными, и обрабатывать
 * их можно в любом порядке.
 */

/** Маркер одного комментария в тексте. */
const MARKER_CLASS = 'rd-comment-marker';

/**
 * Атрибут с идентификатором комментария на маркере.
 *
 * Экспортируется, потому что по нему работают обе стороны связи: панель ищет
 * маркер комментария, а маркер — запись в панели. Строка живёт в одном месте
 * иначе разъехалась бы между наложением и поиском.
 */
export const COMMENT_ATTR = 'data-comment-id';

/**
 * Оборачивает цитаты комментариев в `<mark>`.
 *
 * `chapterIndex` обязателен, и это не перестраховка.
 *
 * `data-block` — номер блока внутри главы, а не в книге: у каждой главы блоки
 * нумеруются с нуля. В контейнере отрендерена одна глава, и без номера главы
 * комментарий из пятой главы с `blockIndex: 0` подсветил бы первый блок
 * текущей. Координаты при этом сходятся, цитата находится — и подсвечено
 * оказывается место в другой главе. Молча.
 *
 * Комментарии без текстового якоря (аудио, страница) пропускаются: в тексте им
 * нечего помечать.
 *
 * Ненайденные цитаты пропускаются молча: комментарий остаётся в списке с
 * пометкой «место не найдено», а не исчезает. Потерять чужое мнение молча хуже,
 * чем показать его с оговоркой.
 */
export function applyCommentMarkers(
  host: HTMLElement,
  comments: WireComment[],
  chapterIndex: number,
): void {
  for (const comment of comments) {
    if (comment.anchorType !== 'text') continue;
    const anchor = comment.anchor;
    if (!isTextAnchor(anchor)) continue;
    if (anchor.chapterIndex !== chapterIndex) continue;

    const blockEl = host.querySelector(`[data-block="${anchor.blockIndex}"]`);
    /*
      `instanceof HTMLElement`, а не `as HTMLElement`.

      Рендерер кладёт в главу только `HTMLElement`, но это свойство DOM, а не
      TypeScript: компилятор проверяет объявления, а не то, что создал
      `renderChapter`. Блок из книги может оказаться узлом другого типа —
      и `as` молча согласился бы работать с ним дальше, падая уже в `textNodesOf`
      или в `wrapRange`, то есть далеко от причины.

      Отказ здесь означает «в этом блоке нечего помечать», и это правильно:
      лучше пропустить комментарий, чем упасть на чужой разметке.
    */
    if (!(blockEl instanceof HTMLElement)) continue;

    const text = blockEl.textContent ?? '';
    let { start, end } = anchor;

    // Точные координаты проверяются первыми: они дешевле поиска и точнее его.
    if (text.slice(start, end) !== anchor.quote) {
      const found = findQuote(text, anchor.quote, { prefix: anchor.prefix, suffix: anchor.suffix });
      if (found === null) continue;
      start = found.start;
      end = found.end;
    }

    wrapRange(blockEl, start, end, comment.id);
  }
}

/** Убирает все маркеры комментариев из контейнера. */
export function clearCommentMarkers(host: HTMLElement): void {
  for (const mark of Array.from(host.querySelectorAll(`.${MARKER_CLASS}`))) {
    const parent = mark.parentNode;
    if (parent === null) continue;
    // Содержимое маркера возвращается на место, сам маркер исчезает.
    while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);

    /*
      `normalize()` — обязательная часть снятия, а не украшение.

      Обёртка разрезает текстовый узел на три: до цитаты, цитата, после. Если их
      просто склеить обратно вручную нельзя, дерево остаётся дробным, и
      следующее наложение маркеров идёт уже по тройному числу узлов. Через
      несколько перерисовок на абзаце вместо одного текстового узла
      получаются десятки, `findQuote` начинает промахиваться мимо цитаты, а
      человек видит «комментарий потерялся».

      `normalize()` склеивает соседние текстовые узлы сам — это штатная операция
      DOM, и после неё блок выглядит ровно так, каким был до обёртки.
    */
    parent.normalize();
  }
}

function isTextAnchor(anchor: unknown): anchor is TextAnchor {
  if (typeof anchor !== 'object' || anchor === null) return false;
  const candidate = anchor as { kind?: unknown };
  return candidate.kind === 'text';
}

/**
 * Оборачивает диапазон символов в контейнере в `<mark>`.
 *
 * Диапазон задаётся в символах от начала `textContent` контейнера — ровно так,
 * как его возвращает `locateSelection` в библиотеке. Текст внутри контейнера
 * может быть разбит на много узлов (инлайновые теги, прошлые маркеры), поэтому
 * узлы обходятся по порядку, а границы диапазона попадают внутрь узлов.
 */
function wrapRange(container: HTMLElement, start: number, end: number, commentId: string): void {
  if (end <= start) return;
  const doc = container.ownerDocument;

  /*
    Один проход вместо двух.

    Сначала это было «для каждого узла найти его смещение», и это давало
    квадрат: на главе из 640 блоков и нескольких тысяч текстовых узлов каждый
    узел обходил все предыдущие. Замерять не пришлось — квадрат на таком объёме
    виден глазами как подтормаживание при открытии главы.

    Поэтому узлы собираются в массив вместе со смещениями за один обход, а
    дальше работает массив.
  */
  const nodes: Array<{ node: Text; start: number }> = [];
  let offset = 0;
  for (const node of textNodesOf(container)) {
    nodes.push({ node, start: offset });
    offset += node.data.length;
  }

  for (const { node: textNode, start: nodeStart } of nodes) {
    const len = textNode.data.length;
    if (len === 0) continue;
    const nodeEnd = nodeStart + len;
    if (nodeEnd <= start || nodeStart >= end) continue;

    const relStart = Math.max(start, nodeStart) - nodeStart;
    const relEnd = Math.min(end, nodeEnd) - nodeStart;

    const before = textNode.data.slice(0, relStart);
    const middle = textNode.data.slice(relStart, relEnd);
    const after = textNode.data.slice(relEnd);

    const mark = doc.createElement('mark');
    mark.className = MARKER_CLASS;
    /*
      Идентификатор комментария на самой обёртке.

      Без него двусторонняя связь строилась бы по координатам: панель знала бы,
      где комментарий, а текст — где подчёркивание, и единственным общим
      ключом оставалось бы «цитата и блок». При пересборке книги и одинаковых
      цитатах в разных абзацах это дало бы прыжок не туда.

      Атрибут ставится здесь, а не ищется в обратном порядке при наведении:
      обход готового DOM ради того, чтобы сопоставить его с тем, что уже
      сопоставлено при наложении, — это повторная работа и лишняя точка отказа.

      Одна цитата может дать несколько обёрток, если она пересекает инлайновый
      тег. Идентификатор у них один — и это верно: поиск по панели берёт первую
      найденную, а прокрутка к цитате показывает её целиком.
    */
    mark.setAttribute(COMMENT_ATTR, commentId);
    mark.textContent = middle;

    const parent = textNode.parentNode;
    if (parent === null) continue;
    if (before !== '') parent.insertBefore(doc.createTextNode(before), textNode);
    parent.insertBefore(mark, textNode);
    if (after !== '') parent.insertBefore(doc.createTextNode(after), textNode);
    parent.removeChild(textNode);
  }
}

/**
 * Все текстовые узлы контейнера в порядке обхода документа.
 *
 * Пустые узлы тоже идут в обход: они не добавляют длины, но и не мешают — а
 * вот пропуск их при подсчёте смещений сдвинул бы все позиции после них.
 */
function* textNodesOf(container: HTMLElement): Generator<Text> {
  /*
    `SHOW_TEXT`, а не число из головы: у `NodeFilter` свои значения, и 128 — это
    `SHOW_COMMENT`. С ним обход не находил ни одного текстового узла, маркеры не
    ставились вовсе, и это выглядело как «цитата не найдена».
  */
  const walker = container.ownerDocument.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
  let node = walker.nextNode();
  while (node !== null) {
    yield node as Text;
    node = walker.nextNode();
  }
}
