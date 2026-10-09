import { describe, expect, it, afterEach } from 'vitest';
import { renderChapter } from '@rd/library/render';
import { anchorFromSelection, placeButton } from '../src/books/selection.js';
import type { XmlNode } from '@rd/library/parse';

/**
 * Якорь из выделения мышью.
 *
 * ─── Что здесь ломается тихо ──────────────────────────────────────────────────
 *
 * Ошибка в смещении не падает: якорь уходит на сервер, принимается, и маркер
 * ложится на другое место. Человек видит подчёркивание не там, где выделил, и
 * не понимает почему. Поэтому проверяется точное равенство всех полей, а не
 * «якорь построился».
 */

interface Fixture {
  host: HTMLElement;
  blocks: HTMLElement[];
}

afterEach(() => {
  document.body.replaceChildren();
});

/**
 * Глава из настоящих блоков.
 *
 * `renderChapter` вместо `innerHTML` — тем же кодом, что и в читалке. Разметка
 * из строки тестировала бы не тот DOM, в котором якорь считается по-настоящему:
 * инлайновые элементы внутри абзаца ломают счёт текстовых узлов.
 */
function chapter(texts: string[]): Fixture {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const blocks = texts.map((text, index) => {
    const node: XmlNode = { name: 'p', attrs: {}, children: [{ name: '#text', text, attrs: {}, children: [] }] };
    return { index, kind: 'p' as const, node, text };
  });

  host.appendChild(renderChapter({ blocks }));
  const elements = Array.from(host.querySelectorAll<HTMLElement>('[data-block]'));
  return { host, blocks: elements };
}

/**
 * Выделяет диапазон внутри одного элемента.
 *
 * Границы ставятся по узлам и смещениям, а не по строкам: так же работает
 * браузер, и только так проверка совпадает с тем, что человек получит мышью.
 */
function select(host: HTMLElement, from: number, to: number, blockEl: HTMLElement): Selection {
  const textNode = blockEl.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, from);
  range.setEnd(textNode, to);

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  void host;
  return selection;
}

describe('якорь из выделения', () => {
  it('берёт цитату и смещения из текста блока', () => {
    const { host, blocks } = chapter(['ветер ветер письмо улица дорога']);
    const selection = select(host, 0, 5, blocks[0]!);

    const picked = anchorFromSelection(host, 3, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor).toEqual({
      kind: 'text',
      chapterIndex: 3,
      blockIndex: 0,
      start: 0,
      end: 5,
      quote: 'ветер',
      prefix: '',
      suffix: ' ветер письмо улица дорога',
    });
  });

  it('начало и середина блока дают верный контекст', () => {
    const text = 'я'.repeat(100);
    const { host, blocks } = chapter([text]);
    const selection = select(host, 40, 45, blocks[0]!);

    const picked = anchorFromSelection(host, 0, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor.start).toBe(40);
    expect(picked.anchor.end).toBe(45);
    expect(picked.anchor.quote).toBe('яяяяя');
    // Контекст ровно 32 символа — столько же, сколько использует библиотека.
    expect(picked.anchor.prefix).toHaveLength(32);
    expect(picked.anchor.suffix).toHaveLength(32);
  });

  it('выделение в самом конце блока', () => {
    const { host, blocks } = chapter(['короткий текст']);
    const selection = select(host, 9, 14, blocks[0]!);

    const picked = anchorFromSelection(host, 0, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor.quote).toBe('текст');
    expect(picked.anchor.end).toBe(14);
    // За концом блока ничего нет: контекст обрезается, а не дополняется.
    expect(picked.anchor.suffix).toBe('');
  });

  it('кириллица считается по символам, а не по байтам', () => {
    const { host, blocks } = chapter(['ёжик и шишка']);
    const selection = select(host, 0, 4, blocks[0]!);

    const picked = anchorFromSelection(host, 0, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor.quote).toBe('ёжик');
    expect(picked.anchor.end).toBe(4);
  });

  it('эмодзи занимают два кодовых юнита и не ломают смещения', () => {
    const { host, blocks } = chapter(['привет 👋 другу']);
    const selection = select(host, 7, 9, blocks[0]!);

    const picked = anchorFromSelection(host, 0, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor.quote).toBe('👋');
    // Смещение в кодах, а не в «символах»: сервер режет текст так же.
    expect(picked.anchor.start).toBe(7);
    expect(picked.anchor.end).toBe(9);
  });

  it('выделение через инлайновый элемент', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const el = document.createElement('p');
    el.setAttribute('data-block', '0');
    el.innerHTML = 'начало <em>середина</em> конец';
    host.appendChild(el);

    const em = el.querySelector('em')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(em, 0);
    range.setEnd(em, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const picked = anchorFromSelection(host, 0, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor.quote).toBe('середина');
    // «начало » — семь символов, поэтому `em` начинается с седьмого, а не с
    // восьмого: смещение считается от начала блока.
    expect(picked.anchor.start).toBe(7);
    expect(picked.anchor.end).toBe(15);
  });

  it('выделение из второго блока', () => {
    const { host, blocks } = chapter(['первый абзац', 'второй абзац']);
    const selection = select(host, 0, 5, blocks[1]!);

    const picked = anchorFromSelection(host, 2, selection);

    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.anchor.blockIndex).toBe(1);
    expect(picked.anchor.chapterIndex).toBe(2);
  });

  it('пустое выделение отвергается', () => {
    const { host, blocks } = chapter(['текст']);
    const selection = select(host, 3, 3, blocks[0]!);

    expect(anchorFromSelection(host, 0, selection)).toEqual({ ok: false, refusal: 'empty' });
  });

  it('выделение из одних пробелов отвергается', () => {
    const { host, blocks } = chapter(['а   б']);
    const selection = select(host, 1, 4, blocks[0]!);

    // Такой якорь сервер всё равно отверг бы как «пустая цитата».
    expect(anchorFromSelection(host, 0, selection)).toEqual({ ok: false, refusal: 'empty' });
  });

  it('выделение вне главы отвергается', () => {
    const outside = document.createElement('p');
    outside.textContent = 'не наша глава';
    document.body.appendChild(outside);

    const { host } = chapter(['наша глава']);
    const range = document.createRange();
    range.setStart(outside.firstChild!, 0);
    range.setEnd(outside.firstChild!, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(anchorFromSelection(host, 0, selection)).toEqual({ ok: false, refusal: 'outside' });
  });

  it('отсутствие выделения', () => {
    const { host } = chapter(['глава']);

    expect(anchorFromSelection(host, 0, null)).toEqual({ ok: false, refusal: 'empty' });
    expect(anchorFromSelection(host, 0, window.getSelection())).toEqual({ ok: false, refusal: 'empty' });
  });
});

