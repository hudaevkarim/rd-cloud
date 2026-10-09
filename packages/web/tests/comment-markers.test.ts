import { describe, expect, it } from 'vitest';
import { applyCommentMarkers, clearCommentMarkers } from '../src/books/comment-markers.js';
import type { WireComment } from '../src/api/types.js';

/**
 * Маркеры комментариев в тексте.
 *
 * ─── Что здесь проверяется и почему ─────────────────────────────────────────
 *
 * Маркер — единственное место, где встречаются координаты якоря и живой DOM.
 * Ошибка здесь не падает и не пишет в консоль: комментарий просто остаётся
 * неподсвеченным, и человек видит его в списке, но не понимает, к какому месту
 * он относится. Поэтому проверяются именно границы: что обёрнуто ровно то, что
 * выделил человек, и ничего лишнего.
 */

function hostOf(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function comment(over: Partial<WireComment> = {}): WireComment {
  return {
    id: 'c1',
    bookFileKind: 'text',
    text: 'Комментарий',
    anchor: {
      kind: 'text',
      chapterIndex: 0,
      blockIndex: 0,
      start: 1,
      end: 5,
      quote: 'лова',
      prefix: 'с',
      suffix: ' и ещё',
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

describe('маркеры комментариев', () => {
  it('оборачивает цитату в mark', () => {
    const host = hostOf('<p data-block="0">слова и ещё</p>');

    applyCommentMarkers(host, [comment()], 0);

    const mark = host.querySelector('mark.rd-comment-marker');
    expect(mark?.textContent).toBe('лова');
    // Текст блока не изменился: обёртка добавляет разметку, а не текст.
    expect(host.querySelector('[data-block="0"]')?.textContent).toBe('слова и ещё');
  });

  it('не трогает текст вне цитаты', () => {
    const host = hostOf('<p data-block="0">слова и ещё</p>');

    applyCommentMarkers(host, [comment()], 0);

    const block = host.querySelector('[data-block="0"]') as HTMLElement;
    // До и после цитаты текст остался тем же.
    expect(block.childNodes[0]?.textContent).toBe('с');
    expect(block.childNodes[2]?.textContent).toBe(' и ещё');
  });

  it('цитата через инлайновый тег оборачивается целиком', () => {
    const host = hostOf('<p data-block="0">с<em>лова</em> и ещё</p>');

    applyCommentMarkers(host, [comment()], 0);

    const mark = host.querySelector('mark.rd-comment-marker');
    expect(mark?.textContent).toBe('лова');
    // Текст блока по-прежнему тот же: обёртка не переписывает содержимое.
    expect(host.querySelector('[data-block="0"]')?.textContent).toBe('слова и ещё');
  });

  it('цитата на границе двух текстовых узлов оборачивается целиком', () => {
    // «слова » — 6 символов, «и ещё» начинается с позиции 6.
    const host = hostOf('<p data-block="0">слова <strong>и ещё</strong></p>');

    applyCommentMarkers(host, [comment({ anchor: {
      kind: 'text', chapterIndex: 0, blockIndex: 0,
      start: 6, end: 11, quote: 'и ещё', prefix: 'слова ', suffix: '',
    } })], 0);

    const mark = host.querySelector('mark.rd-comment-marker');
    expect(mark?.textContent).toBe('и ещё');
  });

  it('два комментария в одном блоке не мешают друг другу', () => {
    const host = hostOf('<p data-block="0">слова и ещё</p>');

    applyCommentMarkers(host, [
      comment(),
      comment({
        id: 'c2',
        anchor: {
          kind: 'text', chapterIndex: 0, blockIndex: 0,
          start: 0, end: 1, quote: 'с', prefix: '', suffix: 'лово',
        },
      }),
    ], 0);

    const marks = host.querySelectorAll('mark.rd-comment-marker');
    expect(marks).toHaveLength(2);
    // Текст блока не изменился, несмотря на две обёртки.
    expect(host.querySelector('[data-block="0"]')?.textContent).toBe('слова и ещё');
  });

  it('координаты от другой сборки книги: цитата ищется заново', () => {
    // Автор комментария выделял «лова» в блоке 0, а в этой сборке текст другой.
    const host = hostOf('<p data-block="0">совсем другой текст</p>');

    applyCommentMarkers(host, [comment()], 0);

    /*
      Координаты 4..8 в этом тексте дают «сем», а не «лова», поэтому якорь
      пересчитывается по цитате. Цитаты в тексте нет — маркера нет, и это
      правильно: выделять «сем» значило бы подсветить не то место.
    */
    expect(host.querySelector('mark.rd-comment-marker')).toBeNull();
  });

  it('цитата находится в том же блоке по тексту', () => {
    // Координаты указывают не туда, но цитата в блоке есть.
    const host = hostOf('<p data-block="0">текст про лова и дальше</p>');

    applyCommentMarkers(host, [comment()], 0);

    const mark = host.querySelector('mark.rd-comment-marker');
    expect(mark?.textContent).toBe('лова');
  });

  it('комментарий другой главы не получает маркера', () => {
    const host = hostOf('<p data-block="0">слова и ещё</p>');

    applyCommentMarkers(host, [comment({ anchor: {
      kind: 'text', chapterIndex: 5, blockIndex: 0,
      start: 4, end: 8, quote: 'лова', prefix: 'с', suffix: ' и',
    } })], 0);

    expect(host.querySelector('mark.rd-comment-marker')).toBeNull();
  });

  it('не-текстовой якорь пропускается', () => {
    const host = hostOf('<p data-block="0">слова и ещё</p>');

    applyCommentMarkers(host, [comment({ anchorType: 'timestamp' })], 0);

    expect(host.querySelector('mark.rd-comment-marker')).toBeNull();
  });

  it('clearCommentMarkers убирает обёртки и возвращает текст', () => {
    const host = hostOf('<p data-block="0">слова и ещё</p>');

    applyCommentMarkers(host, [comment()], 0);
    expect(host.querySelector('mark.rd-comment-marker')).not.toBeNull();

    clearCommentMarkers(host);

    expect(host.querySelector('mark.rd-comment-marker')).toBeNull();
    // Текст вернулся к исходному: обёртка не должна ничего оставлять после себя.
    expect(host.querySelector('[data-block="0"]')?.textContent).toBe('слова и ещё');
    expect(host.querySelector('[data-block="0"]')?.childNodes).toHaveLength(1);
  });

  it('пустой список комментариев ничего не ломает', () => {
    const host = hostOf('<p data-block="0">слова и ещё</p>');

    applyCommentMarkers(host, [], 0);

    expect(host.querySelector('mark.rd-comment-marker')).toBeNull();
    expect(host.querySelector('[data-block="0"]')?.textContent).toBe('слова и ещё');
  });
});
