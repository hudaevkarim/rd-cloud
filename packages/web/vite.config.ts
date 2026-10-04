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
 * `/socket.io` проксируется по той же причине плюс ещё одна: рукопожатие идёт
 * длинным опросом до апгрейда, и без `ws: false` апгрейд не состоится.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/socket.io': { target: API_TARGET, changeOrigin: true, ws: false },
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
