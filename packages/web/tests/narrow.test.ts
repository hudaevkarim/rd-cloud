import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Поведение на узких экранах.
 *
 * ─── Почему читается файл, а не страница ──────────────────────────────────────
 *
 * Окно браузера в проверках держится на 1000px, и переключить ширину на 320px
 * нечем: `window.resizeTo` в обычной вкладке запрещён, а всплывающее окно
 * инструмент всё равно открывает в своём размере. Значит, `@media` в jsdom не
 * применяется вовсе, и проверка «на 320px вкладки стали сегментом» через
 * `getComputedStyle` проверяла бы jsdom, а не страницу.
 *
 * Поэтому здесь проверяется источник истины — сами правила в CSS. Опечатка в
 * селекторе или забытое `flex-wrap` не дали бы ошибки в разметке: страница
 * просто поехала бы на телефоне, и это увидел бы человек с телефоном в руках.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const STYLES = `${ROOT}/packages/web/src/styles`;

/** Текст медиаблока по селектору верхнего уровня. */
function mediaBlock(file: string, query: string): string {
  const css = readFileSync(`${STYLES}/${file}`, 'utf8');
  const start = css.indexOf(query);
  if (start === -1) throw new Error(`В ${file} нет блока ${query}`);

  // Идём до закрывающей скобки блока, считая вложенные.
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error(`Блок ${query} в ${file} не закрыт`);
}

/** Правила одного селектора внутри блока. */
function rule(block: string, selector: string): string {
  const at = block.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`Нет правила «${selector}»`);
  const end = block.indexOf('}', at);
  return block.slice(at, end + 1);
}

describe('узкие экраны', () => {
  it('нижняя навигация появляется, верхняя уходит', () => {
    const block = mediaBlock('layout.css', '@media (max-width: 767px)');

    // Обе навигации на месте одновременно означали бы две полосы: человек увидел
    // бы пункты, ведущие в никуда, — те, что не помещаются, просто обрезались бы.
    expect(rule(block, '.bottomnav')).toContain('display: flex');
    expect(rule(block, '.topbar__nav')).toContain('display: none');
  });

  it('вкладки комнаты — сегментированный контрол с целью для пальца', () => {
    const css = readFileSync(`${STYLES}/rooms.css`, 'utf8');

    // Контрол делит ширину на три равные части, а не переносится: три вкладки
    // с подписями и счётчиком на 320px в строку не помещаются.
    expect(rule(css, '.tabs')).toContain('grid-template-columns: repeat(3, 1fr)');
    // 44px — минимальная высота цели для пальца, из токена, а не числом:
    // токен меняется в одном месте, число здесь разъехалось бы с ним.
    expect(rule(css, '.tabs__tab')).toContain('min-height: var(--touch)');
  });

  it('минимальная цель нажатия — 44px', () => {
    const tokens = readFileSync(`${STYLES}/tokens.css`, 'utf8');

    // Число, а не ссылка на токен: 44px — это требование, а не оформление, и его
    // нельзя сдвинуть вместе с цветом кнопки.
    expect(tokens).toMatch(/--touch:\s*44px/);
  });

  it('строки участников и заявок переносятся, кнопка занимает строку', () => {
    const block = mediaBlock('rooms.css', '@media (max-width: 767px)');

    /*
      Без переноски имя сжимается до многоточия почти в ноль, а строка нужна как
      раз ради имени: человек видел бы список, где половина участников не
      названа. Кнопка уходит на свою строку и тянется на всю ширину — так же,
      как в заявках.
    */
    for (const selector of ['.memberrow', '.requestrow']) {
      expect(rule(block, selector), `${selector} должен переноситься`).toContain('flex-wrap: wrap');
    }

    // У заявок две кнопки делят строку поровну, у участника кнопка одна и
    // занимает её целиком. Проверяется именно это: «кнопка на своей строке»
    // для заявок означало бы две неодинаковые по ширине кнопки.
    expect(rule(block, '.requestrow__actions')).toContain('width: 100%');
    expect(rule(block, '.requestrow__actions .btn')).toContain('flex: 1');
    expect(rule(block, '.memberrow .btn')).toContain('width: 100%');
  });

  it('результат поиска переворачивается вертикально', () => {
    const block = mediaBlock('rooms.css', '@media (max-width: 767px)');

    // Описание и кнопка в одной строке на 320px не помещаются, и кнопка уезжала
    // бы под обрез — то есть главное действие оказывалось за пределами экрана.
    expect(rule(block, '.hitrow')).toContain('flex-direction: column');
  });

  it('на самых узких экранах поле сужается, а не число пунктов', () => {
    const block = mediaBlock('layout.css', '@media (max-width: 359px)');

    // Подписи в две строки подняли бы навигацию в высоту, и она наехала бы на
    // содержимое. Сужают поле и трекинг, но не число пунктов: без одного из
    // них человек не найдёт нужный раздел.
    expect(block).toContain('--gutter: 12px');
    expect(rule(block, '.bottomnav__tab')).toContain('letter-spacing: 0');
  });

  it('никакой ширины, которая не поместится на 320px', () => {
    // Строка длиннее экрана не сжимается и даёт горизонтальную прокрутку.
    // Меньшие значения — допустимы, они ничего не ломают.
    const offenders: string[] = [];

    for (const file of ['global.css', 'layout.css', 'rooms.css', 'components.css', 'pages.css']) {
      const css = readFileSync(`${STYLES}/${file}`, 'utf8');
      for (const m of css.matchAll(/(^|[;{\s])min-width:\s*(\d+)px/g)) {
        if (Number(m[2]) > 320) offenders.push(`${file}: min-width: ${m[2]}px`);
      }
      for (const m of css.matchAll(/(^|[;{\s])width:\s*(\d+)px/g)) {
        if (Number(m[2]) > 320) offenders.push(`${file}: width: ${m[2]}px`);
      }
    }

    expect(offenders).toEqual([]);
  });
});