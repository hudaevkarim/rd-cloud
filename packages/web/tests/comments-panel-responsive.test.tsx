import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Раскладка панели комментариев.
 *
 * ─── Почему статический разбор CSS, а не проверка в браузере ──────────────────
 *
 * Три колонки, планшет и выдвижная панель на телефоне — это три медиазапроса и
 * несколько правил. Проверять их скриншотами значило бы ловить то, что видно,
 * и не ловить то, что сломано: переименование класса в разметке оставило бы
 * зелёную картинку с панелью в углу.
 *
 * Разбор файла проверяет то, что действительно ломается: правило удалили,
 * ширину сменили, медиазапрос переписали. Тот же приём, что в `narrow.test.ts`.
 */

/*
  Корень репозитория берётся из `__REPO_ROOT__`, а не вычисляется из
  `import.meta.url`: внутри воркера vitest кириллица в пути декодируется неверно
  и файл читается не тот — ошибки не будет, будет «правило не найдено». Причина
  описана в `vitest.config.ts`.
*/
const ROOT = __REPO_ROOT__;
const css = readFileSync(`${ROOT}packages/web/src/styles/reader.css`, 'utf8');
const readerSource = readFileSync(`${ROOT}packages/web/src/pages/Reader.tsx`, 'utf8');

/** Границы раздела «Панель комментариев» в CSS. */
function panelSection(): string {
  const from = css.indexOf('Панель комментариев');
  const to = css.indexOf('Переход между главами', from);
  if (from < 0 || to < 0) throw new Error('раздел панели комментариев не найден в CSS');
  return css.slice(from, to);
}

/**
 * Текст правила по селектору: от открывающей скобки до закрывающей.
 *
 * По регулярке, а не склейкой строки: селекторы бывают составными
 * (`.reader--bare .comments, .reader--bare .reader__comments-toggle {`), и жёсткая
 * склейка искала бы не то и падала с «правило не найдено» на верном файле.
 * Между селектором и скобкой допускается всё, кроме самой скобки, — так
 * находится и список селекторов.
 */
