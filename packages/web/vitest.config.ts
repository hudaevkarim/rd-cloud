import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_ALIASES } from './vite.aliases.js';

/**
 * Тесты клиента.
 *
 * Отдельный конфиг, как и у сервера: среда — jsdom, а не node, и `environment`
 * указывается на весь прогон. Смешивать с тестами библиотеки нельзя, потому что
 * серверные тесты ходят в Postgres, а клиентские — в DOM, и один общий конфиг
 * означал бы, что падение базы уронило бы проверку кнопки.
 *
 * Алиасы те же, что в `vite.config.ts`, и по той же причине: тесты идут по
 * исходникам, а не по `dist`, иначе проверяли бы предыдущую сборку.
 */
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: WORKSPACE_ALIASES,
  },

  /**
   * Корень репозитория передаётся константой, а не вычисляется в тесте.
   *
   * Внутри воркера vitest пути декодируются неверно: имя пользователя с
   * кириллицей приходит как `C:/Users/<мусор>/…`, и `existsSync` по такому
   * пути всегда возвращает `false` — молча, без всякой ошибки. Наблюдалось так:
   * проверка «в корне лежит react 18» падала, хотя react там есть и находится
   * в трёх каталогах вверх от места запуска; тот же код под обычным `node` давал
   * верный результат.
   *
   * Файл конфига загружается в главном процессе, где пути ещё целы, поэтому
   * корень вычисляется здесь и подставляется в тесты как константа.
   */
  define: {
    __REPO_ROOT__: JSON.stringify(fileURLToPath(new URL('../../', import.meta.url))),
  },

  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
    globals: false,
  },
});

declare global {
  /** Подставляется `define` выше; в исходниках не импортируется. */
  const __REPO_ROOT__: string;
}
