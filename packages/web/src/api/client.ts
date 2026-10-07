import type {
  AdminStats,
  AdminUser,
  ApiErrorBody,
  BookIndex,
  BookSummary,
  BookSearchResult,
  ChapterBlock,
  CommentCounts,
  CommentPage,
  CurrentUser,
  JoinRequest,
  ReactionEmoji,
  Room,
  RoomMember,
  RoomSearchHit,
  RoomSummary,
  WireComment,
} from './types.js';

/**
 * Клиент REST API.
 *
 * ─── Почему базовый URL пустой ───────────────────────────────────────────────
 *
 * Запросы идут на относительные пути: в разработке Vite проксирует `/api` на
 * `:3000`, в продакшене оба хоста за одним доменом. Абсолютный URL означал бы
 * два разных адреса в двух режимах, а относительный работает в обоих — и,
 * что важнее, одинаково с `credentials: 'include'`, поэтому cookie
 * `rd_token` едет сама.
 *
 * ─── Ошибка ──────────────────────────────────────────────────────────────────
 *
 * Тело ошибки разбирается всегда, даже когда статус 500: у сервера код ответа
 * общий, а текст в `error.message` конкретный. Человек увидит «Файл больше
 * лимита в 50 МБ», а не «500».
 */

const BASE = '/api';

/**
 * Токен в памяти.
 *
 * Нужен для заголовка `Authorization` — cookie едет сама, но запросы из тестов
 * и из мест, где cookie ещё не поставлена, полагаются на заголовок. В
 * `localStorage` токен тоже лежит: после перезагрузки страницы cookie может
 * быть ещё не восстановлена, а запрос `/api/auth/me` должен уйти сразу.
 */
let bearer: string | null = null;

export function setToken(token: string | null): void {
  bearer = token;
}

export function getToken(): string | null {
  return bearer;
}

/** Вызывается при 401: страница уйдёт на `/login`. */
type UnauthorizedHandler = () => void;

let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  onUnauthorized = fn;
}

/**
 * Сообщить, что сервер отверг сессию.
 *
 * Отдельная функция, потому что 401 приходит из двух мест: `request` и загрузка
 * файла через XHR, у которой свой транспорт. Повторять проверку в обоих значило
 * бы написать одно и то же дважды, и забытая копия обернулась бы не ошибкой в
 * обработчике запроса, а тихим «сессия пропала, интерфейс не заметил».
 */
export function notifyUnauthorized(): void {
  bearer = null;
  onUnauthorized?.();
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, body: ApiErrorBody['error'] | null, fallback: string) {
    super(body?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code ?? 'unknown';
    this.details = body?.details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** `FormData` уходит как есть: браузер сам ставит границу multipart. */
  formData?: FormData;
  signal?: AbortSignal;
}

/**
 * Один запрос.
 *
 * `res.ok` проверяется до разбора: иначе попытка разобрать HTML-страницу
 * ошибки как JSON дала бы `SyntaxError` вместо внятного сообщения.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (bearer !== null) headers['authorization'] = `Bearer ${bearer}`;

  let body: BodyInit | undefined;
  if (options.formData !== undefined) {
    // Границу не задаём: `Content-Type` с ней отсутствует, и сервер сам
    // расставит `multipart/form-data; boundary=…`.
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
    // Cookie едет только с `include`: без него cross-origin запросы идут без
    // cookie, а в разработке это ровно тот случай, который прокси и снимает.
    credentials: 'include',
    signal: options.signal,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = (parsed as ApiErrorBody | null)?.error ?? null;

    // 401 обрабатывается один раз и в одном месте: иначе каждый вызывающий
    // писал бы свой редирект, и один забытый дал бы «сессия молча истекла, но
    // интерфейс этого не заметил».
    if (response.status === 401) {
      bearer = null;
      onUnauthorized?.();
    }

    throw new ApiError(response.status, body, `Запрос не удался: ${response.status}`);
  }

  return parsed as T;
}

/** Сборка query-строки. `undefined` и `null` пропускаются, `0` и `''` — нет. */
function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

// ─── Аутентификация ──────────────────────────────────────────────────────────

export const auth = {
  /** Вход по токену. Сервер ставит cookie `rd_token` в ответ. */
  async login(token: string): Promise<CurrentUser> {
    const body = await request<{ user: CurrentUser }>('/auth/login', {
      method: 'POST',
      body: { token },
    });
    setToken(token);
    return body.user;
  },

  /** Текущий пользователь. 401 — значит, токен недействителен. */
  me(signal?: AbortSignal): Promise<{ user: CurrentUser }> {
    return request('/auth/me', { signal });
  },

  async logout(): Promise<void> {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      // Токен сбрасывается даже если запрос не прошёл: оставить его в памяти
      // после выхода значило бы показать интерфейс вошедшего пользователя
      // человеку, который вышел.
      setToken(null);
    }
  },
};

