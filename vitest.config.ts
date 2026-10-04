import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Пакеты отдаются собранными в `dist`, как и положено: так проверяется ровно
 * тот код, который потом уедет в Node и в браузер. Но чтобы `npm test` работал
 * на свежей копии репозитория и в CI до сборки, алиасы уводят импорты
 * `@rd/library/*` прямо в исходники.
 *
 * Побочная польза: тесты не зависят от того, успел ли отработать `tsc`. Расхождение
 * между исходником и сборкой ловится отдельно, шагом `npm run build`.
 */
const src = (p: string): string => fileURLToPath(new URL(`./packages/library/src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@rd\/library\/parse$/, replacement: src('parse/index.ts') },
      { find: /^@rd\/library\/anchor$/, replacement: src('anchor/index.ts') },
      { find: /^@rd\/library\/render$/, replacement: src('render/index.ts') },
    ],
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.tsx'],
    // По умолчанию Node. Тесты рендерингу объявят среду через
    // `// @vitest-environment jsdom` в шапке файла: тянуть jsdom ради всей
    // конфигурации незачем — DOM нужен только рендереру.
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Один поток. Причина из rd: там распараллеливание съедало память на
    // стороне Node, а детерминированный порядок падений упрощает разбор.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
  },
});