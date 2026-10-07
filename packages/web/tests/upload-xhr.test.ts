import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApiError, setToken } from '../src/api/client.js';
import { UploadAborted, uploadWithProgress, type UploadProgress } from '../src/books/upload.js';

/**
 * Загрузка через XHR: прогресс и отмена.
 *
 * ─── Почему XHR, а не fetch ─────────────────────────────────────────────────
 *
 * `fetch` не сообщает о прогрессе отправки: тело запроса отдаётся целиком и
 * сразу теряется из виду. Единственный путь, работающий одинаково в Chrome,
 * Safari и iOS Safari, — `XMLHttpRequest.upload.onprogress`.
 *
 * Проверяется подменённым `XMLHttpRequest`: в jsdom его нет, а писать собственный
 * HTTP-клиент ради проверки означало бы тестировать не тот код, что уедет к
 * человеку.
 */

/** Событие прогресса, каким его отдаёт браузер. */
class FakeProgressEvent extends Event {
  readonly loaded: number;
  readonly total: number;
  readonly lengthComputable: boolean;

  constructor(type: string, loaded: number, total: number) {
    super(type);
    this.loaded = loaded;
    this.total = total;
    this.lengthComputable = total > 0;
  }
}

/**
 * Подставной `XMLHttpRequest`.
 *
 * Отдаёт наружу всё, что нужно проверке: отправленное тело, заголовки, и способы
 * сообщить о прогрессе и завершении. Отдельно ловится `abort` — именно он
 * отвечает за отмену на стороне сервера.
 */
class FakeXhr {
  static last: FakeXhr | null = null;

  static reset(): void {
    FakeXhr.last = null;
  }

  method = '';
  url = '';
  body: FormData | null = null;
  headers: Record<string, string> = {};
  withCredentials = false;
  aborted = false;
  status = 201;
  responseText = '{"book":{"id":"b1"}}';
  responseHeaders: Record<string, string> = { 'content-type': 'application/json' };

  readonly upload = { addEventListener: (type: string, fn: (e: Event) => void) => this.#on('upload', type, fn) };
  #listeners = new Map<string, Array<(e: Event) => void>>();

  #on(scope: string, type: string, fn: (e: Event) => void): void {
    const key = `${scope}:${type}`;
    this.#listeners.set(key, [...(this.#listeners.get(key) ?? []), fn]);
  }

  #fire(scope: string, type: string, event: Event): void {
    for (const fn of this.#listeners.get(`${scope}:${type}`) ?? []) fn(event);
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    this.#on('xhr', type, fn);
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  send(body: FormData): void {
    this.body = body;
    FakeXhr.last = this;
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  /* ─── Управление из проверки ────────────────────────────────────────────── */

  /** Сообщить о прогрессе так, как это делает браузер. */
  progress(loaded: number, total: number): void {
    this.#fire('upload', 'progress', new FakeProgressEvent('progress', loaded, total));
  }

  /** Сообщить о прогрессе с неизвестным размером. */
  progressUnknownSize(loaded: number): void {
    this.#fire('upload', 'progress', new FakeProgressEvent('progress', loaded, 0));
  }

  /** Ответ сервера. */
  respond(status: number, body: string, contentType = 'application/json'): void {
    this.status = status;
    this.responseText = body;
    this.responseHeaders = { 'content-type': contentType };
    this.#fire('xhr', 'load', new Event('load'));
  }

  /** Обрыв сети. */
  fail(): void {
    this.#fire('xhr', 'error', new Event('error'));
  }

  /**
   * Отмена.
   *
   * Отдельный метод, а не `respond`: браузер при отмене не шлёт ни ответа, ни
   * ошибки — соединение просто рвётся, и сервер видит обрыв.
   */
  abort(): void {
    this.aborted = true;
    this.#fire('xhr', 'abort', new Event('abort'));
  }
}

beforeEach(() => {
  FakeXhr.reset();
  setToken('токен');
  vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

function form(): FormData {
  const f = new FormData();
  f.append('kind', 'text');
  f.append('title', 'Книга');
  f.append('file', new File(['данные'], 'книга.epub'));
  return f;
}

describe('прогресс', () => {
  it('доля считается от общего размера', async () => {
    const seen: UploadProgress[] = [];
    const upload = uploadWithProgress({
      url: '/api/rooms/r1/books/upload',
      form: form(),
      onProgress: (p) => seen.push(p),
    });

    const xhr = FakeXhr.last as FakeXhr;
    xhr.progress(512, 2048);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.loaded).toBe(512);
    expect(seen[0]?.total).toBe(2048);
    expect(seen[0]?.ratio).toBe(0.25);
    expect(seen[0]?.phase).toBe('sending');

    xhr.respond(201, '{"book":{"id":"b1"}}');
    await upload.promise;
  });

  it('при неизвестном размере доля null, а не ноль', async () => {
    const seen: UploadProgress[] = [];
    const upload = uploadWithProgress({
      url: '/api/rooms/r1/books/upload',
      form: form(),
      onProgress: (p) => seen.push(p),
    });

    const xhr = FakeXhr.last as FakeXhr;
    xhr.progressUnknownSize(999);

    /*
      Ноль означал бы «загрузка не идёт», и человек решил бы, что всё зависло.
      `null` означает «не знаю» — и шкала остаётся неподвижной, но не врёт.
    */
    expect(seen[0]?.ratio).toBeNull();
    expect(seen[0]?.total).toBeNull();
    expect(seen[0]?.loaded).toBe(999);

    xhr.respond(201, '{"book":{"id":"b1"}}');
    await upload.promise;
  });

  it('после байтов показывается, что сервер разбирает', async () => {
    const seen: UploadProgress[] = [];
    const upload = uploadWithProgress({
      url: '/api/rooms/r1/books/upload',
      form: form(),
      onProgress: (p) => seen.push(p),
    });

    const xhr = FakeXhr.last as FakeXhr;
    xhr.respond(201, '{"book":{"id":"b1"}}');
    await upload.promise;

    /*
      EPUB на двадцать мегабайт разбирается на сервере несколько секунд, и без этой
      фазы шкала стояла бы на 100% молча: человек решил бы, что всё зависло, и
      нажал бы «Отменить» на почти готовой книге.
    */
    expect(seen.at(-1)?.phase).toBe('processing');
  });
});

describe('отмена', () => {
  it('abort() рвёт запрос и отклоняет с UploadAborted', async () => {
    const upload = uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });
    const xhr = FakeXhr.last as FakeXhr;

    upload.abort();

    expect(xhr.aborted).toBe(true);
    /*
      Отмена — решение человека, а не сбой. Отдельный класс нужен, чтобы
      интерфейс не показал тост об ошибке: человек ничего не испортил, и
      «загрузка прервана» в тосте читалось бы как ошибка сервера.
    */
    await expect(upload.promise).rejects.toBeInstanceOf(UploadAborted);
  });

  it('после abort запрос рвётся, а не доходит до конца', async () => {
    const upload = uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });
    const xhr = FakeXhr.last as FakeXhr;

    upload.abort();
    await expect(upload.promise).rejects.toBeInstanceOf(UploadAborted);

    /*
      Отдельной проверки «после отмены прогресс не приходит» здесь нет: это
      поведение самого браузера, а не кода. Заглушка `XMLHttpRequest` не
      воспроизводит остановку потока, и такая проверка проверяла бы заглушку, а
      не приложение.
    */
    expect(xhr.aborted).toBe(true);
    expect(xhr.body).not.toBeNull();
  });