// ─── Комнаты ──────────────────────────────────────────────────────────────────

export type { RoomSummary } from './types.js';

export const rooms = {
  async list(): Promise<RoomSummary[]> {
    return (await request<{ rooms: RoomSummary[] }>('/rooms')).rooms;
  },

  async create(payload: {
    name: string;
    description?: string;
    isPublic?: boolean;
  }): Promise<RoomSummary> {
    return (await request<{ room: RoomSummary }>('/rooms', { method: 'POST', body: payload })).room;
  },

  async search(q: string): Promise<RoomSearchHit[]> {
    const trimmed = q.trim();
    if (trimmed === '') return [];
    return (await request<{ rooms: RoomSearchHit[] }>(`/rooms/search${query({ q: trimmed })}`)).rooms;
  },

  /** Вход по коду приглашения. */
  async joinByCode(inviteCode: string): Promise<{ roomId: string; joined: boolean }> {
    return request('/rooms/join-by-code', { method: 'POST', body: { inviteCode } });
  },

  async get(id: string): Promise<Room> {
    return (await request<{ room: Room }>(`/rooms/${id}`)).room;
  },

  async update(
    id: string,
    payload: { name?: string; description?: string | null; isPublic?: boolean },
  ): Promise<RoomSummary> {
    return (await request<{ room: RoomSummary }>(`/rooms/${id}`, { method: 'PATCH', body: payload }))
      .room;
  },

  async remove(id: string): Promise<void> {
    await request(`/rooms/${id}`, { method: 'DELETE' });
  },

  async leave(id: string): Promise<{ left: boolean; roomDeleted: boolean }> {
    return request(`/rooms/${id}/leave`, { method: 'POST' });
  },

  async members(id: string): Promise<RoomMember[]> {
    return (await request<{ members: RoomMember[] }>(`/rooms/${id}/members`)).members;
  },

  async invite(id: string, userId: string): Promise<{ joined: boolean }> {
    return request(`/rooms/${id}/invite`, { method: 'POST', body: { userId } });
  },

  async requestJoin(id: string): Promise<{ id: string }> {
    return (await request<{ request: { id: string } }>(`/rooms/${id}/join-request`, { method: 'POST' }))
      .request;
  },

  async joinRequests(id: string): Promise<JoinRequest[]> {
    return (await request<{ requests: JoinRequest[] }>(`/rooms/${id}/join-requests`)).requests;
  },

  async approveJoin(id: string, requestId: string): Promise<void> {
    await request(`/rooms/${id}/join-requests/${requestId}/approve`, { method: 'POST' });
  },

  async rejectJoin(id: string, requestId: string): Promise<void> {
    await request(`/rooms/${id}/join-requests/${requestId}/reject`, { method: 'POST' });
  },

  /** Исключение участника. Только владелец, не себя. */
  async removeMember(id: string, userId: string): Promise<void> {
    await request(`/rooms/${id}/members/${userId}`, { method: 'DELETE' });
  },
};

