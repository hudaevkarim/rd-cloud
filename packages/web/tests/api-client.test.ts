import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  admin,
  auth,
  books,
  catalog,
  comments,
  rooms,
  setToken,
  setUnauthorizedHandler,
} from '../src/api/client.js';
import { jsonResponse, errorResponse } from './setup.js';

/**
 * Клиент REST.
 *
 * ─── Что здесь проверяется ───────────────────────────────────────────────────
 *
 * 1. Обработку 401: один раз и в одном месте. Если бы она жила в каждом
 *    вызывающем, один забытый дал бы «сессия молча истекла».
 * 2. Текст ошибки с сервера: «Файл больше лимита в 50 МБ» полезнее «500».
 * 3. Порядок частей в `FormData`: сервер читает multipart одним проходом и
 *    узнаёт `kind` только из полей, пришедших раньше файла. Поля добавлены
 *    первыми — иначе загрузка отвергалась бы с 400.
 * 4. `credentials: 'include'`: без него cookie в разработке не поедет, и весь
 *    обход через прокси окажется бесполезным.
 */

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  setToken(null);
  setUnauthorizedHandler(null);
});

afterEach(() => {
  setToken(null);
  setUnauthorizedHandler(null);
});

/** Последний вызов `fetch`: удобно для проверки заголовков и тела. */
function lastCall(): [string, RequestInit] {
  const mock = fetch as unknown as ReturnType<typeof vi.fn>;
  const calls = mock.mock.calls;
  const last = calls[calls.length - 1];
  if (last === undefined) throw new Error('fetch не вызывался');
  return last as [string, RequestInit];
}

function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe('401', () => {
  it('вызывает обработчик и сбрасывает токен', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, 'unauthorized', 'Нет')));
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    setToken('токен');

    await expect(auth.me()).rejects.toBeInstanceOf(ApiError);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('ошибка несёт код и текст сервера', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(413, 'file_too_large', 'Файл больше лимита в 50 МБ')),
    );

    const error = await books
      .upload('комната', new File(['x'], 'a.epub'), {
        kind: 'text',
        format: 'epub',
        title: 'Книга',
        author: 'Автор',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    // Текст с сервера доходит до человека: «500» не говорит ни о чём, а
    // «Файл больше лимита» сразу объясняет, что делать.
    expect((error as ApiError).message).toBe('Файл больше лимита в 50 МБ');
    expect((error as ApiError).status).toBe(413);
    expect((error as ApiError).code).toBe('file_too_large');
  });

  it('ошибка без разбираемого тела не роняет разбор', async () => {
    // Прокси или балансировщик может ответить HTML, а не JSON. Сообщение об
    // ошибке разбора JSON здесь означало бы «SyntaxError» вместо «500».
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('<html>502</html>', 502)));

    const error = await auth.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('502');
  });
});

describe('заголовки', () => {
  it('токен уходит и заголовком, и cookie', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ user: null })));
    setToken('секретный-токен');

    await auth.me();

    const [url, init] = lastCall();
    expect(url).toBe('/api/auth/me');
    expect(headersOf(init)['authorization']).toBe('Bearer секретный-токен');
    // Без `include` cookie в разработке не поедет: запрос кросс-оригинальный
    // или проксированный, и браузер cookie без явного разрешения не шлёт.
    expect(init.credentials).toBe('include');
  });

  it('без токена заголовка authorization нет', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ user: null })));
    await auth.me();
    expect(headersOf(lastCall()[1])['authorization']).toBeUndefined();
  });

  it('тело запроса помечается json', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));

    await rooms.create({ name: 'Классика' });

    const init = lastCall()[1];
    expect(headersOf(init)['content-type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });
});

describe('выход', () => {
  it('токен сбрасывается даже когда сервер недоступен', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть недоступна')));
    setToken('токен');

    await expect(auth.logout()).rejects.toThrow();
    // Оставить токен в памяти после неудачного выхода — значит показать
    // интерфейс вошедшего человеку, который вышел.
    expect(headersOf(lastCall()[1])['authorization']).toBe('Bearer токен');
  });

  it('успешный выход чистит токен', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    setToken('токен');

    await auth.logout();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ user: null })));
    await auth.me();
    // Заголовка нет: токен сброшен.
    expect(headersOf(lastCall()[1])['authorization']).toBeUndefined();
  });
});

