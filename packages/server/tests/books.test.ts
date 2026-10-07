import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  closeTestApp,
  createTestApp,
  createTestRoom,
  createTestUser,
  resetDb,
  testDb,
} from './helpers/test-app.js';

/**
 * Загрузка книг, разбор на сервере, каталог и удаление.
 *
 * Фикстуры собираются кодом (`scripts/make-fixtures.mjs`), а не лежат в
 * репозитории бинарником: файл в несколько килобайт не должен занимать место в
 * истории, а правильность его сборки должна быть видна глазами.
 */

const app = await createTestApp();

const DATA = process.env.DATA_DIR as string;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, '..', '..', '.tmp-fixtures');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Сборка multipart вручную.
 *
 * Порядок частей задан явно и ровно такой, как требует сервер: сначала поля,
 * потом файл. Часть с данными получается общей для всех полей — сервер
 * проверяет, что файл не раньше `kind` и `format`.
 */
function buildMultipart(fields: Record<string, string>, filePath: string) {
  const boundary = `----rdtest${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  const fileName = filePath.split(/[\\/]/).pop() ?? 'file';
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ),
  );
  chunks.push(readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const upload = (
  url: string,
  token: string,
  fields: Record<string, string>,
  file: string,
) => {
  const { payload, contentType } = buildMultipart(fields, file);
  return app.inject({
    method: 'POST',
    url,
    headers: { ...auth(token), 'content-type': contentType },
    payload,
  });
};

/**
 * Загрузка в каталог.
 *
 * Отдельная сборка multipart: у каталога имена полей-файлов (`text`, `audio`,
 * `cover`), а не `file` с полями `kind` и `format`. Вид несёт имя поля, и
 * поэтому контракта «поля раньше файла» здесь нет — файл может прийти где угодно.
 */
function buildCatalogMultipart(
  fields: Record<string, string>,
  files: Array<{ field: string; path: string }>,
) {
  const boundary = `----rdcat${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  for (const { field, path } of files) {
    const fileName = path.split(/[\\/]/).pop() ?? 'file';
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
      ),
    );
    chunks.push(readFileSync(path));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const uploadToCatalog = (
  token: string,
  fields: Record<string, string>,
  files: Array<{ field: string; path: string }>,
) => {
  const { payload, contentType } = buildCatalogMultipart(fields, files);
  return app.inject({
    method: 'POST',
    url: '/api/admin/catalog',
    headers: { ...auth(token), 'content-type': contentType },
    payload,
  });
};

const EPUB = () => join(FIXTURES, 'test-book.epub');
const MP3 = () => join(FIXTURES, 'test-audio.mp3');
const JPEG = () => join(FIXTURES, 'cover.jpg');

beforeAll(async () => {
  await mkdir(FIXTURES, { recursive: true });
  execFileSync(process.execPath, [join(HERE, '..', 'scripts', 'make-fixtures.mjs'), FIXTURES], {
    stdio: 'pipe',
  });
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
  await rm(FIXTURES, { recursive: true, force: true });
});

describe('загрузка текстовой книги', () => {
  it('разбирает EPUB на сервере и отдаёт оглавление и главу', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await upload(
      `/api/rooms/${roomId}/books/upload`,
      owner.token,
      { kind: 'text', format: 'epub', title: 'Проверка', author: 'Тестовый Автор' },
      EPUB(),
    );

    expect(response.statusCode).toBe(201);
    const book = response.json().book;
    expect(book.files[0].parsed).toBe(true);

    // Пути на диске наружу не отдаются: клиенту они не нужны, а знание
    // структуры DATA_DIR ничего полезного не даёт.
    expect(response.body).not.toContain('filePath');
    expect(response.body).not.toContain('derivedPath');

    /*
      Адреса чтения несут комнату: права на текст проверяются по ней. Проверки
      самих прав живут в `tests/reader-access.test.ts`, здесь — только то, что
      разобранная книга отдаётся по правильному адресу.
    */
    const index = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${book.id}/index.json`,
      headers: auth(owner.token),
    });
    expect(index.statusCode).toBe(200);
    const parsed = JSON.parse(index.body);
    expect(parsed.title).toBe('Проверка загрузки');
    expect(parsed.chapters).toHaveLength(2);
    expect(parsed.parserVersion).toBe('1');

    const chapter = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${book.id}/ch/0.json`,
      headers: auth(owner.token),
    });
    expect(chapter.statusCode).toBe(200);
    expect(JSON.parse(chapter.body).length).toBeGreaterThan(0);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books/${book.id}/ch/99.json`,
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('файл раньше полей отклоняется: без kind невозможно выбрать лимит', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const { payload, contentType } = buildMultipart(
      { title: 'Проверка', author: 'Тестовый Автор' },
      EPUB(),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/upload`,
      headers: { ...auth(owner.token), 'content-type': contentType },
      payload,
    });

    expect(response.statusCode).toBe(400);
    // Записи в базе нет. Проверять пустоту `files/` нельзя: каталог общий для
    // всего прогона и к этому моменту уже наполнен предыдущими тестами.
    expect(await testDb.book.count()).toBe(0);
  });

  it('формат, не подходящий к kind, отклоняется', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await upload(
      `/api/rooms/${roomId}/books/upload`,
      owner.token,
      { kind: 'text', format: 'mp3', title: 'А', author: 'Б' },
      EPUB(),
    );

    expect(response.statusCode).toBe(400);
  });

  it('пустая файловая часть не создаёт записи', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    // Случай «файл не пришёл» на проводе: часть есть, а данных в ней нет.
    // Проверяется охранник на пустой файл — без него в базе появилась бы запись
    // о книге, которой нет.
    const boundary = '----rdtest-empty';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\ntext\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="format"\r\n\r\nepub\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nА\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="author"\r\n\r\nБ\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pustoy.epub"\r\n` +
        'Content-Type: application/epub+zip\r\n\r\n' +
        `\r\n--${boundary}--\r\n`,
      'utf8',
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/upload`,
      headers: {
        ...auth(owner.token),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(await testDb.book.count()).toBe(0);
    expect(await testDb.bookFile.count()).toBe(0);
  });
});

describe('загрузка аудио', () => {
  it('определяет длительность MP3', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await upload(
      `/api/rooms/${roomId}/books/upload`,
      owner.token,
      { kind: 'audio', format: 'mp3', title: 'Аудиокнига', author: 'Диктор' },
      MP3(),
    );

    expect(response.statusCode).toBe(201);
    const file = response.json().book.files[0];
    // Фикстура собрана на 128 кбит/с и рассчитана на 26 секунд.
    expect(file.durationSec).toBe(26);
    // Аудио на главы не разбирается.
    expect(file.parsed).toBe(false);
  });
});

describe('права', () => {
  it('посторонний не может грузить в комнату', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await upload(
      `/api/rooms/${roomId}/books/upload`,
      stranger.token,
      { kind: 'text', format: 'epub', title: 'X', author: 'Y' },
      EPUB(),
    );

    expect(response.statusCode).toBe(403);
  });

  it('список книг комнаты постороннему недоступен', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/books`,
      headers: auth(stranger.token),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('удаление книги', () => {
  it('убирает с диска и оригинал, и каталог разбора', async () => {
    /*
      Глобальное удаление — только админское.

      Раньше правило было «владелец любой комнаты, где лежит книга, либо админ»,
      и оно работало, пока книга жила в одной комнате. С появлением каталога одна
      и та же книга лежит сразу во многих, и кнопка в одной комнате сносила её у
      всех остальных. Поэтому в комнате теперь `DELETE /rooms/:roomId/books/:bookId`
      (снятие связи), а удаление целиком осталось здесь.
    */
    const admin = await createTestUser({ role: 'admin' });
    const { roomId } = await createTestRoom({ ownerId: admin.user.id });

    const response = await upload(
      `/api/rooms/${roomId}/books/upload`,
      admin.token,
      { kind: 'text', format: 'epub', title: 'Удаляемая', author: 'Автор' },
      EPUB(),
    );
    const bookId = response.json().book.id as string;

    const stored = await testDb.bookFile.findFirstOrThrow({ where: { bookId } });
    const fileDir = join(DATA, 'files', (stored.filePath.split('/')[1] as string));
    const derivedDir = join(DATA, stored.derivedPath as string);

    // До удаления оба на месте.
    expect(existsSync(fileDir)).toBe(true);
    expect(existsSync(derivedDir)).toBe(true);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/books/${bookId}`,
      headers: auth(admin.token),
    });
    expect(removed.statusCode).toBe(200);

    expect(await testDb.book.findUnique({ where: { id: bookId } })).toBeNull();
    // Каталоги тоже убраны: иначе они копились бы при каждой неудачной
    // загрузке и никто бы их не чистил.
    expect(existsSync(fileDir)).toBe(false);
    expect(existsSync(derivedDir)).toBe(false);
  });

  it('участник удалить книгу целиком не может', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const member = await createTestUser({ role: 'user' });
    const { roomId } = await createTestRoom({
      ownerId: admin.user.id,
      memberIds: [member.user.id],
    });

    const response = await upload(
      `/api/rooms/${roomId}/books/upload`,
      admin.token,
      { kind: 'text', format: 'epub', title: 'Книга', author: 'Автор' },
      EPUB(),
    );
    const bookId = response.json().book.id as string;

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/books/${bookId}`,
      headers: auth(member.token),
    });

    expect(denied.statusCode).toBe(403);
    expect(await testDb.book.findUnique({ where: { id: bookId } })).not.toBeNull();
  });
});