/**
 * Число вместе со склонённым словом: `3 участника`.
 *
 * Возвращает строку целиком, а не только слово. Сначала было наоборот, и число
 * пропадало: в лобби показывалось «участника · книги» без количества. Выводить
 * само число отдельно значило бы разорвать пару «3 участника» на два узла, и
 * поиск по тексту в тестах перестал бы работать.
 *
 * Правило русского языка описывает ветку ниже: последние две цифры 11–14 дают
 * «многие», хотя единственное число 11 — одиннадцать, то есть одно. Без этой
 * ветки «11 участника» читалось бы как ошибка.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = Math.abs(n) % 10;

  const word = mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many;

  return `${n} ${word}`;
}

// ─── Книги ────────────────────────────────────────────────────────────────────

export const books = {
  async listInRoom(roomId: string): Promise<BookSummary[]> {
    return (await request<{ books: BookSummary[] }>(`/rooms/${roomId}/books`)).books;
  },

  async get(id: string): Promise<BookSummary> {
    return (await request<{ book: BookSummary }>(`/books/${id}`)).book;
  },

  /**
   * Адрес файла книги.
   *
   * Два шага, а не прямая ссылка: у `/files/**` есть проверка токена, а книга
   * может лежать в закрытой комнате. Адрес сервер отдаёт только после того, как
   * убедился, что человек в комнате.
   *
   * Расширение приходит вместе с адресом: оно нужно для имени скачанного файла,
   * а разбирать путь на клиенте — значит зависеть от того, как он устроен.
   */
  async fileInfo(
    id: string,
    kind: 'text' | 'audio',
  ): Promise<{ url: string; fileNameExtension: string }> {
    const body = await request<{ url: string; mimeType: string }>(`/books/${id}/file${query({ kind })}`);
    const tail = body.url.split('/').pop() ?? '';
    const dot = tail.lastIndexOf('.');
    return { url: body.url, fileNameExtension: dot === -1 ? '' : tail.slice(dot + 1) };
  },

  /** Оглавление. Отдаётся как есть, без обёртки, — клиент кэширует им. */
  async index(bookId: string, signal?: AbortSignal): Promise<BookIndex> {
    return request(`/books/${bookId}/index.json`, { signal });
  },

  /** Одна глава. */
  async chapter(bookId: string, n: number, signal?: AbortSignal): Promise<ChapterBlock[]> {
    return request(`/books/${bookId}/ch/${n}.json`, { signal });
  },

  /**
   * Добавить книгу из каталога в комнату.
   *
   * `added: false` — не ошибка: книга уже в комнате, и второй раз её добавлять
   * незачем. Интерфейс различает это и говорит «уже там», а не «ошибка».
   */
  async addFromCatalog(roomId: string, catalogBookId: string): Promise<{ added: boolean }> {
    return request(`/rooms/${roomId}/books/from-catalog`, {
      method: 'POST',
      body: { catalogBookId },
    });
  },

  /**
   * Поиск книг: в своих комнатах и в каталоге.
   *
   * Один адрес, а не «взять список комнат, потом запросить каждую»: при пяти
   * комнатах это шесть запросов на каждый ввод, и каждый ходил бы по книгам этой
   * комнаты. Здесь одна выборка отдаёт обе секции.
   *
   * `signal` обязателен по той же причине, что и у поиска комнат: без отмены
   * медленный ответ на «ан» перезаписал бы точный на «анна».
   */
  searchBooks(q: string, signal?: AbortSignal): Promise<BookSearchResult> {
    return request(`/books/search${query({ q })}`, { signal });
  },

  /**
   * Загрузка файла в комнату: собирает тело, но не отправляет.
   *
   * Порядок частей обязателен: сервер читает multipart одним проходом и узнаёт
   * `kind` только из полей, пришедших раньше файла. `FormData` сохраняет
   * порядок добавления, поэтому поля добавляются первыми — иначе сервер откажет
   * с 400.
   *
   * Возвращается тело, а не выполняется запрос: отправка идёт через
   * `uploadWithProgress`, у которой есть прогресс и отмена, а у `fetch` их нет.
   */
  buildUploadForm(
    file: File,
    meta: {
      kind: 'text' | 'audio';
      format: string;
      title: string;
      author: string;
      description?: string;
      language?: string;
      year?: number;
    },
  ): FormData {
    const form = new FormData();
    form.append('kind', meta.kind);
    form.append('format', meta.format);
    form.append('title', meta.title);
    form.append('author', meta.author);
    if (meta.description !== undefined) form.append('description', meta.description);
    if (meta.language !== undefined) form.append('language', meta.language);
    if (meta.year !== undefined) form.append('year', String(meta.year));
    form.append('file', file, file.name);

    return form;
  },

  /**
   * Убрать книгу из комнаты.
   *
   * Снимается связь, а сама книга остаётся: книга из каталога принадлежит не
   * этой комнате, и удаление здесь снесло бы её у всех, кто её добавил.
   */
  async removeFromRoom(roomId: string, bookId: string): Promise<void> {
    await request(`/rooms/${roomId}/books/${bookId}`, { method: 'DELETE' });
  },
};

