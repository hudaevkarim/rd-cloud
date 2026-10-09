import { locateSelection } from '@rd/library/render';
import type { TextAnchor } from '@rd/library/anchor';

/**
 * Якорь из выделения мышью.
 *
 * ─── Почему не `selection.toString()` ─────────────────────────────────────────
 *
 * Выделение браузера даёт строку, а якорь — координаты **в тексте блока**. Это
 * разные вещи, и брать первую вместо второй нельзя: `Range.toString()`
 * возвращает видимый текст, а он может отличаться от `textContent` блока
 * (пробелы между инлайновыми элементами, мягкие переносы в разметке). Смещение,
 * посчитанное по видимому тексту, указало бы на другое место — и маркер лёг бы
 * не туда.
 *
 * Поэтому цитата берётся из `textContent` блока по найденным смещениям. Тогда
 * инвариант, на котором держится весь механизм, соблюдается буквально:
 * `block.textContent.slice(start, end) === anchor.quote`. Именно это проверяет
 * `applyCommentMarkers`, когда накладывает маркер, — и именно поэтому проверка
 * проходит с первого раза, без дорогого поиска по цитате.
 *
 * ─── Почему смещения берутся из библиотеки ─────────────────────────────────────
 *
 * `locateSelection` уже решает самую трудную часть: находит ближайший блок по
 * `data-block` и переводит позиции `Range` в смещения от начала текста блока
 * через `Range.setEnd`. Написать это заново здесь означало бы завести в проекте
 * вторую реализацию одного и того же и со временем получить две разные.
 *
 * ─── Почему контекст 32 символа ───────────────────────────────────────────────
 *
 * Ровно `CONTEXT_LEN` из `@rd/library`: столько же, сколько использует
 * `findQuote` при поиске цитаты. Больше контекст не помогает — он и так
 * различает повторяющиеся цитаты, — а меньше ослабляет тот самый поиск.
 */

/** Сколько символов контекста берётся слева и справа. Как в библиотеке. */
const CONTEXT_LEN = 32;

/** Понятное человеку объяснение, почему якорь не построился. */
export type SelectionRefusal = 'empty' | 'outside' | 'across-blocks';

export type SelectionPick =
  | { ok: true; anchor: TextAnchor }
  | { ok: false; refusal: SelectionRefusal };

/**
 * Строит якорь по текущему выделению.
 *
 * `host` — контейнер главы, тот же, что у `ChapterView`. Вне него блоков нет,
 * и выделение в оглавлении или в панели глав не является выделением в тексте.
 */
export function anchorFromSelection(
  host: HTMLElement,
  chapterIndex: number,
  selection: Selection | null,
): SelectionPick {
  if (selection === null || selection.rangeCount === 0) return { ok: false, refusal: 'empty' };

  const range = selection.getRangeAt(0);
  // Схлопнувшееся выделение — это обычный клик по тексту, а не выбор фрагмента.
  if (range.collapsed) return { ok: false, refusal: 'empty' };

  const startBlock = blockOf(range.startContainer, host);
  const endBlock = blockOf(range.endContainer, host);

  if (startBlock === null || endBlock === null) return { ok: false, refusal: 'outside' };
  /*
    Выделение через два абзаца не привязывается.

    Якорь умеет описать только одно место: `blockIndex` — число. Выделение через
    два абзаца потребовало бы диапазона блоков, а такой формы у якоря нет, и
    `validateAnchor` его всё равно отверг бы. Молча обрезать выделение до первого
    абзаца нельзя: человек комментирует фразу, а получит комментарий к её
    началу и не поймёт почему.
  */
  if (startBlock !== endBlock) return { ok: false, refusal: 'across-blocks' };

  const located = locateSelection(host, range);
  if (located === null) return { ok: false, refusal: 'outside' };

  const blockText = startBlock.textContent ?? '';
  const { start, end } = located;

  // Пустой или пробельный фрагмент комментарием быть не может: на сервере он
  // отвергнут как «пустая цитата», и человек увидел бы ошибку там, где мог
  // бы просто выделить что-то другое.
  const quote = blockText.slice(start, end);
  if (quote.trim() === '') return { ok: false, refusal: 'empty' };

  return {
    ok: true,
    anchor: {
      kind: 'text',
      chapterIndex,
      blockIndex: located.blockIndex,
      start,
      end,
      quote,
      prefix: blockText.slice(Math.max(0, start - CONTEXT_LEN), start),
      suffix: blockText.slice(end, end + CONTEXT_LEN),
    },
  };
}

/**
 * Ближайший блок выше узла.
 *
 * Идёт от текстового узла к родителям, потому что границы выделения почти
 * всегда стоят внутри текста, а не на элементе.
 */
function blockOf(node: Node, host: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null && current !== host) {
    if (current instanceof HTMLElement && current.hasAttribute('data-block')) return current;
    current = current.parentNode;
  }
  return null;
}

/**
 * Где показать кнопку над выделением.
 *
 * ─── Координаты окна, а не страницы ───────────────────────────────────────────
 *
 * `getBoundingClientRect()` отдаёт координаты окна, и кнопка ставится
 * `position: fixed`. Возвращаемые координаты — тоже координаты окна: это важно,
 * потому что промах на величину смещения контейнера не выглядит ошибкой, а
 * выглядит как «кнопка в углу». Проверено в браузере: глава начиналась на
 * `left: 352`, и кнопка вставала в `left: 0` — то есть над текстом, который
 * находится в другой части экрана.
 *
 * ─── Зачем тогда прямоугольник контейнера ─────────────────────────────────────
 *
 * Он нужен для двух проверок, а не для координат: есть ли место сверху внутри
 * главы, и не вылезет ли кнопка за её пределы. Обе — про границы колонки
 * текста, а не про экран.
 *
 * ─── Почему сверху, а не снизу ────────────────────────────────────────────────
 *
 * Под выделением — следующий абзац, то есть текст, который человек читает
 * дальше. Кнопка под ним закрыла бы строчку, к которой он собирался вернуться.
 * Сверху места почти всегда есть: выделение может начинаться с первой строки
 * абзаца, и тогда кнопка уезжает в начало главы — оттуда до верха хотя бы
 * отступ абзаца.
 *
 * Если сверху всё же не помещается (самое начало главы без отступа), кнопка
 * встаёт снизу: показать её чуть ниже выделения лучше, чем не показать совсем.
 */
export function placeButton(
  selection: { top: number; bottom: number; left: number; right: number },
  container: { top: number; left: number; right: number; bottom: number },
  button: { width: number; height: number },
  gap = 8,
): { top: number; left: number } {
  // Проверка «помещается ли сверху» — против верха главы, а не против нуля.
  const above = selection.top - button.height - gap;
  const top = above >= container.top ? above : selection.bottom + gap;

  const center = selection.left + (selection.right - selection.left) / 2;
  const half = button.width / 2;
  // Кнопка не вылезает за колонку текста: иначе она нависала бы на полях.
  const left = Math.min(Math.max(center - half, container.left), container.right - button.width);

  return { top, left };
}