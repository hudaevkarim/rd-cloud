import { ApiError, getToken, notifyUnauthorized } from '../api/client.js';

/**
 * Загрузка файла через XHR.
 *
 * ─── Почему XHR, а не fetch ─────────────────────────────────────────────────
 *
 * `fetch` не умеет сообщать о прогрессе отправки: он отдаёт тело запроса целиком
 * и сразу теряет его из виду. Прогресс можно получить двумя способами:
 *
 *   — `fetch` + `ReadableStream` с `duplex: 'half'`. Работает только в Chrome.
 *     В Safari и в iOS Safari `duplex: 'half'` не поддерживается, и запрос
 *     падает на старте.
 *
 *   — `XMLHttpRequest.upload.onprogress`. Работает везде, включая старые версии
 *     Safari, и это единственный путь, который одинаково выглядит во всех
 *     браузерах, которыми пользуются читатели.
 *
 * Залипшая на нуле шкала на файле в два гигабайта — это не «меньше информации»,
 * это человек, который решает, не прервать ли загрузку. Поэтому XHR, несмотря
 * на возраст.
 *
 * ─── Отмена ──────────────────────────────────────────────────────────────────
 *
 * `xhr.abort()` рвёт соединение, и сервер видит обрыв: приёмка файла убирает
 * недописанный файл вместе с его каталогом. То есть отменённая загрузка не
 * оставляет мусора на диске.
 */

/** Состояние загрузки для интерфейса. */
export interface UploadProgress {
  /** Отправлено байт. */
  loaded: number;
  /** Всего байт, если известно: поток отдаёт `total` не сразу. */
  total: number | null;
  /** Доля от 0 до 1; `null`, пока размер неизвестен. */
  ratio: number | null;
  /**
   * Фаза: `sending` — идут байты, `processing` — байты ушли, сервер разбирает.
   */
  phase: 'sending' | 'processing';
}

export interface UploadHandle {
  /** Отменить загрузку. Вызывается кнопкой «Отменить». */
  abort: () => void;
  /** Результат. Отклоняется `ApiError` или `UploadAborted`. */
  promise: Promise<Response>;
}

export interface UploadOptions {
  url: string;
  form: FormData;
  onProgress?: (progress: UploadProgress) => void;
}

/** Отмена нажатием человека: не ошибка, а его решение. */
export class UploadAborted extends Error {
  constructor() {
    super('Загрузка отменена');
    this.name = 'UploadAborted';
  }
}

/**
 * Тело ошибки разбирается всегда, даже на 500: у сервера код общий, а текст в
 * `error.message` конкретный. Человек увидит «Файл больше лимита в 50 МБ», а не
 * «500».
 */
async function toApiError(response: Response): Promise<ApiError> {
  // Форма тела берётся из самого `ApiError`: повторять объявление значило бы
  // через год получить два разных описания тела ошибки, из которых перебор
  // перестал бы работать с одной из половин.
  type ErrorBody = NonNullable<ConstructorParameters<typeof ApiError>[1]>;

  let body: ErrorBody | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
      body = (parsed as { error: ErrorBody }).error;
    }
  } catch {
    body = null;
  }
  if (response.status === 401) notifyUnauthorized();
  return new ApiError(response.status, body, `Загрузка не удалась: ${response.status}`);
}

/**
 * Отправить `FormData` с прогрессом и возможностью отмены.
 *
 * `Content-Type` не выставляется: с ним заголовок запроса не содержит границы,
 * и сервер не разберёт multipart. Браузер подставляет её сам, вместе с
 * `boundary`.
 */
export function uploadWithProgress(options: UploadOptions): UploadHandle {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<Response>((resolve, reject) => {
    let stopWatchingPage = (): void => undefined;

    xhr.upload.addEventListener('progress', (event: ProgressEvent) => {
      if (!event.lengthComputable) {
        options.onProgress?.({ loaded: event.loaded, total: null, ratio: null, phase: 'sending' });
        return;
      }
      options.onProgress?.({
        loaded: event.loaded,
        total: event.total,
        ratio: event.total === 0 ? null : event.loaded / event.total,
        phase: 'sending',
      });
    });

    xhr.addEventListener('load', () => {
      stopWatchingPage();

      /*
        Фаза «сервер разбирает»: байты уже ушли, а `load` ещё не наступил. EPUB
        на двадцать мегабайт разбирается несколько секунд, и без этой подсказки
        шкала стояла бы на 100% молча — человек решил бы, что всё зависло, и
        нажал бы «Отменить» на почти готовой книге.
      */
      options.onProgress?.({ loaded: 1, total: 1, ratio: 1, phase: 'processing' });

      void (async () => {
        // `Response` собирается вручную: конструктор умеет принимать тело, а
        // `xhr.responseText` браузер уже распарсил по content-type.
        const response = new Response(xhr.responseText ?? '', {
          status: xhr.status,
          headers: { 'content-type': xhr.getResponseHeader('content-type') ?? 'application/json' },
        });
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(response);
          return;
        }
        reject(await toApiError(response));
      })();
    });

    xhr.addEventListener('error', () => {
      stopWatchingPage();
      // Обрыв сети: не 500 и не отказ сервера, а «связи не было вовсе».
      reject(new ApiError(0, null, 'Нет связи с сервером'));
    });

    xhr.addEventListener('abort', () => {
      stopWatchingPage();
      reject(new UploadAborted());
    });

    xhr.open('POST', options.url);

    // Токен ставится заголовком: он живёт в памяти клиента, а не в cookie на
    // каждом шаге. Cookie едет сама через `withCredentials`.
    const token = getToken();
    if (token !== null) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.withCredentials = true;

    xhr.send(options.form);

    /*
      Уход со страницы во время загрузки.

      Без этого запрос на два гигабайта продолжался бы, даже если человек закрыл
      вкладку: браузер держит соединение, а сервер продолжает писать на диск.
      `pagehide` срабатывает и при закрытии вкладки, и при переходе — в отличие
      от `beforeunload`.
    */
    const onPageHide = (): void => {
      xhr.abort();
    };
    window.addEventListener('pagehide', onPageHide);
    stopWatchingPage = (): void => {
      window.removeEventListener('pagehide', onPageHide);
    };
  });

  return {
    promise,
    abort: () => {
      xhr.abort();
    },
  };
}