describe('позиция кнопки над выделением', () => {
  /*
    Глава начинается не в нуле окна: на широком экране колонка текста сдвинута
    к центру. Раньше расчёт вычитал смещение главы и возвращал координату
    внутри неё, а `position: fixed` ждал координату окна — кнопка уезжала в
    левый верхний угол. Числа ниже взяты из живой проверки: глава от 352px,
    выделение от 382px.
  */
  const container = { top: 176, left: 352, right: 837, bottom: 1200 };
  const button = { width: 143, height: 32 };

  it('встаёт над выделением в координатах окна', () => {
    const spot = placeButton({ top: 232, bottom: 257, left: 382, right: 440 }, container, button);

    // 232 − 32 − 8 = 192. Вычитается только высота кнопки: координата окна.
    expect(spot.top).toBe(192);
  });

  it('центрируется по выделению', () => {
    const spot = placeButton({ top: 232, bottom: 257, left: 500, right: 560 }, container, button);

    // Центр выделения 530, половина кнопки 71.5 → 458.5.
    expect(spot.left).toBeCloseTo(458.5, 1);
  });

  it('у самого левого края главы кнопка не уезжает на поле', () => {
    const spot = placeButton({ top: 232, bottom: 257, left: 382, right: 440 }, container, button);

    /*
      По центру выделения кнопка встала бы на 339.5 — это 12 пикселей левее
      главы, то есть на поле. Кламп прижимает её к началу колонки: лучше кнопка
      с края, чем висящая в поле.
    */
    expect(spot.left).toBe(352);
  });

  it('кнопка остаётся внутри колонки текста', () => {
    const spot = placeButton({ top: 300, bottom: 320, left: 352, right: 360 }, container, button);

    // Выделение начинается на левом краю главы: кнопка прижата к нему же.
    expect(spot.left).toBe(352);
  });

  it('у правого края главы не вылезает за него', () => {
    const spot = placeButton({ top: 300, bottom: 320, left: 820, right: 837 }, container, button);

    expect(spot.left).toBe(837 - 143);
  });

  it('у самого верха главы встаёт снизу, а не пропадает', () => {
    // Выделение в строке 180: сверху 180 − 32 − 8 = 140, это выше верха главы.
    const spot = placeButton({ top: 180, bottom: 200, left: 382, right: 440 }, container, button);

    expect(spot.top).toBe(208);
  });

  it('кнопка не залезает на строку над выделением', () => {
    const spot = placeButton({ top: 300, bottom: 320, left: 500, right: 560 }, container, button);

    expect(spot.top + button.height).toBeLessThanOrEqual(300);
  });
});