describe('каталог', () => {
  it('пополняется админом и добавляется в комнату связью, а не копией', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const { roomId } = await createTestRoom({ ownerId: admin.user.id });

    const response = await uploadToCatalog(
      admin.token,
      { title: 'Евгений Онегин', author: 'А. С. Пушкин' },
      [{ field: 'text', path: EPUB() }],
    );
    expect(response.statusCode).toBe(201);
    const catalogId = response.json().book.id as string;
    expect(response.json().book.isCatalog).toBe(true);

    const added = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/from-catalog`,
      headers: auth(admin.token),
      payload: { catalogBookId: catalogId },
    });
    expect(added.statusCode).toBe(201);

    // Одна запись Book и один BookFile: копия означала бы два файла на один
    // исходник, и удаление любого снесло бы файл, нужный другому.
    expect(await testDb.book.count()).toBe(1);
    expect(await testDb.bookFile.count()).toBe(1);

    const again = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/from-catalog`,
      headers: auth(admin.token),
      payload: { catalogBookId: catalogId },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().added).toBe(false);
  });

  it('не админ каталог пополнить не может', async () => {
    const user = await createTestUser({ role: 'user' });

    const response = await uploadToCatalog(
      user.token,
      { title: 'X', author: 'Y' },
      [{ field: 'text', path: EPUB() }],
    );

    expect(response.statusCode).toBe(403);
  });

  it('поиск по каталогу находит по автору', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await uploadToCatalog(
      admin.token,
      { title: 'Евгений Онегин', author: 'А. С. Пушкин' },
      [{ field: 'text', path: EPUB() }],
    );

    // Запрос кодируется: необработанная кириллица доезжает до сервера как
    // latin1 и не совпадает с UTF-8 в базе.
    const q = encodeURIComponent('пушкин');
    const response = await app.inject({
      method: 'GET',
      url: `/api/catalog?q=${q}`,
      headers: auth(admin.token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().books).toHaveLength(1);
  });
});

