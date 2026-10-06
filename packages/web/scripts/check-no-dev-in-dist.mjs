import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Проверка: в сборке клиента нет витрины компонентов.
 *
 * ─── Зачем это скрипт, а не разовая команда ───────────────────────────────────
 *
 * Условие `import.meta.env.DEV` в `App.tsx` вырезает витрину правильно, но
 * правильность такого вырезания нельзя увидеть глазами и нельзя доказать
 * комментарием. Один перенос импорта обратно в статический — и витрина молча
 * вернётся в продакшен вместе со своим CSS, ничего не сломав: страница просто
 * окажется доступна по адресу, который никто не собирался публиковать.
 *
 * Поэтому проверка живёт отдельно и падает сама. В CI она идёт сразу после
 * сборки клиента: порядок важен, искать нечего и не в чем — сборки ещё нет.
 *
 * ─── Что именно ищется ───────────────────────────────────────────────────────
 *
 * Не только код витрины. Ищутся:
 *
 *   1. Строка маршрута `/dev/components` и текст заголовка в **исполняемом**
 *      коде: они означают, что маршрут собран.
 *   2. Классы витрины в CSS: они означают, что её стили собраны. Код мог быть
 *      вырезан, а CSS — нет, если импорт стоял в точке входа (так и было).
 *   3. Имена файлов витрины в списке источников sourcemap: они означают, что
 *      модуль попал в граф сборки.
 *
 * Про исходный текст в sourcemap. Он там есть — это исходники `App.tsx` и
 * `main.tsx`, где витрина упоминается в комментарии и в строке маршрута. Это
 * не утечка кода витрины, а обычный исходник обычного файла приложения,
 * поэтому `sourcesContent` целиком не проверяется: проверка ругалась бы на
 * собственное объяснение в комментарии.
 */

/** Каталог сборки относительно корня пакета. */
const DIST = 'dist';

/**
 * Маркеры, которые не должны встречаться в исполняемом коде.
 *
 * Строка маршрута выбрана первой не случайно: это самая короткая и самая
 * точная проверка. Если маршрут собран, витрина в бандле — и наоборот: если
 * витрины нет, маршрута собрать не из чего.
 */
const CODE_MARKERS = [
  { label: 'маршрут витрины', needle: '/dev/components' },
  { label: 'класс витрины', needle: 'showcase__group' },
  { label: 'токены витрины', needle: 'typo__facts' },
  { label: 'заголовок витрины', needle: 'Витрина компонентов' },
];

/** Маркеры, которые не должны встречаться в собранном CSS. */
const CSS_MARKERS = [
  { label: 'классы витрины', needle: 'showcase' },
  { label: 'подписи типографики', needle: 'typo__facts' },
];

/**
 * Имена исходников витрины.
 *
 * Проверяются в `sources` карты, а не в тексте: текст содержит исходники
 * других файлов приложения, где витрина упомянута в комментарии, и проверка
 * по тексту ругалась бы впустую.
 */
const SOURCE_MARKERS = ['dev/Showcase', 'showcase.css'];

/** Все файлы каталога, рекурсивно. */
function filesIn(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesIn(full));
    else out.push(full);
  }
  return out;
}

const problems = [];
const dist = join(process.cwd(), DIST);

let files;
try {
  files = filesIn(dist);
} catch {
  console.error(`НЕТ ${DIST}: сборка клиента не выполнена. Скрипт идёт после неё.`);
  process.exit(1);
}

for (const file of files) {
  const name = relative(dist, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');

  // `.map` разбираем отдельно: у него есть `sources`, и по нему видно, что в
  // граф сборки попал модуль, даже если его текст не выжил в маппинге.
  if (name.endsWith('.map')) {
    let map;
    try {
      map = JSON.parse(text);
    } catch {
      problems.push(`${name}: не читается как JSON`);
      continue;
    }
    for (const marker of SOURCE_MARKERS) {
      const hit = (map.sources ?? []).filter((s) => s.includes(marker));
      if (hit.length > 0) {
        problems.push(`${name}: в источниках есть ${marker} → ${hit.join(', ')}`);
      }
    }
    continue;
  }

  if (name.endsWith('.css')) {
    for (const marker of CSS_MARKERS) {
      if (text.includes(marker.needle)) {
        problems.push(`${name}: найдено «${marker.label}» (${marker.needle})`);
      }
    }
    continue;
  }

  if (name.endsWith('.js') || name.endsWith('.html')) {
    for (const marker of CODE_MARKERS) {
      if (text.includes(marker.needle)) {
        problems.push(`${name}: найдено «${marker.label}» (${marker.needle})`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('В сборке осталась витрина компонентов:');
  for (const line of problems) console.error(`  ${line}`);
  console.error('\nПричина, скорее всего, в статическом импорте витрины или её стилей.');
  process.exit(1);
}

console.log(`витрины в ${DIST} нет (проверено файлов: ${files.length})`);