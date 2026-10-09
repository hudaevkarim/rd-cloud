import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ChapterView } from '../src/books/ChapterView.js';
import { applyCommentMarkers, clearCommentMarkers } from '../src/books/comment-markers.js';
import type { ChapterBlock, WireComment } from '../src/api/types.js';
import type { BlockKind, XmlText } from '@rd/library/parse';

/**
 * Маркеры комментариев на уровне `ChapterView`.
 *
 * ─── Почему проверяется компонент, а не функция ────────────────────────────────
 *
 * `applyCommentMarkers` уже проверена отдельно, на голом DOM. Здесь важно
 * другое: **порядок**. Маркеры должны лечь на готовый рендер, иначе цитата
 * ищется не в том дереве. Ошибка в порядке не падает — она выглядит как
 * «маркеров нет», и без проверки компонента её не видно: функция в изоляции
 * ни о чём не знает, а компонент отвечает за последовательность.
 *
 * Второе, что здесь проверяется, — что смена главы убирает старые маркеры.
 * Чистка происходит сама через `replaceChildren()`, и именно поэтому важно
 * убедиться, что на экране не остаётся обёрток от прошлой главы: человек
 * перелистывает и видит подчёркивание на месте, где ничего не обсуждалось.
 */

function textNode(text: string): XmlText {
  return { name: '#text', text, attrs: {}, children: [] };
}

function block(index: number, kind: BlockKind, text: string): ChapterBlock {
  return {
    index,
    kind,
    node: { name: kind, attrs: {}, children: [textNode(text)] },
    text,
  };
}

function chapterOf(paragraphs = 2): ChapterBlock[] {
  const blocks: ChapterBlock[] = [block(0, 'h1', 'Глава')];
  for (let i = 1; i <= paragraphs; i += 1) {
    blocks.push(block(i, 'p', `Абзац ${i}. Он достаточно длинный, чтобы строка заняла место в колонке.`));
  }
  return blocks;
}

function comment(over: Partial<WireComment> = {}): WireComment {
  return {
    id: 'c1',
    bookFileKind: 'text',
    text: 'Комментарий',
    anchor: {
      kind: 'text',
      chapterIndex: 0,
      blockIndex: 1,
      start: 0,
      end: 6,
      quote: 'Абзац ',
      prefix: '',
      suffix: '1.',
    },
    anchorType: 'text',
    isSpoiler: false,
    isResolved: false,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    author: { id: 'u1', username: 'boris', displayName: 'Борис', avatar: null },
    reactions: [],
    ...over,
  };
}

