import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
 * Каталог: пополнение с двумя файлами, обложка, поиск, уборка из комнаты.
 *
 * Здесь проверяется ровно то, что менялось в 7.3: два необязательных файла в
 * одном запросе, обязательное «хотя бы один», уборка книги с правами по роли и
 * двумя разными маршрутами удаления.
 *
 * Фикстуры собираются кодом, как и в `books.test.ts`, — файл в несколько
 * килобайт не должен занимать место в истории.
 */

const app = await createTestApp();

const DATA = process.env.DATA_DIR as string;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES = join(HERE, '..', '..', '.tmp-fixtures-cat');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const EPUB = () => join(FIXTURES, 'test-book.epub');
const MP3 = () => join(FIXTURES, 'test-audio.mp3');
const JPEG = () => join(FIXTURES, 'cover.jpg');
const PNG = () => join(FIXTURES, 'cover.png');

interface CatalogFile {
  field: string;
  path: string;
}

/**
 * Сборка multipart формы каталога.
 *
 * Порядок частей здесь произвольный: у каталога вид файла несёт имя поля, а не
 * поле `kind`, поэтому контракта «поля раньше файла» не существует. Файл,
 * наоборот, стоит **перед** полем `title` — так проверяется, что маршрут действительно
 * не зависит от порядка.
 */
