import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  closeTestApp,
  createTestApp,
  createTestRoom,
  createTestUser,
  resetDb,
  testDb,
} from './helpers/test-app.js';
import { logger } from '../src/lib/logger.js';

/**
 * Авторизация на чтение.
 *
 * ─── Почему этот файл отдельно ──────────────────────────────────────────────
 *
 * Маршруты чтения — `/rooms/:roomId/books/:bookId`, `.../index.json`,
 * `.../ch/:n.json`. До подэтапа 7.4 они были `/books/:id…` и проверяли только
 * токен, то есть любой вошедший читал любую книгу по её идентификатору. Текст
 * тогда нигде не отдавался, и это было терпимо; с появлением читалки перестало.
 *
 * ─── Главное здесь — негативные случаи ──────────────────────────────────────
 *
 * Проверка «участнику 200» проходит и при полном отсутствии проверки: снять
 * проверку целиком, и тест останется зелёным. Поэтому отдельно проверяется
 * чужой `roomId` при валидном токене, книга из другой комнаты и не-участник —
 * именно они падают при снятой проверке.
 */

const app = await createTestApp();

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, '..', '..', '.tmp-fixtures');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(() => {
  // Фикстуры нужны, чтобы у книги был разобранный текст: без разбора `index.json`
  // и `ch/0.json` отвечали бы 404, и проверка прав была бы неотличима от
  // «книги нет».
  execFileSync(process.execPath, [join(HERE, '..', 'scripts', 'make-fixtures.mjs'), FIXTURES], {
    stdio: 'ignore',
  });
});

afterAll(async () => {
  await closeTestApp();
  // Фикстуры убираются и здесь: запуск одного файла оставлял бы
  // `packages/.tmp-fixtures/` в рабочем дереве, и `git status` показывал бы
  // мусор, которого нет в коде.
  await rm(FIXTURES, { recursive: true, force: true });
});

/**
 * Комната с книгой, о которой можно спросить.
 *
 * Возвращает адреса всех трёх маршрутов: проверять их надо по одному списком, и
 * иначе легко забыть про главу — а именно она отдаёт сам текст.
 */
