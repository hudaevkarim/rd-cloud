import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as React from 'react';

/**
 * Страж единственности React.
 *
 * ─── Что ломалось ────────────────────────────────────────────────────────────
 *
 * `react` в монорепозитории появлялся дважды: 18-й у клиента и 19-й, который
 * притаскивал `prisma → @prisma/studio-core → @radix-ui/*`. npm поднимал
 * `react-router` в корень рядом с React 19, и роутер подхватывал именно его:
 *
 *   at Object.useRef    node_modules/react/cjs/react.development.js       ← 19
 *   at MemoryRouter     node_modules/react-router/lib/components.tsx
 *   at renderWithHooks  packages/web/node_modules/react-dom/…             ← 18
 *
 * Клиент и тесты падали с `Cannot read properties of null (reading 'useRef')`
 * и `Invalid hook call`, страница оставалась пустой, а стек указывал на
 * `react-router` — то есть не туда, где причина.
 *
 * Обойти это алиасами не вышло: vitest выносит `node_modules` во внешнюю среду
 * и грузит `react-router` через Node мимо резолвера Vite, так что алиас на
 * `react` не действовал. Решено версией — `react` и `react-dom` 18.3.1
 * закреплены в корне, и копия осталась одна.
 *
 * ─── Почему это тест, а не комментарий ───────────────────────────────────────
 *
 * Вторая копия появится снова: `prisma` обновится и принесёт React 19, или
 * добавится пакет с другой версией. Комментарий никто не прочитает, а этот
 * тест упадёт на первом же прогоне.
 */

/**
 * Корень репозитория — из `define` в `vitest.config.ts`.
 *
 * Вычислять его здесь нельзя: в воркере vitest пути с кириллицей
 * декодируются неверно, и любой `existsSync` по вычисленному пути вернёт `false`
 * молча. Подробности — в комментарии к `define`.
 */
const ROOT = __REPO_ROOT__;

function versionOf(packageDir: string): string {
  const file = `${ROOT}node_modules/${packageDir}/package.json`;
  if (!existsSync(file)) throw new Error(`Нет пакета ${packageDir}`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version;
}

describe('единственность React', () => {
  it('загружен React 18', () => {
    expect(React.version).toBe('18.3.1');
  });

  it('версии react и react-dom совпадают', () => {
    // Расхождение версий даёт «invalid hook call» без всякого стека на
    // `react-router`, и найти его можно только здесь.
    expect(versionOf('react-dom')).toBe(versionOf('react'));
  });

  it('в пакетах нет вложенных копий', () => {
    // Проверяются именно `packages/*`: npm ставит вложенную копию, когда
    // версия конфликтует с корневой. Копия в `tools/node` — это отдельный
    // portable-Node со своими зависимостями, он к проекту отношения не имеет.
    const nested: string[] = [];

    for (const pkg of ['library', 'shared', 'server', 'web']) {
      for (const reactPkg of ['react', 'react-dom']) {
        if (existsSync(`${ROOT}packages/${pkg}/node_modules/${reactPkg}/package.json`)) {
          nested.push(`packages/${pkg}/node_modules/${reactPkg}`);
        }
      }
    }

    expect(nested).toEqual([]);
  });

  it('роутер лежит рядом с тем же React', () => {
    // Отдельная проверка того же самого: если `react-router` снова окажется
    // в другом месте, он подхватит чужую копию — и страж молча пройдёт,
    // пока существует корневой react.
    const routerDir = `${ROOT}node_modules/react-router`;
    expect(existsSync(`${routerDir}/package.json`)).toBe(true);

    // react-router не объявляет react зависимостью: у него `peerDependencies`,
    // и npm может положить его куда угодно. Проверяем, что он физически в
    // корне, рядом с react 18.
    expect(existsSync(`${ROOT}node_modules/react/package.json`)).toBe(true);
  });
});