function buildCatalogMultipart(
  fields: Record<string, string>,
  files: CatalogFile[],
  filesFirst = false,
) {
  const boundary = `----rdcat${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];

  const pushFields = (): void => {
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          'utf8',
        ),
      );
    }
  };
  const pushFiles = (): void => {
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
  };

  if (filesFirst) {
    pushFiles();
    pushFields();
  } else {
    pushFields();
    pushFiles();
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const uploadToCatalog = (
  token: string,
  fields: Record<string, string>,
  files: CatalogFile[],
  filesFirst = false,
) => {
  const { payload, contentType } = buildCatalogMultipart(fields, files, filesFirst);
  return app.inject({
    method: 'POST',
    url: '/api/admin/catalog',
    headers: { ...auth(token), 'content-type': contentType },
    payload,
  });
};

/** Загрузка одного файла в комнату — старый маршрут, одиночный `file`. */
function uploadToRoom(roomId: string, token: string, title: string) {
  const boundary = `----rdroom${Math.random().toString(36).slice(2)}`;
  const fields: Array<[string, string]> = [
    ['kind', 'text'],
    ['format', 'epub'],
    ['title', title],
    ['author', 'Тестовый Автор'],
  ];
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test-book.epub"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8',
    ),
  );
  chunks.push(readFileSync(EPUB()));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  return app.inject({
    method: 'POST',
    url: `/api/rooms/${roomId}/books/upload`,
    headers: { ...auth(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  });
}

/** Файлы, оставшиеся в DATA_DIR: папка, её содержимое и всё вложенное. */
async function dataTree(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = `${prefix}${entry}`;
      out.push(rel);
      await walk(full, `${rel}/`);
    }
  };
  await walk(join(DATA, 'files'), 'files/');
  await walk(join(DATA, 'covers'), 'covers/');
  await walk(join(DATA, 'tmp'), 'tmp/');
  await walk(join(DATA, 'derived'), 'derived/');
  return out;
}

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

describe('каталог: два файла в одном запросе', () => {
  it('текст и аудио вместе: две записи BookFile у одной книги', async () => {
    const admin = await createTestUser({ role: 'admin' });

    const response = await uploadToCatalog(
      admin.token,
      { title: 'Анна Каренина', author: 'Л. Н. Толстой' },
      [
        { field: 'text', path: EPUB() },
        { field: 'audio', path: MP3() },
      ],
    );

    // Тело ответа в сообщении: иначе «ожидалось 201, получено 400» не говорит,
    // ни какой отказ это был — а отказов тут несколько, и каждый о своей причине.
    expect(response.statusCode, response.body).toBe(201);
    const book = response.json().book;
    expect(book.hasText).toBe(true);
    expect(book.hasAudio).toBe(true);
    expect(book.files).toHaveLength(2);

    // Аудио должно получить длительность: без неё шкала прогресса и
    // комментарии по времени не с чем сравнить.
    const audio = book.files.find((f: { kind: string }) => f.kind === 'audio');
    expect(audio.durationSec).toBe(26);
    // Текст разобран — оглавление существует.
    const text = book.files.find((f: { kind: string }) => f.kind === 'text');
    expect(text.parsed).toBe(true);

    expect(await testDb.book.count()).toBe(1);
    expect(await testDb.bookFile.count()).toBe(2);
  });

  it('только текст', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const response = await uploadToCatalog(
      admin.token,
      { title: 'Только текст', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().book.hasText).toBe(true);
    expect(response.json().book.hasAudio).toBe(false);
  });

  it('только аудио', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const response = await uploadToCatalog(
      admin.token,
      { title: 'Только аудио', author: 'Автор' },
      [{ field: 'audio', path: MP3() }],
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().book.hasText).toBe(false);
    expect(response.json().book.hasAudio).toBe(true);
  });

  it('без файлов — 400, и ничего не остаётся на диске', async () => {
    const admin = await createTestUser({ role: 'admin' });

    /*
      Снимок «до», а не пустота: DATA_DIR общий на весь файл тестов, и к этому
      моменту там лежат файлы предыдущих проверок. Сравнение с пустым списком
      означало бы «тест зависит от порядка»: первая же упавшая проверка
      обрушила бы все следующие вместе с собой.
    */
    const before = await dataTree();

    const response = await uploadToCatalog(
      admin.token,
      { title: 'Ничего нет', author: 'Автор' },
      [],
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/хотя бы один/i);
    expect(await testDb.book.count()).toBe(0);

    // Ничего не добавилось — и, что важнее, не осталось папки попытки: иначе
    // после сотни неудачных загрузок в DATA_DIR копились бы каталоги, в которых
    // ничего нет.
    const after = await dataTree();
    expect(after).toEqual(before);
    expect(after.some((p) => p.startsWith('tmp/'))).toBe(false);
  });

  it('только обложка без текста и аудио — 400', async () => {
    const admin = await createTestUser({ role: 'admin' });

    /*
      Обложка — не «файл книги». Принять книгу с одной картинкой значило бы
      создать запись, которую нельзя ни прочитать, ни послушать.
    */
    const response = await uploadToCatalog(
      admin.token,
      { title: 'Картинка', author: 'Автор' },
      [{ field: 'cover', path: JPEG() }],
    );

    expect(response.statusCode).toBe(400);
    expect(await testDb.book.count()).toBe(0);
  });

  it('порядок частей не важен: файл до полей принимается', async () => {
    const admin = await createTestUser({ role: 'admin' });

    /*
      Отличие от загрузки в комнату: там файл обязан идти после `kind` и
      `format`, потому что лимит размера зависит от них и должен быть известен до
      первого байта. Здесь вид несёт имя поля, поэтому зависимости нет — и форма
      может прислать файлы первыми.
    */
    const response = await uploadToCatalog(
      admin.token,
      { title: 'Порядок не важен', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
      true,
    );

    expect(response.statusCode).toBe(201);
  });

  it('биография автора сохраняется и видна в карточке', async () => {
    const admin = await createTestUser({ role: 'admin' });

    const response = await uploadToCatalog(
      admin.token,
      {
        title: 'Преступление и наказание',
        author: 'Ф. М. Достоевский',
        description: 'Роман о вине и наказании',
        authorBio: 'Родился в 1821 году в Москве.',
      },
      [{ field: 'text', path: EPUB() }],
    );
    expect(response.statusCode).toBe(201);

    const card = await app.inject({
      method: 'GET',
      url: `/api/catalog/${response.json().book.id}`,
      headers: auth(admin.token),
    });
    expect(card.statusCode).toBe(200);
    expect(card.json().book.authorBio).toBe('Родился в 1821 году в Москве.');
  });

  it('биография недоступна обычной загрузке в комнату', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const uploaded = await uploadToRoom(roomId, owner.token, 'Книга');

    /*
      Биография — свойство каталога, а не книги в комнате. Если бы она
      принималась здесь, текст попал бы в общий каталог из комнаты, и админ
      правил бы его в одной записи, а читали бы все копии.
    */
    const book = await testDb.book.findUniqueOrThrow({ where: { id: uploaded.json().book.id } });
    expect(book.authorBio).toBeNull();
  });
});

describe('каталог: обложка', () => {
  it('принимается и отдаётся по стабильному адресу', async () => {
    const admin = await createTestUser({ role: 'admin' });

    const response = await uploadToCatalog(
      admin.token,
      { title: 'С обложкой', author: 'Автор' },
      [
        { field: 'text', path: EPUB() },
        { field: 'cover', path: JPEG() },
      ],
    );
    expect(response.statusCode).toBe(201);

    const bookId = response.json().book.id as string;
    const coverUrl = response.json().book.coverUrl as string;
    // Адрес не содержит пути на диск и не меняется при замене картинки:
    // расширение может быть любым.
    expect(coverUrl).toBe(`/api/books/${bookId}/cover`);

    const stored = await testDb.book.findUniqueOrThrow({ where: { id: bookId } });
    expect(stored.coverPath).toBe(join('covers', bookId, 'cover.jpg'));

    // Переадресация ведёт на раздачу файлов: она уже написана и в ней есть
    // проверка токена, дублировать её во втором месте нельзя.
    const fetched = await app.inject({
      method: 'GET',
      url: coverUrl,
      headers: auth(admin.token),
    });
    expect(fetched.statusCode).toBe(302);
    expect(fetched.headers['location']).toBe(`/files/covers/${bookId}/cover.jpg`);
  });

  it('обложки нет — адрес null, и запрос даёт 404', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const response = await uploadToCatalog(
      admin.token,
      { title: 'Без обложки', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
    );

    const bookId = response.json().book.id as string;
    expect(response.json().book.coverUrl).toBeNull();

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/books/${bookId}/cover`,
      headers: auth(admin.token),
    });
    expect(fetched.statusCode).toBe(404);
  });

  it('формат не из списка — 400', async () => {
    const admin = await createTestUser({ role: 'admin' });

    /*
      HEIC отклоняется не из любви к списку: его не показывают браузеры, и админ
      загрузил бы обложку, которой не увидит никто.
    */
    const heic = join(FIXTURES, 'cover.heic');
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(heic)}, Buffer.alloc(16))`]);

    const response = await uploadToCatalog(
      admin.token,
      { title: 'HEIC', author: 'Автор' },
      [
        { field: 'text', path: EPUB() },
        { field: 'cover', path: heic },
      ],
    );

    expect(response.statusCode).toBe(400);
    expect(await testDb.book.count()).toBe(0);
  });

  it('PNG принимается', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const response = await uploadToCatalog(
      admin.token,
      { title: 'PNG', author: 'Автор' },
      [
        { field: 'text', path: EPUB() },
        { field: 'cover', path: PNG() },
      ],
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().book.coverUrl).not.toBeNull();
  });
});

describe('каталог: поиск', () => {
  it('фильтр по автору и по наличию аудио', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await uploadToCatalog(
      admin.token,
      { title: 'Евгений Онегин', author: 'А. С. Пушкин' },
      [{ field: 'text', path: EPUB() }],
    );
    await uploadToCatalog(
      admin.token,
      { title: 'Пиковая дама', author: 'А. С. Пушкин' },
      [
        { field: 'text', path: EPUB() },
        { field: 'audio', path: MP3() },
      ],
    );
    await uploadToCatalog(
      admin.token,
      { title: 'Преступление и наказание', author: 'Ф. М. Достоевский' },
      [{ field: 'text', path: EPUB() }],
    );

    const byAuthor = await app.inject({
      method: 'GET',
      url: `/api/catalog?author=${encodeURIComponent('Пушкин')}`,
      headers: auth(admin.token),
    });
    expect(byAuthor.statusCode).toBe(200);
    expect(byAuthor.json().books).toHaveLength(2);

    const withAudio = await app.inject({
      method: 'GET',
      url: '/api/catalog?hasAudio=true',
      headers: auth(admin.token),
    });
    expect(withAudio.json().books).toHaveLength(1);
    expect(withAudio.json().books[0].title).toBe('Пиковая дама');
  });

  it('карточка книги каталога доступна, а посторонней книги — нет', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const user = await createTestUser();
    const response = await uploadToCatalog(
      admin.token,
      { title: 'Общий каталог', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
    );
    const id = response.json().book.id as string;

    const asUser = await app.inject({
      method: 'GET',
      url: `/api/catalog/${id}`,
      headers: auth(user.token),
    });
    // Каталог виден всем вошедшим — иначе он не был бы общим.
    expect(asUser.statusCode).toBe(200);

    const anonymous = await app.inject({ method: 'GET', url: `/api/catalog/${id}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('поиск книг: только свои комнаты, и по названию с автором', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const other = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: admin.user.id });
    await uploadToRoom(roomId, admin.token, 'Анна Каренина');

    // Чужая комната с той же книгой — в поиске не должна всплывать.
    const strangerRoom = await createTestRoom({ ownerId: other.user.id });
    await uploadToRoom(strangerRoom.roomId, other.token, 'Анна Каренина');

    await uploadToCatalog(
      admin.token,
      { title: 'Анна Каренина', author: 'Л. Н. Толстой' },
      [{ field: 'text', path: EPUB() }],
    );

    const q = encodeURIComponent('анна каренина');
    const mine = await app.inject({
      method: 'GET',
      url: `/api/books/search?q=${q}`,
      headers: auth(admin.token),
    });
    expect(mine.statusCode).toBe(200);

    // В каталоге книга одна, в моих комнатах — одна. Чужая комната не считается
    // моей, даже когда админ: фильтр идёт по членству, а не по роли.
    expect(mine.json().inRooms).toHaveLength(1);
    expect(mine.json().inRooms[0].roomId).toBe(roomId);
    expect(mine.json().inRooms[0].roomName).toBeTruthy();
    expect(mine.json().catalog).toHaveLength(1);

    const stranger = await app.inject({
      method: 'GET',
      url: `/api/books/search?q=${q}`,
      headers: auth(other.token),
    });
    // У второго человека своя комната с такой же книгой — она и попадает в выдачу.
    expect(stranger.json().inRooms[0].roomId).toBe(strangerRoom.roomId);
  });

  it('короткий запрос не ходит в базу', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await uploadToCatalog(
      admin.token,
      { title: 'Что угодно', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
    );

    const one = await app.inject({
      method: 'GET',
      url: '/api/books/search?q=%D0%B0',
      headers: auth(admin.token),
    });
    // На одном символе выдача совпала бы почти со всем, и человек получил бы
    // список, в котором ничего не выделяется.
    expect(one.json().inRooms).toEqual([]);
    expect(one.json().catalog).toEqual([]);

    const none = await app.inject({
      method: 'GET',
      url: '/api/books/search',
      headers: auth(admin.token),
    });
    expect(none.json().catalog).toEqual([]);
  });

  it('поиск идёт по названию и автору, а не по описанию', async () => {
    const admin = await createTestUser({ role: 'admin' });
    await uploadToCatalog(
      admin.token,
      {
        title: 'Записки из подполья',
        author: 'Ф. М. Достоевский',
        // Описание упоминает другого автора намеренно.
        description: 'В этой книге Пушкин тоже появляется.',
      },
      [{ field: 'text', path: EPUB() }],
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/books/search?q=${encodeURIComponent('пушкин')}`,
      headers: auth(admin.token),
    });
    // Иначе запрос «Пушкин» нашёл бы всё, где фамилия упомянута в аннотации.
    expect(response.json().catalog).toEqual([]);
  });
});

describe('уборка книги из комнаты', () => {
  it('владелец убирает любую книгу, и книга остаётся в каталоге', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const member = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: admin.user.id,
      memberIds: [member.user.id],
    });

    // Книгу в каталог загрузил админ, добавил в комнату участник, а убрать
    // решил владелец — права тут ни при чём, проверяется именно снятие связи.
    const catalog = await uploadToCatalog(
      admin.token,
      { title: 'Общая книга', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
    );
    const bookId = catalog.json().book.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/from-catalog`,
      headers: auth(member.token),
      payload: { catalogBookId: bookId },
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/books/${bookId}`,
      headers: auth(admin.token),
    });
    expect(removed.statusCode).toBe(200);

    expect(await testDb.roomBook.count({ where: { roomId } })).toBe(0);
    // Книга и файлы на месте: каталог не затрагивается.
    expect(await testDb.book.findUnique({ where: { id: bookId } })).not.toBeNull();
    const files = await testDb.bookFile.findFirstOrThrow({ where: { bookId } });
    expect(existsSync(join(DATA, files.filePath))).toBe(true);
  });

  it('участник убирает только свою книгу', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id, stranger.user.id],
    });

    const loaded = await uploadToRoom(roomId, member.token, 'Книга участника');
    const bookId = loaded.json().book.id as string;

    // Свою — может.
    const own = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/books/${bookId}`,
      headers: auth(member.token),
    });
    expect(own.statusCode).toBe(200);

    // Чужую — нет. Одобрение заявок не разрушает ничего, а здесь участник,
    // не грузивший книгу, снёс бы чужую работу молча.
    const other = await uploadToRoom(roomId, owner.token, 'Книга владельца');
    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/books/${other.json().book.id}`,
      headers: auth(stranger.token),
    });
    expect(denied.statusCode).toBe(403);
    expect(await testDb.roomBook.count({ where: { roomId } })).toBe(1);
  });

  it('админ убирает любую', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const loaded = await uploadToRoom(roomId, owner.token, 'Книга');
    const bookId = loaded.json().book.id as string;

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/books/${bookId}`,
      headers: auth(admin.token),
    });
    expect(removed.statusCode).toBe(200);
  });

  it('постороннему и несуществующей книге — отказ', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const loaded = await uploadToRoom(roomId, owner.token, 'Книга');
    const bookId = loaded.json().book.id as string;

    const outsider = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/books/${bookId}`,
      headers: auth(stranger.token),
    });
    expect(outsider.statusCode).toBe(403);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/books/neznay`,
      headers: auth(owner.token),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('глобальное удаление книги закрыто для участника', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const loaded = await uploadToRoom(roomId, owner.token, 'Книга');
    const bookId = loaded.json().book.id as string;

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/books/${bookId}`,
      headers: auth(owner.token),
    });
    expect(denied.statusCode).toBe(403);
    expect(await testDb.book.findUnique({ where: { id: bookId } })).not.toBeNull();
  });
});

describe('каталог: уборка из каталога', () => {
  it('книга в комнатах остаётся, флаг каталога снимается', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const { roomId } = await createTestRoom({ ownerId: admin.user.id });
    const catalog = await uploadToCatalog(
      admin.token,
      { title: 'Нужная всем', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
    );
    const bookId = catalog.json().book.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/books/from-catalog`,
      headers: auth(admin.token),
      payload: { catalogBookId: bookId },
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/catalog/${bookId}`,
      headers: auth(admin.token),
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().deleted).toBe(false);

    const book = await testDb.book.findUniqueOrThrow({ where: { id: bookId } });
    // Сама книга нужна комнате: удалять её вместе с файлами здесь нельзя.
    expect(book.isCatalog).toBe(false);
  });

  it('не админ убрать из каталога не может', async () => {
    const admin = await createTestUser({ role: 'admin' });
    const user = await createTestUser();
    const catalog = await uploadToCatalog(
      admin.token,
      { title: 'Книга', author: 'Автор' },
      [{ field: 'text', path: EPUB() }],
    );

    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/admin/catalog/${catalog.json().book.id}`,
      headers: auth(user.token),
    });
    expect(denied.statusCode).toBe(403);
  });
});