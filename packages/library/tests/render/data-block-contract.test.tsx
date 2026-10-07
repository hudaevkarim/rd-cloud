// @vitest-environment jsdom
/**
 * Контракт `data-block`.
 *
 * ─── Почему это отдельный файл, а не ещё одна проверка в fb2-render ──────────
 *
 * `data-block` — это не деталь оформления, а обещание между двумя частями
 * проекта. Рендерер обещает: «у каждого элемента текста есть его номер».
 * Обещание используют по меньшей мере трое: якоря комментариев
 * (`locateSelection`), восстановление позиции чтения и маркеры комментариев
 * в тексте в подэтапе 7.4.2.
 *
 * Если обещание нарушится тихо, поломка обнаружится очень поздно: комментарий
 * окажется привязанным к несуществующему месту, человек увидит его в списке и
 * не поймёт, почему по клику ничего не происходит. Поэтому нарушение должно
 * бросать ошибку в момент рендера.
 *
 * Проверка живёт рядом с рендерером, а не в клиенте: обещание даёт библиотека,
 * и проверять его должен тот же пакет.
 */

import { describe, expect, it } from 'vitest';
import { renderBlock, renderChapter, locateSelection } from '@rd/library/render';
import type { EpubBlock, EpubChapter } from '@rd/library/parse';

function textNode(text: string) {
  return { name: '#text', text, attrs: {}, children: [] };
}

/** Блок главы ровно такой формы, какую пишет разбор. */
function block(index: number, text = 'Абзац'): EpubBlock {
  return {
    index,
    kind: 'p',
    node: { name: 'p', attrs: {}, children: [textNode(text)] },
    text,
  };
}

describe('номер блока', () => {
  it('у каждого блока есть data-block', () => {
    const host = document.createElement('div');
    host.appendChild(renderChapter({ blocks: [block(0), block(1), block(2)] }));

    const nodes = host.querySelectorAll('[data-block]');
    expect(nodes.length).toBe(3);
    // Номера идут подряд и в том же порядке, что и в разборе: по ним якорь
    // пересчитывается обратно в координаты главы.
    expect([...nodes].map((n) => n.getAttribute('data-block'))).toEqual(['0', '1', '2']);
  });

  it('блок без номера роняет рендер, а не получает «undefined»', () => {
    const broken = { ...block(0), index: undefined as unknown as number };

    /*
      Тихий вариант выглядел бы так: `data-block="undefined"`, затем
      `Number("undefined")` → `NaN`, и якорь комментария уезжает в никуда, а
      человек видит комментарий в списке и не понимает, почему он не
      переходит. Падение на границе с сервером видно сразу.
    */
    expect(() => renderBlock(broken)).toThrow(/номер/i);
    expect(() => renderBlock(broken)).toThrow(/undefined/);
  });

  it('дробный и отрицательный номера отвергаются', () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => renderBlock({ ...block(0), index: bad }), String(bad)).toThrow();
    }
  });

  it('проверка идёт и на пустых блоках-разделителях', () => {
    /*
      `hr` рисуется раньше, чем остальные, и при неверном номере он тоже не
      должен проходить молча: иначе проверка на тексте держалась бы, а на
      разделителях — нет.
    */
    const broken: EpubBlock = {
      index: undefined as unknown as number,
      kind: 'hr',
      node: { name: 'hr', attrs: {}, children: [] },
      text: '',
    };
    expect(() => renderBlock(broken)).toThrow();
  });

  it('плохая глава целиком не рисуется наполовину', () => {
    const chapter: EpubChapter = {
      index: 0,
      id: 'c1',
      href: 'ch1.xhtml',
      blocks: [block(0), { ...block(1), index: undefined as unknown as number }, block(2)],
    };

    // Проверка на границе с сервером имеет смысл только если ошибка не даёт
    // нарисовать часть главы: «половина книги плюс ошибка» хуже, чем ошибка.
    expect(() => renderChapter(chapter)).toThrow();
  });
});

describe('номер блока и якоря', () => {
  it('выделение в отрендеренном абзаце даёт номер этого абзаца', () => {
    const host = document.createElement('div');
    host.appendChild(renderChapter({ blocks: [block(0), block(1, 'Второй абзац'), block(2)] }));

    const second = host.querySelector('[data-block="1"]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(second);

    const located = locateSelection(host, range);

    /*
      Здесь номер блока превращается в якорь комментария. Связка «атрибут →
      координаты» и есть контракт: без неё комментарий в 7.4.2 привяжется к
      несуществующему месту.
    */
    expect(located).not.toBeNull();
    expect(located?.blockIndex).toBe(1);
  });

  it('выделение вне прокручиваемого блока не даёт якорь', () => {
    const host = document.createElement('div');
    host.appendChild(renderChapter({ blocks: [block(0)] }));
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    const range = document.createRange();
    range.selectNodeContents(outside);

    // Якорь вне главы — это не «якорь в первом блоке», а отсутствие якоря.
    expect(locateSelection(host, range)).toBeNull();
    outside.remove();
  });
});