function ruleBody(selector: string, from = 0): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}[^{]*\\{`).exec(css.slice(from));
  if (match === null || match.index === undefined) {
    throw new Error(`правило «${selector}» не найдено`);
  }
  const start = from + match.index;
  return css.slice(start, css.indexOf('}', start));
}

const ruleFor = (selector: string): string => ruleBody(selector);

describe('панель комментариев: раскладка', () => {
  it('на десктопе это третья колонка шириной 320px', () => {
    const rule = ruleFor('.comments');

    expect(rule).toContain('width: 320px');
    // `flex: none` обязателен: иначе `flex: 1` у текста отдаст панели остаток,
    // и колонка набора поедет в момент появления панели.
    expect(rule).toContain('flex: none');
    expect(rule).toContain('border-left: 1px solid var(--rule)');
  });

  it('панель вставлена в ту же строку, что и текст', () => {
    /*
      Отдельная проверка на структуру: панель обязана быть внутри `.reader__body`,
      а не рядом с ним. Рядом с ним её ширина не вошла бы в ту же строку, и текст
      не сдвинулся бы — панель просто налезала бы поверх.
    */
    const bodyOpen = readerSource.indexOf('<div className="reader__body">');
    expect(bodyOpen).toBeGreaterThan(-1);
    const panel = readerSource.indexOf('<CommentsPanel');
    expect(panel).toBeGreaterThan(bodyOpen);
  });

  it('список панели прокручивается сам', () => {
    const rule = ruleFor('.comments__list');

    expect(rule).toContain('overflow-y: auto');
    // `min-height: 0` обязателен внутри flex-колонки: иначе блок не сожмётся и
    // страница поедет вертикально вместо прокрутки панели.
    expect(rule).toContain('min-height: 0');
  });

  it('свёрнутая панель убирается целиком', () => {
    /*
      `display: none`, а не ширина в ноль: нулевая колонка оставила бы рамку в
      один пиксель и вертикальный столбик между оглавлением и текстом — человек
      видел бы «здесь что-то есть» и не понял бы, что именно.
    */
    expect(ruleFor('.comments:not(.is-open)')).toContain('display: none');
  });

  it('на планшете панель сужается до 280px', () => {
    const at = css.indexOf('@media (min-width: 768px) and (max-width: 1023px)');
    expect(at).toBeGreaterThan(-1);
    expect(ruleBody('.comments', at)).toContain('width: 280px');
  });

  it('на телефоне панель выезжает справа тем же приёмом, что оглавление', () => {
    const at = css.indexOf('@media (max-width: 767px)');
    expect(at).toBeGreaterThan(-1);

    const rule = ruleBody('.comments', at);
    // Лист снизу сознательно не выбран: он потребовал бы жеста перетаскивания,
    // подложки и второго правила закрытия ради списка, который помещается в эту
    // же форму. Проверка фиксирует приём, а не вкус.
    expect(rule).toContain('position: absolute');
    expect(rule).toContain('translateX(110%)');
    expect(rule).toContain('min(320px, 86vw)');
    expect(ruleBody('.comments.is-open', at)).toContain('translateX(0)');
  });

  it('на телефоне у панели своя рамка вместо разделителя колонки', () => {
    const at = css.indexOf('@media (max-width: 767px)');
    expect(ruleBody('.comments', at)).toContain('border: 1px solid var(--ink)');
  });

  it('переключатель в шапке есть и в разметке, и в стилях', () => {
    const rule = ruleFor('.reader__comments-toggle');
    expect(rule).toContain('min-height: var(--touch)');
    expect(rule).toContain('border: 1px solid var(--rule)');
    expect(readerSource).toContain('className="reader__comments-toggle"');
  });

  it('в режиме «скрыть виджеты» панель убирается вместе с оглавлением', () => {
    expect(ruleFor('.reader--bare .comments')).toContain('display: none');
    expect(ruleFor('.reader--bare .reader__comments-toggle')).toContain('display: none');
  });
});

describe('правила проекта в панели', () => {
  it('нет скруглений, кроме круга аватара', () => {
    /*
      Круг у аватара — исключение, а не правило: это буква в круге, а не кнопка.
      Любое другое `border-radius` означало бы, что в панели появилась привычная
      форма, которой в дизайн-системе нет.
    */
    const radii = [...panelSection().matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(new Set(radii)).toEqual(new Set(['50%']));
  });

  it('нет теней', () => {
    expect(panelSection()).not.toContain('box-shadow');
  });

  it('анимации не двигают и не масштабируют', () => {
    for (const block of [...panelSection().matchAll(/@keyframes\s+\w+\s*\{[\s\S]*?\n\}/g)]) {
      expect(block[0]).not.toMatch(/translate|left:|top:|scale|margin|padding/);
    }
  });

  it('длительности — переход токена, кроме намеренной подсветки', () => {
    /*
      Подсветка — секунда, и это исключение, о котором сказано в коде: короче
      человек не успевает заметить, куда его увели, дольше подсветка выглядит
      как постоянное выделение. Всё остальное — переходы токена.
    */
    const durations = [
      ...[...panelSection().matchAll(/([\d.]+)ms/g)].map((m) => Number(m[1])),
      // Секунды приведены к миллисекундам: `1s` и `1000ms` — одна длительность,
      // и проверка не должна зависеть от того, какой формой она записана.
      ...[...panelSection().matchAll(/([\d.]+)s\b/g)].map((m) => Number(m[1]) * 1_000),
    ];
    expect(durations.filter((d) => d > 200)).toEqual([1_000, 1_000]);
  });

  it('отступ вложенности — рамка слева, а не отступ рамкой', () => {
    const rule = ruleFor('.comment__replies');
    expect(rule).toContain('padding-left');
    expect(rule).toContain('border-left: 1px solid var(--rule)');
  });

  it('текст комментария обычный, без акцента', () => {
    expect(ruleFor('.comment__text')).not.toContain('var(--accent)');
  });
});