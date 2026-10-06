import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { WORKSPACE_ALIASES } from './vite.aliases.js';

/**
 * Конфигурация клиента.
 *
 * ─── Прокси: зачем он, а не CORS ─────────────────────────────────────────────
 *
 * Токен лежит в cookie `rd_token` с `SameSite=Lax`. Lax не пересекает
 * origins, поэтому в разработке на `localhost:5173` cookie, поставленный
 * сервером с `localhost:3000`, в запросе не появится: браузер посчитает их
 * разными сайтами. Классические обходы — `SameSite=None` (нужен HTTPS, которого
 * на localhost нет) или CORS с `credentials` (не помогает: ограничение на
 * стороне cookie, а не CORS).
 *
 * Прокси снимает проблему целиком: браузер видит один origin, и cookie
 * принадлежит ему же. В продакшене оба хоста стоят за одним доменом через
 * Cloudflare Tunnel, там прокси не нужен — и это же объясняет, почему он
 * настроен только на `server.proxy`.
 *
 * `/socket.io` проксируется по той же причине плюс ещё одна: апгрейд соединения
 * идёт отдельным HTTP-запросом с заголовком `Upgrade`, и его надо проксировать
 * отдельно от обычных запросов — иначе сокет в разработке не подключится вовсе.
 *
 * ─── Про `ws: true`, а не `ws: false` ─────────────────────────────────────────
 *
 * Здесь раньше стояло `ws: false`, и это было неверно: флаг **запрещает**
 * проксировать апгрейд, а не разрешает его. Клиент начинает с транспорта
 * `websocket`, апгрейд до Vite не доходил, и соединение падало — при этом
 * `tryAllTransports` у socket.io по умолчанию выключен, то есть отката на
 * `polling` не происходило.
 *
 * Наблюдалось в живом браузере: ноль запросов `/socket.io` до сервера, а на
 * странице комнаты — «0 человек читает сейчас» при том, что человек в комнате
 * был. Тесты сокетов это не видели: `socket-test.mts` ходит прямо на `:3000` и
 * прокси Vite не проходит.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: true },
      '/health': { target: API_TARGET, changeOrigin: true },
    },
  },

  resolve: {
    // Алиасы React идут первыми и несут подробное объяснение в
    // `vite.aliases.ts`. Без них клиент падает с
    // `Cannot read properties of null (reading 'useRef')`.
    alias: WORKSPACE_ALIASES,
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