async function roomWithBook() {
  // Имена не фиксируются: база общая на файл, и вторая фикстура упёрлась бы в
  // уникальный индекс. Роли тут не играют — важны только токены.
  const owner = await createTestUser();
  const reader = await createTestUser();
  const outsider = await createTestUser();
  const admin = await createTestUser({ role: 'admin' });

  const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [reader.user.id] });
  const { roomId: otherRoomId } = await createTestRoom({ ownerId: owner.user.id });

  const epub = readFileSync(join(FIXTURES, 'test-book.epub'));

  const { payload, contentType } = buildUpload(epub);
  const uploaded = await app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/books/upload`,
    headers: { ...auth(owner.token), 'content-type': contentType },
    payload,
  });

  expect(uploaded.statusCode).toBe(201);
  const { book } = (await uploaded.json()) as { book: { id: string } };

  return {
    roomId,
    otherRoomId,
    bookId: book.id,
    owner,
    reader,
    outsider,
    admin,
    адреса: {
      метаданные: `/api/rooms/${roomId}/books/${book.id}`,
      оглавление: `/api/rooms/${roomId}/books/${book.id}/index.json`,
      глава: `/api/rooms/${roomId}/books/${book.id}/ch/0.json`,
    },
  };
}

function buildUpload(epub: Buffer) {
  const boundary = `----rdtest${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  const field = (name: string, value: string): void => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  };

  // Порядок обязателен: сервер читает multipart одним проходом.
  field('kind', 'text');
  field('format', 'epub');
  field('title', 'Книга для проверки прав');
  field('author', 'Тестовый Автор');

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test-book.epub"\r\n` +
        'Content-Type: application/epub+zip\r\n\r\n',
      'utf8',
    ),
    epub,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );

  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('чтение: без токена', () => {
  it('все три маршрута отвечают 401', async () => {
    const f = await roomWithBook();

    /*
      Здесь и негативный случай, и проверка на неотличимость: если бы маршруты
      отвечали 404 вместо 401, различие «нет токена» и «нет книги» позволяло бы
      перебирать идентификаторы.
    */
    for (const url of [f.адреса.метаданные, f.адреса.оглавление, f.адреса.глава]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('чтение: не участник комнаты', () => {
  it('посторонний получает 403 на всех трёх маршрутах', async () => {
    const f = await roomWithBook();

    for (const url of [f.адреса.метаданные, f.адреса.оглавление, f.адреса.глава]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(f.outsider.token) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('чужой roomId при валидном токене даёт 403, а не 404 и не 200', async () => {
    const f = await roomWithBook();

    /*
      Ключевая проверка файла. Человек состоит в `otherRoomId` и не состоит в
      `roomId`, но подставляет чужой `roomId` в адрес.

      - 200 означал бы, что проверки нет вовсе.
      - 404 выдавал бы, что участник другой комнаты не знает и о книге, — то
        есть по различию ответов можно перебирать: «комната моя, книга нет» против
        «комната не моя».
    */
    for (const suffix of ['', '/index.json', '/ch/0.json']) {
      const url = `/api/rooms/${f.otherRoomId}/books/${f.bookId}${suffix}`;
      const res = await app.inject({ method: 'GET', url, headers: auth(f.reader.token) });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('своя комната, но книга из другой — 404, а не 200', async () => {
    const f = await roomWithBook();
    const stranger = await createTestUser();
    const { roomId: myRoom } = await createTestRoom({ ownerId: stranger.user.id });

    // Запрос идёт от владельца `myRoom`: комната своя, а книги в ней нет.
    const url = `/api/rooms/${myRoom}/books/${f.bookId}/ch/0.json`;
    const res = await app.inject({ method: 'GET', url, headers: auth(stranger.token) });

    /*
      Проверка «комната своя» без проверки «книга в этой комнате» пропустила бы
      участника комнаты А к книге комнаты Б: адрес выглядит осмысленным, а
      `roomId` в нём — просто слово.
    */
    expect(res.statusCode).toBe(404);
  });
});

describe('чтение: участник', () => {
  it('владелец читает все три', async () => {
    const f = await roomWithBook();

    const meta = await app.inject({
      method: 'GET',
      url: f.адреса.метаданные,
      headers: auth(f.owner.token),
    });
    expect(meta.statusCode).toBe(200);

    const index = await app.inject({
      method: 'GET',
      url: f.адреса.оглавление,
      headers: auth(f.owner.token),
    });
    expect(index.statusCode).toBe(200);

    const chapter = await app.inject({
      method: 'GET',
      url: f.адреса.глава,
      headers: auth(f.owner.token),
    });
    expect(chapter.statusCode).toBe(200);
  });

  it('обычный участник читает главу', async () => {
    const f = await roomWithBook();

    const res = await app.inject({
      method: 'GET',
      url: f.адреса.глава,
      headers: auth(f.reader.token),
    });

    expect(res.statusCode).toBe(200);
    const blocks = (await res.json()) as unknown[];
    /*
      Именно текст, а не пустой массив: без проверки прав маршрут отдаёт главу
      любому, кто знает адрес, и тест «200» прошёл бы, не заметив этого.
    */
    expect(blocks.length).toBeGreaterThan(0);
  });
});

describe('чтение: администратор', () => {
  it('админ проходит в чужую комнату', async () => {
    const f = await roomWithBook();

    const res = await app.inject({
      method: 'GET',
      url: f.адреса.глава,
      headers: auth(f.admin.token),
    });

    // Админ и раньше видел чужую комнату; расхождение между проверками доступа
    // хуже, чем само решение. Правило меняется в `canAccessRoom`.
    expect(res.statusCode).toBe(200);
  });

  it('проход админа попадает в журнал отдельной строкой', async () => {
    const f = await roomWithBook();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      await app.inject({
        method: 'GET',
        url: f.адреса.глава,
        headers: auth(f.admin.token),
      });

      /*
        Требование было не «админ проходит», а «это видно в журнале отдельным
        случаем». Молча пропущенный админ в чужой комнате выглядит в логах
        точь-в-точь как дыра, и при разборе инцидента их не отличить.

        Шпион на самом логгере, а не на `process.stdout`: у pino-pretty вывод
        уходит в отдельный поток и появляется не сразу, проверка была бы
        мигающей.

        `event` лежит в первом аргументе — `logger.warn(объект, сообщение)`, —
        и проверяется первым. Поиск во втором давал пустой результат при
        полностью верном коде: проверка проходила бы, ничего не утверждая.
      */
      const вызовы = warn.mock.calls.filter(
        (args) => (args[0] as { event?: string } | undefined)?.event === 'room_access_by_admin',
      );
      expect(вызовы).toHaveLength(1);
      expect(вызовы[0]?.[0]).toMatchObject({ roomId: f.roomId, userId: f.admin.user.id });
    } finally {
      warn.mockRestore();
    }
  });

  it('доступ участника в журнал не попадает', async () => {
    const f = await roomWithBook();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      await app.inject({
        method: 'GET',
        url: f.адреса.глава,
        headers: auth(f.reader.token),
      });

      /*
        Обратная сторона предыдущей проверки. Если бы строка писалась на любой
        доступ, она ничего бы не значила: в журнале должно быть видно именно
        то, что произошло не по правилам.
      */
      const вызовы = warn.mock.calls.filter(
        (args) => (args[0] as { event?: string } | undefined)?.event === 'room_access_by_admin',
      );
      expect(вызовы).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('админ всё равно не читает книгу, которой нет в этой комнате', async () => {
    const f = await roomWithBook();
    const other = await createTestUser();
    const { roomId: otherRoom } = await createTestRoom({ ownerId: other.user.id });

    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${otherRoom}/books/${f.bookId}/ch/0.json`,
      headers: auth(f.admin.token),
    });

    /*
      Право админа — право видеть чужую комнату, а не читать любую книгу из
      любой комнаты. Проверка «книга в этой комнате» работает для всех ролей
      одинаково, и это сделано специально: иначе админ оказался бы единственным,
      кто читает что угодно по любому адресу.
    */
    expect(res.statusCode).toBe(404);
  });
});

describe('старые адреса чтения', () => {
  it('больше не отвечают', async () => {
    const f = await roomWithBook();

    for (const url of [
      `/api/books/${f.bookId}`,
      `/api/books/${f.bookId}/index.json`,
      `/api/books/${f.bookId}/ch/0.json`,
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: auth(f.owner.token) });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('список книг и файл', () => {
  it('правило доступа у них то же, что у чтения', async () => {
    const f = await roomWithBook();

    // Участник — 200.
    const own = await app.inject({
      method: 'GET',
      url: `/api/rooms/${f.roomId}/books`,
      headers: auth(f.reader.token),
    });
    expect(own.statusCode).toBe(200);

    // Посторонний — 403, и админ проходит: раньше здесь стояла своя проверка,
    // отличавшаяся от соседней, и админ проходил в чтении, но не здесь.
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/rooms/${f.roomId}/books`,
      headers: auth(f.outsider.token),
    });
    expect(foreign.statusCode).toBe(403);

    const byAdmin = await app.inject({
      method: 'GET',
      url: `/api/rooms/${f.roomId}/books`,
      headers: auth(f.admin.token),
    });
    expect(byAdmin.statusCode).toBe(200);
  });

  it('файл книги: админу так же, как участнику', async () => {
    const f = await roomWithBook();

    const byMember = await app.inject({
      method: 'GET',
      url: `/api/books/${f.bookId}/file?kind=text`,
      headers: auth(f.reader.token),
    });
    expect(byMember.statusCode).toBe(200);

    const byAdmin = await app.inject({
      method: 'GET',
      url: `/api/books/${f.bookId}/file?kind=text`,
      headers: auth(f.admin.token),
    });
    expect(byAdmin.statusCode).toBe(200);

    const byOutsider = await app.inject({
      method: 'GET',
      url: `/api/books/${f.bookId}/file?kind=text`,
      headers: auth(f.outsider.token),
    });
    expect(byOutsider.statusCode).toBe(403);
  });
});