  it('уход со страницы прерывает загрузку', async () => {
    const upload = uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });
    const xhr = FakeXhr.last as FakeXhr;

    /*
      Промис надо поймать сразу: отмена по `pagehide` происходит сама, и без
      `catch` vitest поймал бы необработанное отклонение. В приложении его
      всегда ждёт `send()`, который на `UploadAborted` молча выходит.
    */
    const rejected = upload.promise.catch((e: unknown) => e);

    // Без этого запрос на два гигабайта продолжался бы, даже если человек закрыл
    // вкладку: браузер держит соединение, а сервер продолжает писать на диск.
    window.dispatchEvent(new Event('pagehide'));

    expect(xhr.aborted).toBe(true);
    await expect(rejected).resolves.toBeInstanceOf(UploadAborted);
  });

  it('после ответа отмена ничего не ломает', async () => {
    const upload = uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });
    const xhr = FakeXhr.last as FakeXhr;

    xhr.respond(201, '{"book":{"id":"b1"}}');
    const response = await upload.promise;
    expect(response.status).toBe(201);

    // Второй `abort` после завершения обязан быть безопасен: интерфейс зовёт отмену
    // из `finally`, и исключение оттуда ушло бы мимо `catch`.
    expect(() => upload.abort()).not.toThrow();
    // Персистентного отклонения не происходит: результат уже получен.
    await expect(upload.promise).resolves.toBe(response);
  });
});

describe('ошибки', () => {
  it('тело ошибки с сервера доходит до человека', async () => {
    const upload = uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });

    (FakeXhr.last as FakeXhr).respond(
      413,
      JSON.stringify({ error: { code: 'file_too_large', message: 'Файл больше лимита в 50 МБ' } }),
    );

    const error = await upload.promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    // «500» не говорит ни о чём, а конкретный текст сразу объясняет, что делать.
    expect((error as ApiError).message).toBe('Файл больше лимита в 50 МБ');
    expect((error as ApiError).status).toBe(413);
    expect((error as ApiError).code).toBe('file_too_large');
  });

  it('обрыв сети не выглядит как отказ сервера', async () => {
    const upload = uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });

    (FakeXhr.last as FakeXhr).fail();

    const error = (await upload.promise.catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    // Код 0 — не ответ сервера: сервер не отвечал вовсе. С таким кодом интерфейс
    // может предложить повторить, а не показывать «ошибку сервера».
    expect(error.status).toBe(0);
  });

  it('тело, которое не разобралось, не роняет разбор', async () => {
    const upload = uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });

    (FakeXhr.last as FakeXhr).respond(500, '<html>прокси ответил ошибкой</html>', 'text/html');

    const error = (await upload.promise.catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.message).toBe('Загрузка не удалась: 500');
  });
});

describe('заголовки', () => {
  it('токен уходит заголовком, Content-Type не задаётся', () => {
    uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });
    const xhr = FakeXhr.last as FakeXhr;

    expect(xhr.headers['authorization']).toBe('Bearer токен');
    /*
      Границу multipart подставляет браузер. Заголовок вручную значил бы отправить
      тело без границы, и сервер не смог бы его разобрать.
    */
    expect(xhr.headers['content-type']).toBeUndefined();
    // Cookie едет сама: раздача файлов и сессия полагаются на неё.
    expect(xhr.withCredentials).toBe(true);
  });

  it('без токена заголовка нет, но запрос всё равно уходит', () => {
    // Так устроен `fetch` во всём клиенте, и загрузка не должна отличаться: иначе
    // один и тот же отказ выглядел бы по-разному в зависимости от того, откуда
    // пришёл.
    setToken(null);
    uploadWithProgress({ url: '/api/rooms/r1/books/upload', form: form() });

    expect((FakeXhr.last as FakeXhr).headers['authorization']).toBeUndefined();
  });
});