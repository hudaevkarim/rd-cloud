import { describe, expect, it, afterEach } from 'vitest';
import { renderChapter } from '@rd/library/render';
import { anchorFromSelection } from '../src/books/selection.js';
import type { XmlNode } from '@rd/library/parse';

/**
 * Выделение через границу абзацев.
 *
 * ─── Почему это отдельный файл ────────────────────────────────────────────────
 *
 * Якорь описывает одно место: `chapterIndex`, `blockIndex`, `start`, `end`.
 * Формы «от такого блока до такого» у него нет, и `validateAnchor` такой якорь
 * отверг бы. Значит клиент обязан отказать раньше сервера — иначе человек
 * выделит полфразы через два абзаца, потратит текст комментария и получит
 * ошибку в самом конце.
 *
 * Отдельный файл, потому что это не частный случай вычисления якоря, а
 * запрет на само выделение: его легко случайно «починить», разрешив брать
 * первый блок, и никто этого не заметит — подсветка просто съехала бы.
 */

afterEach(() => {
  document.body.replaceChildren();
});

function chapter(texts: string[]): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const blocks = texts.map((text, index) => {
    const node: XmlNode = { name: 'p', attrs: {}, children: [{ name: '#text', text, attrs: {}, children: [] }] };
    return { index, kind: 'p' as const, node, text };
  });
  host.appendChild(renderChapter({ blocks }));
  return host;
}

/** Выделяет от `from` в первом блоке до `to` во втором. */
function selectAcross(host: HTMLElement, from: number, to: number): Selection {
  const els = host.querySelectorAll<HTMLElement>('[data-block]');
  const first = els[0]!.firstChild as Text;
  const second = els[1]!.firstChild as Text;

  const range = document.createRange();
  range.setStart(first, from);
  range.setEnd(second, to);

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe('выделение через два блока', () => {
  it('не строит якорь', () => {
    const host = chapter(['первый абзац целиком', 'второй абзац целиком']);

    const picked = anchorFromSelection(host, 0, selectAcross(host, 6, 6));

    expect(picked).toEqual({ ok: false, refusal: 'across-blocks' });
  });

  it('отказ не зависит от того, где начало выделения', () => {
    const host = chapter(['раз', 'два']);

    // Начало в самом начале первого блока, конец — в середине второго.
    expect(anchorFromSelection(host, 0, selectAcross(host, 0, 2))).toEqual({
      ok: false,
      refusal: 'across-blocks',
    });
  });

  it('выделение на границе, где во втором блоке ничего не взято, проходит', () => {
    const host = chapter(['первый абзац', 'второй абзац']);

    /*
      Граница между абзацами принадлежит первому: выделение заканчивается ровно
      на его последнем символе. Это обычное выделение одного абзаца до конца,
      и отказывать здесь было бы ошибкой — человек рассчитывал на комментарий
      ко всей фразе.
    */
    const els = host.querySelectorAll<HTMLElement>('[data-block]');
    const range = document.createRange();
    range.setStart(els[0]!.firstChild as Text, 0);
    range.setEnd(els[0]!.firstChild as Text, 12);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const picked = anchorFromSelection(host, 0, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor.blockIndex).toBe(0);
    expect(picked.anchor.quote).toBe('первый абзац');
  });

  it('выделение через три блока — тоже отказ', () => {
    const host = chapter(['раз', 'два', 'три']);

    const els = host.querySelectorAll<HTMLElement>('[data-block]');
    const range = document.createRange();
    range.setStart(els[0]!.firstChild as Text, 0);
    range.setEnd(els[2]!.firstChild as Text, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(anchorFromSelection(host, 0, selection)).toEqual({ ok: false, refusal: 'across-blocks' });
  });

  it('выделение из заголовка в абзац', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML =
      '<h1 data-block="0">Заголовок главы</h1><p data-block="1">Первый абзац</p>';

    const els = host.querySelectorAll<HTMLElement>('[data-block]');
    const range = document.createRange();
    range.setStart(els[0]!.firstChild as Text, 0);
    range.setEnd(els[1]!.firstChild as Text, 6);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(anchorFromSelection(host, 0, selection)).toEqual({ ok: false, refusal: 'across-blocks' });
  });
});