describe('валидация якорей', () => {
  it('отвергает якорь не того типа и принимает верный', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const response = await upload(
      `/api/rooms/${roomId}/books/upload`,
      owner.token,
      { kind: 'text', format: 'epub', title: 'Якоря', author: 'Автор' },
      EPUB(),
    );
    const bookId = response.json().book.id as string;

    // Импорт здесь намеренный: проверяется контракт между сервером и общим
    // пакетом, а не внутренности маршрутов.
    const { validateAnchor, describeIssues } = await import('@rd/shared/anchors');

    const good = validateAnchor(
      { kind: 'text', chapterIndex: 0, blockIndex: 1, start: 0, end: 5, quote: 'Ветер', prefix: '', suffix: '' },
      'text',
      'epub',
    );
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.anchorType).toBe('text');

    // Аудио-якорь у текстового файла — ошибка структуры, а не мелочь.
    const wrong = validateAnchor({ kind: 'audio', timeSec: 10 }, 'text', 'epub');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(describeIssues(wrong.issues)).toContain('anchor.kind');

    // Конец раньше начала: такой якорь не разрешится никогда.
    const inverted = validateAnchor(
      { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 9, end: 2, quote: 'x', prefix: '', suffix: '' },
      'text',
      'epub',
    );
    expect(inverted.ok).toBe(false);

    // Страница PDF: при format=epub такой якорь быть не должен.
    expect(validateAnchor({ kind: 'page', page: 3 }, 'text', 'epub').ok).toBe(false);
    expect(validateAnchor({ kind: 'page', page: 3 }, 'text', 'pdf').ok).toBe(true);

    // Номер страницы с нуля — ошибка: нумерация в интерфейсе с единицы.
    expect(validateAnchor({ kind: 'page', page: 0 }, 'text', 'pdf').ok).toBe(false);

    expect(bookId).not.toBe('');
  });
});