describe('загрузка файла', () => {
  it('поля идут раньше файла', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ book: { id: 'b1' } })));

    await books.upload('комната', new File(['данные'], 'книга.epub', { type: 'application/epub+zip' }), {
      kind: 'text',
      format: 'epub',
      title: 'Название',
      author: 'Автор',
    });

    const form = lastCall()[1].body as FormData;
    const names = [...form.keys()];

    // Сервер читает multipart одним проходом и узнаёт `kind` только из полей,
    // пришедших раньше файла. Файл раньше полей означал бы 400.
    expect(names.indexOf('kind')).toBeLessThan(names.indexOf('file'));
    expect(names.indexOf('format')).toBeLessThan(names.indexOf('file'));
    expect(names).toContain('title');
    expect(names).toContain('author');
  });

  it('Content-Type не задаётся вручную', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ book: { id: 'b1' } })));

    await books.upload('комната', new File(['x'], 'a.mp3'), {
      kind: 'audio',
      format: 'mp3',
      title: 'Аудио',
      author: 'Автор',
    });

    // Граница multipart ставится браузером. Задать заголовок вручную значило бы
    // отправить тело без границы, и сервер не смог бы его разобрать.
    expect(headersOf(lastCall()[1])['content-type']).toBeUndefined();
  });

  it('пустое необязательное поле не отправляется', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ book: { id: 'b1' } })));

    await books.upload('комната', new File(['x'], 'a.epub'), {
      kind: 'text',
      format: 'epub',
      title: 'Название',
      author: 'Автор',
    });

    const form = lastCall()[1].body as FormData;
    // Пустая строка в поле означала бы «описание равно пустой строке», а не
    // «описания нет»: сервер их различает.
    expect(form.has('description')).toBe(false);
    expect(form.has('year')).toBe(false);
  });
});

describe('query-строки', () => {
  it('пустой поиск не ходит на сервер', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ rooms: [] }));
    vi.stubGlobal('fetch', mock);

    // Строка из одних пробелов — частый результат: человек стёр запрос.
    // Запрос на сервер в таком случае вернул бы все комнаты подряд.
    expect(await rooms.search('   ')).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it('кириллица кодируется', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ rooms: [] })));
    await rooms.search('анна');
    // Без кодирования необработанная кириллица доезжает до сервера как
    // latin1 и не совпадает с UTF-8 в базе: поиск молча вернул бы пустоту.
    expect(lastCall()[0]).toContain('%D0%B0%D0%BD%D0%BD%D0%B0');
  });

  it('нулевые значения не отбрасываются', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ comments: [] })));
    await comments.list('комната', 'книга', { chapter: 0, limit: 50 });
    // `0` — полноценное значение. Отбрасывание по «ложности» отсекло бы
    // главу 0, то есть самый первый экран книги.
    expect(lastCall()[0]).toContain('chapter=0');
  });
});

describe('разделы API', () => {
  it('все методы собирают ожидаемые адреса', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', mock);

    await rooms.list();
    await rooms.get('r1');
    await rooms.members('r1');
    await rooms.leave('r1');
    await books.listInRoom('r1');
    await books.get('b1');
    await books.index('b1');
    await books.chapter('b1', 3);
    await catalog.list({ q: 'Пушкин' });
    await comments.counts('r1', 'b1');
    await admin.users();
    await admin.stats();

    const urls = mock.mock.calls.map((call) => (call as [string])[0]);
    expect(urls).toContain('/api/rooms');
    expect(urls).toContain('/api/rooms/r1');
    expect(urls).toContain('/api/rooms/r1/members');
    expect(urls).toContain('/api/rooms/r1/leave');
    expect(urls).toContain('/api/rooms/r1/books');
    expect(urls).toContain('/api/books/b1');
    expect(urls).toContain('/api/books/b1/index.json');
    // Номер главы в адресе, а не в теле: адрес видно в логах и в кеше.
    expect(urls).toContain('/api/books/b1/ch/3.json');
    expect(urls).toContain('/api/rooms/r1/books/b1/comments/count');
    expect(urls).toContain('/api/admin/users');
    expect(urls).toContain('/api/admin/stats');
  });

  it('реакция — toggle одним вызовом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ active: true, comment: {} })));
    await comments.react('c1', '👍');

    const [url, init] = lastCall();
    expect(url).toBe('/api/comments/c1/reactions');
    expect(init.method).toBe('POST');
  });
});

describe('204 без тела', () => {
  it('возвращает undefined, а не падает на разборе', async () => {
    // `DELETE` возвращает `{ ok: true }`, но в будущем сервер может ответить
    // 204, и тогда тело пустое. `JSON.parse('')` бросил бы исключение.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' } as Response),
    );
    await expect(comments.remove('c1')).resolves.toBeUndefined();
  });
});