describe('ChapterView и маркеры', () => {
  it('кладёт маркеры поверх отрендеренной главы', () => {
    const { container } = render(
      <ChapterView blocks={chapterOf()} comments={[comment()]} chapterIndex={0} />,
    );

    const mark = container.querySelector('mark.rd-comment-marker');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('Абзац ');
    // Маркер лежит внутри блока с номером 1, а не в другом месте текста.
    expect(mark?.closest('[data-block="1"]')).not.toBeNull();
  });

  it('без комментариев остаётся обычная глава', () => {
    const { container } = render(<ChapterView blocks={chapterOf()} comments={[]} chapterIndex={0} />);

    expect(container.querySelector('mark.rd-comment-marker')).toBeNull();
    expect(container.querySelectorAll('[data-block]').length).toBe(3);
  });

  it('смена главы убирает маркеры прошлой главы', () => {
    /*
      Ключевая проверка подэтапа. Соблазн «пометить и не трогать» оставляет
      обёртки от предыдущей главы: `replaceChildren()` их сносит, и если
      когда-нибудь чистка перестанет быть частью рендера, человек увидит
      подчёркивание в чужой главе. Здесь это зафиксировано явно.
    */
    const { container, rerender } = render(
      <ChapterView blocks={chapterOf()} comments={[comment()]} chapterIndex={0} />,
    );
    expect(container.querySelectorAll('mark.rd-comment-marker').length).toBe(1);

    rerender(<ChapterView blocks={chapterOf()} comments={[]} chapterIndex={1} />);

    expect(container.querySelectorAll('mark.rd-comment-marker')).toHaveLength(0);
  });

  it('повторное наложение не накапливает мусор в дереве', () => {
    /*
      `clearCommentMarkers` обязан возвращать блок к исходному виду, иначе
      каждый следующий проход обходит всё более дробное дерево, а цитата
      рано или поздно перестаёт находиться. Проверка на узлы: одного совпадения
      текста мало — текст одинаков и при десяти обёртках подряд.
    */
    const host = document.createElement('div');
    host.innerHTML = '<p data-block="1">слова и ещё</p>';
    document.body.appendChild(host);

    // Якорь на блок 1: он единственный в этой фикстуре.
    const onFirstBlock = comment({
      anchor: {
        kind: 'text',
        chapterIndex: 0,
        blockIndex: 1,
        start: 1,
        end: 5,
        quote: 'лова',
        prefix: 'с',
        suffix: ' и ещё',
      },
    });

    const blockEl = () => host.querySelector('[data-block="1"]') as HTMLElement;
    for (let i = 0; i < 5; i += 1) {
      applyCommentMarkers(host, [onFirstBlock], 0);
      expect(blockEl().querySelectorAll('mark.rd-comment-marker')).toHaveLength(1);
      clearCommentMarkers(host);
      // После снятия обёртки в блоке снова один текстовый узел.
      expect(blockEl().childNodes).toHaveLength(1);
    }

    host.remove();
  });

  it('маркер чужой главы не попадает в текущую', () => {
    /*
      Номер главы в пропсах — единственная защита от тихой ошибки: у глав
      одинаковая нумерация блоков с нуля, и комментарий из пятой главы с
      `blockIndex: 1` иначе подсветил бы первый абзац текущей. Координаты
      сошлись бы, цитата нашлась бы — и человек увидел бы пометку не там.
    */
    const { container } = render(
      <ChapterView
        blocks={chapterOf()}
        comments={[comment({ anchor: { ...(comment().anchor as object), chapterIndex: 5 } })]}
        chapterIndex={0}
      />,
    );

    expect(container.querySelector('mark.rd-comment-marker')).toBeNull();
  });

  it('перерисовка главы пересчитывает маркеры', () => {
    const { container, rerender } = render(
      <ChapterView blocks={chapterOf()} comments={[comment()]} chapterIndex={0} />,
    );
    expect(container.querySelectorAll('mark.rd-comment-marker')).toHaveLength(1);

    /*
      Два комментария появляются после первого наложения. Проверка фиксирует
      то, что обещано в `ChapterView`: пересчёт происходит при смене главы, а
      не по сигналу из сокета. Настоящий пересчёт на лету придёт в 7.4.2.4.
    */
    rerender(
      <ChapterView
        blocks={chapterOf()}
        comments={[
          comment(),
          comment({
            id: 'c2',
            anchor: {
              kind: 'text',
              chapterIndex: 0,
              blockIndex: 2,
              start: 0,
              end: 6,
              quote: 'Абзац ',
              prefix: '',
              suffix: '2.',
            },
          }),
        ]}
        chapterIndex={0}
      />,
    );

    const marks = container.querySelectorAll('mark.rd-comment-marker');
    expect(marks.length).toBe(2);
    // Оба маркера в правильных блоках: первый — в блоке 1, второй — в блоке 2.
    expect(marks[0]?.closest('[data-block="1"]')).not.toBeNull();
    expect(marks[1]?.closest('[data-block="2"]')).not.toBeNull();
  });

  it('текст главы не меняется от наложения маркеров', () => {
    const { container } = render(
      <ChapterView blocks={chapterOf()} comments={[comment()]} chapterIndex={0} />,
    );

    const chapter = container.querySelector('.chapter');
    expect(chapter?.textContent).toBe(
      'ГлаваАбзац 1. Он достаточно длинный, чтобы строка заняла место в колонке.' +
        'Абзац 2. Он достаточно длинный, чтобы строка заняла место в колонке.',
    );
  });

  it('смена комментариев не зовёт onRendered', () => {
    /*
      Главное свойство раздельных эффектов, и оно же защита от прыжка в
      начало главы: `onRendered` страница использует для прокрутки, поэтому
      приход комментария не должен его звать. Иначе любой новый комментарий
      в комнате уводил бы читателя к началу текста — и не только его.

      Проверка на числе вызовов, а не на «был ли вызов»: лишний второй вызов
      с теми же аргументами выглядел бы безобидно, пока не сравнится счётчик.
    */
    let calls = 0;
    const onRendered = (): void => {
      calls += 1;
    };

    /*
      Один и тот же массив блоков на всю проверку.

      Зависимость рендера — `blocks` по ссылке, поэтому `chapterOf()` в
      каждом вызове дал бы новый массив и лишний рендер главы. Тогда проверка
      ловила бы не то: считала бы второй вызов `onRendered` следствием новых
      комментариев, хотя на деле его вызвала новая ссылка на блоки.
    */
    const blocks = chapterOf();

    const { rerender, container } = render(
      <ChapterView blocks={blocks} comments={[]} chapterIndex={0} onRendered={onRendered} />,
    );
    expect(calls).toBe(1);

    rerender(
      <ChapterView blocks={blocks} comments={[comment()]} chapterIndex={0} onRendered={onRendered} />,
    );

    // Маркер появился, и страница об этом не узнала: прокрутка не тронута.
    expect(container.querySelectorAll('mark.rd-comment-marker')).toHaveLength(1);
    expect(calls).toBe(1);

    /*
      Смена главы приходит на странице новым ответом сервера, а значит новым
      массивом блоков — и вот тогда `onRendered` звать обязана, иначе позиция
      не восстановится.

      Один `chapterIndex` без новых блоков рендер не трогает: отдельного ответа
      сервера на него нет, и мерять раскладку заново незачем. Маркеры при этом
      пересчитываются — за них отвечает второй эффект.
    */
    rerender(<ChapterView blocks={blocks} comments={[comment()]} chapterIndex={1} onRendered={onRendered} />);
    expect(calls).toBe(1);
    expect(container.querySelectorAll('mark.rd-comment-marker')).toHaveLength(0);

    rerender(<ChapterView blocks={chapterOf(3)} comments={[]} chapterIndex={1} onRendered={onRendered} />);
    expect(calls).toBe(2);
  });
});