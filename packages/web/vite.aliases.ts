import { fileURLToPath } from 'node:url';

/**
 * Алиасы рабочих пакетов.
 *
 * ─── Почему здесь нет алиасов на React ───────────────────────────────────────
 *
 * Изначально они были, и это была ошибка. В монорепозитории `react` есть и у
 * клиента, и у сервера: второй тянул его через
 * `prisma → @prisma/studio-core → @radix-ui/* → react@19`. npm поднимал
 * `react-router` в корень рядом с React 19, и роутер подхватывал **19-ю**,
 * тогда как `react-dom` оставался **18-й**:
 *
 *   at Object.useRef    ../../node_modules/react/cjs/react.development.js   ← 19
 *   at MemoryRouter     ../../node_modules/react-router/lib/components.tsx
 *   at renderWithHooks  node_modules/react-dom/cjs/react-dom.development.js ← 18
 *
 * Клиент падал с `Cannot read properties of null (reading 'useRef')`, а
 * страница оставалась пустой. Варианты и почему они не подошли:
 *
 *   `resolve.dedupe`    сводит пакет в один экземпляр, но выбирает тот, что
 *                       ближе к корню репозитория, то есть 19-й. `react-dom`
 *                       при этом остаётся 18-м, и симптом сохраняется.
 *
 *   алиас на файлы      не действует: vitest выносит `node_modules` во
 *                       внешнюю среду и грузит `react-router` через Node мимо
 *                       резолвера Vite. Пришлось бы ещё и `ssr.noExternal`,
 *                       а список пакетов, которые нужно втянуть внутрь,
 *                       рос бы вслед за каждым новым.
 *
 *   `overrides`         заставил бы и Prisma Studio работать на 18-й. Студия
 *                       нам не нужна, но это поломка чужой зависимости.
 *
 * Решено версией: `react` и `react-dom` 18.3.1 закреплены в корне, и в
 * репозитории осталась одна копия. Radix, который тянет их для Prisma Studio,
 * работает начиная с React 16.8, так что версия 18 его устраивает.
 *
 * Проверяется это одним тестом в `react-instance.test.tsx`: он падает, если
 * рядом появится вторая копия.
 *
 * ─── Рабочие пакеты ──────────────────────────────────────────────────────────
 *
 * На исходники, а не на `dist`: иначе HMR перезапускал бы сборку пакета, и
 * правка в библиотеке доезжала бы до клиента только после `npm run build`.
 */
const fromHere = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export const WORKSPACE_ALIASES = [
  { find: /^@rd\/shared$/, replacement: fromHere('../shared/src/index.ts') },
  { find: /^@rd\/shared\/anchors$/, replacement: fromHere('../shared/src/anchors.ts') },
  { find: /^@rd\/library\/parse$/, replacement: fromHere('../library/src/parse/index.ts') },
  { find: /^@rd\/library\/anchor$/, replacement: fromHere('../library/src/anchor/index.ts') },
  { find: /^@rd\/library\/render$/, replacement: fromHere('../library/src/render/index.ts') },
];
