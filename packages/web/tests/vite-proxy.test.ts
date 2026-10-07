import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Прокси dev-сервера.
 *
 * ─── Почему это важно ─────────────────────────────────────────────────────────
 *
 * Прокси в `vite.config.ts` перечислен списком, и забытый префикс не даёт
 * ошибки: запрос уходит в клиентское приложение, которое отдаёт свой
 * `index.html`. В `<img>` это выглядит как «картинка не загрузилась», причём
 * без единой строки в консоли — браузер получил валидный HTML и не счёл это
 * ошибкой.
 *
 * Так и вышло: `/files` в списке не было, а `GET /api/books/:id/cover` отвечает
 * переадресацией на `/files/covers/...`, то есть второй запрос уходил мимо
 * сервера. Обложка не показывалась нигде, и ни один тест этого не замечал:
 * тесты клиента ходят по `fetch` с заглушкой, а серверные — прямо на `:3000`
 * мимо прокси.
 *
 * ─── Почему читается файл, а не импортируется конфиг ──────────────────────────
 *
 * `vite.config.ts` импортирует плагин React и алиасы; ради одной проверки
 * поднимать их в тестовой среде незачем. Список префиксов — это данные в
 * тексте, и читать их оттуда надёжнее, чем исполнять конфиг.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = readFileSync(resolve(HERE, '../vite.config.ts'), 'utf8');

/** Префиксы, объявленные в `server.proxy`. */
function proxiedPrefixes(): string[] {
  const at = CONFIG.indexOf('proxy: {');
  if (at === -1) throw new Error('В конфиге нет server.proxy');

  let depth = 0;
  let end = CONFIG.length;
  for (let i = CONFIG.indexOf('{', at); i < CONFIG.length; i += 1) {
    if (CONFIG[i] === '{') depth += 1;
    if (CONFIG[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const block = CONFIG.slice(at, end);
  return [...block.matchAll(/'([^']+)':\s*\{/g)].map((m) => m[1] as string);
}

describe('прокси dev-сервера', () => {
  it('отдаёт и раздачу файлов, а не только API', () => {
    const prefixes = proxiedPrefixes();

    expect(prefixes).toContain('/api');
    expect(prefixes).toContain('/socket.io');
    expect(prefixes).toContain('/files');
  });

  it('сокет проксируется с апгрейдом', () => {
    /*
      Флаг `ws: false` **запрещает** проксирование апгрейда, а не разрешает
      его. С таким значением клиент начинал с транспорта `websocket`, апгрейд
      до Vite не доходил, и соединение падало целиком — при выключенном по
      умолчанию `tryAllTransports` отката на `polling` не было.
    */
    expect(CONFIG).toMatch(/'\/socket\.io':\s*\{[^}]*ws:\s*true/);
  });

  it('каждый префикс указывает на адрес сервера', () => {
    // Прокси без `target` молча не проксирует ничего: Vite отдаст запрос
    // клиентскому приложению, и ошибка будет выглядеть как «страница не
    // работает», а не как «не настроен прокси».
    const at = CONFIG.indexOf('proxy: {');
    const block = CONFIG.slice(at, CONFIG.indexOf('resolve:', at));
    const rules = [...block.matchAll(/'([^']+)':\s*\{([^}]*)\}/g)];

    expect(rules.length).toBeGreaterThan(0);
    for (const [, prefix, options] of rules) {
      expect(options, `префикс ${prefix} должен указывать на сервер`).toContain('target:');
      expect(options, `префикс ${prefix} должен переписывать Host`).toContain('changeOrigin: true');
    }
  });

  it('нет префикса, начинающегося с "/api" после "/api"', () => {
    /*
      `'/api-old'` начинается с `/api`, и при проверке через `startsWith` его
      приняли бы за покрытый. Здесь сравнение точное — лишний префикс с таким
      именем означал бы, что кто-то переименовал маршрут и не обновил прокси.
    */
    const prefixes = proxiedPrefixes();
    const overlapping = prefixes.filter((p) => p !== '/api' && '/api'.startsWith(p));
    expect(overlapping).toEqual([]);
  });
});