/**
 * Фильтры каталога.
 *
 * `author` и `hasAudio` — не украшение: без них список классики на двести книг
 * пришлось бы просматривать глазами, а человек ищет «всё Пушкина, где есть
 * аудио», и это два конкретных вопроса.
 */
export interface CatalogFilters {
  q?: string;
  author?: string;
  hasAudio?: boolean;
}

export const catalog = {
  async list(params: CatalogFilters = {}): Promise<BookSummary[]> {
    const search = query({
      q: params.q,
      author: params.author,
      // Флаг передаётся строкой `true`, а не булевым: `query` отбрасывает
      // `undefined`, а `String(false)` дало бы подстроку «false» — и фильтр
      // оказался бы включён вместо выключенного.
      hasAudio: params.hasAudio === true ? 'true' : undefined,
    });
    return (await request<{ books: BookSummary[] }>(`/catalog${search}`)).books;
  },

  async get(id: string): Promise<BookSummary> {
    return (await request<{ book: BookSummary }>(`/catalog/${id}`)).book;
  },

  /**
   * Убрать книгу из каталога.
   *
   * Отдельный метод, а не `books.remove`: тот сносит книгу целиком, а этот снимает
   * флаг каталога и, если книга нигде не лежит, удаляет её с файлами. Два разных
   * действия не должны выглядеть как одно.
   */
  async removeFromCatalog(id: string): Promise<{ deleted: boolean }> {
    return request(`/admin/catalog/${id}`, { method: 'DELETE' });
  },
};

// ─── Комментарии ─────────────────────────────────────────────────────────────

export interface CreateCommentPayload {
  text: string;
  bookFileKind: 'text' | 'audio';
  anchor: unknown;
  parentId?: string;
  isSpoiler?: boolean;
}

export const comments = {
  async list(
    roomId: string,
    bookId: string,
    params: { chapter?: number; cursor?: string; limit?: number; anchorType?: string } = {},
  ): Promise<CommentPage> {
    return request(`/rooms/${roomId}/books/${bookId}/comments${query({ ...params })}`);
  },

  async counts(roomId: string, bookId: string): Promise<CommentCounts> {
    return request(`/rooms/${roomId}/books/${bookId}/comments/count`);
  },

  async create(roomId: string, bookId: string, payload: CreateCommentPayload): Promise<WireComment> {
    return (
      await request<{ comment: WireComment }>(`/rooms/${roomId}/books/${bookId}/comments`, {
        method: 'POST',
        body: payload,
      })
    ).comment;
  },

  async update(id: string, text: string): Promise<WireComment> {
    return (await request<{ comment: WireComment }>(`/comments/${id}`, { method: 'PATCH', body: { text } }))
      .comment;
  },

  async remove(id: string): Promise<void> {
    await request(`/comments/${id}`, { method: 'DELETE' });
  },

  /** Toggle: поставили — сняли, одним вызовом. */
  async react(id: string, emoji: ReactionEmoji): Promise<{ active: boolean; comment: WireComment }> {
    return request(`/comments/${id}/reactions`, { method: 'POST', body: { emoji } });
  },
};

// ─── Админка ─────────────────────────────────────────────────────────────────

export const admin = {
  async users(): Promise<AdminUser[]> {
    return (await request<{ users: AdminUser[] }>('/admin/users')).users;
  },

  async createUser(payload: { username: string; displayName?: string; role?: 'user' | 'admin' }): Promise<{
    user: AdminUser;
    token: string;
  }> {
    return request('/admin/users', { method: 'POST', body: payload });
  },

  async deleteUser(id: string): Promise<void> {
    await request(`/admin/users/${id}`, { method: 'DELETE' });
  },

  async rooms(): Promise<RoomSummary[]> {
    return (await request<{ rooms: RoomSummary[] }>('/admin/rooms')).rooms;
  },

  async deleteRoom(id: string): Promise<void> {
    await request(`/admin/rooms/${id}`, { method: 'DELETE' });
  },

  async stats(): Promise<AdminStats> {
    return (await request<{ stats: AdminStats }>('/admin/stats')).stats;
  },

  /** Удаление из каталога. */
  async removeFromCatalog(id: string): Promise<{ deleted: boolean }> {
    return request(`/admin/catalog/${id}`, { method: 'DELETE' });
  },
};
