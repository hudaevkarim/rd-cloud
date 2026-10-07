import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SearchPage } from '../src/pages/Search.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type {
  BookHitInCatalog,
  BookHitInRoom,
  BookSearchResult,
  CurrentUser,
} from '../src/api/types.js';

/**
 * Поиск книг.
 *
 * Главное здесь — две секции. Книга из моей комнаты открывается сразу, книга из
 * каталога сначала надо добавить; смешанные в один список они читались бы как
 * «всё уже можно открыть», а половина строк была бы ложью. Проверяется именно
 * различие: разные адреса, разные подписи кнопок, разные секции.
 */

const USER: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' };

let roomsResult: BookSearchResult = { inRooms: [], catalog: [] };
let calls: string[] = [];
let handlers: Map<string, (payload: unknown) => void>;

function inRoom(over: Partial<BookHitInRoom> = {}): BookHitInRoom {
  return {
    id: 'b1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    coverUrl: null,
    hasText: true,
    hasAudio: false,
    roomId: 'r1',
    roomName: 'Классика',
    ...over,
  };
}

/**
 * Книга из каталога.
 *
 * `isCatalog: true` — литеральный тип, а не `boolean`: так объявлено в типах
 * ответа сервера, и подмена его на `false` в заглушке означала бы правку типа,
 * которую заглушка не имеет права делать.
 */
function inCatalog(over: Partial<BookHitInCatalog> = {}): BookHitInCatalog {
  return {
    id: 'b2',
    title: 'Пиковая дама',
    author: 'А. С. Пушкин',
    coverUrl: null,
    hasText: true,
    hasAudio: false,
    isCatalog: true,
    ...over,
  };
}

function storage(): Storage {
  const map = new Map<string, string>([['rd.token', 'токен']]);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

beforeEach(() => {
  calls = [];
  handlers = new Map();
  roomsResult = { inRooms: [], catalog: [] };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(`GET ${url}`);
      if (url.startsWith('/api/books/search')) return jsonResponse(roomsResult);
      if (url.startsWith('/api/rooms/search')) return jsonResponse([]);
      return jsonResponse({});
    }),
  );

  const fake = {
    emit: vi.fn(),
    connected: true,
    on: (event: string, fn: (payload: unknown) => void) => handlers.set(event, fn),
    off: () => undefined,
    removeAllListeners: () => undefined,
  };
  vi.spyOn(wsModule, 'getSocket').mockReturnValue(fake as never);
  vi.spyOn(wsModule, 'connectSocket').mockReturnValue(fake as never);

  setToken('токен');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setToken(null);
});

function renderSearch(): void {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
            <SearchPage />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Открыть вкладку «Книги». */
async function openBooksTab(u: ReturnType<typeof userEvent.setup>): Promise<void> {
  await u.click(screen.getByRole('tab', { name: 'Книги' }));
}

/** Набрать запрос и дождаться выдачи. */
async function search(u: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await u.type(screen.getByLabelText('Название или автор книги'), text);
  // Debounce 300 мс: ждать надо выдачи, а не мигания поля.
  await waitFor(
    () => {
      expect(calls.some((c) => c.includes('/api/books/search'))).toBe(true);
    },
    { timeout: 3000 },
  );
}

describe('вкладки', () => {
  it('обе вкладки на месте, по умолчанию комнаты', () => {
    renderSearch();

    expect(screen.getByRole('tab', { name: 'Комнаты' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Книги' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Комнаты' })).toHaveAttribute('aria-selected', 'true');
  });

  it('на вкладке книг поле переименовано', async () => {
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    // Метка поля повторяет, что именно ищется: «Название комнаты» в поиске книг
    // сбивало бы с толку и предлагало искать не то.
    expect(screen.getByLabelText('Название или автор книги')).toBeInTheDocument();
  });

  it('запрос не теряется при переключении вкладки', async () => {
    const u = userEvent.setup();
    renderSearch();

    await u.type(screen.getByLabelText('Название комнаты'), 'Классика');
    await openBooksTab(u);

    expect((screen.getByLabelText('Название или автор книги') as HTMLInputElement).value).toBe(
      'Классика',
    );
  });
});

describe('минимум два символа', () => {
  it('на одной букве запроса нет', async () => {
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await u.type(screen.getByLabelText('Название или автор книги'), 'П');

    expect(screen.getByRole('heading', { name: 'Что ищем?' })).toBeInTheDocument();
    // На одной букве совпадёт почти всё, и список ничего бы не выделял.
    expect(calls.some((c) => c.includes('/api/books/search'))).toBe(false);
  });

  it('на второй букве запрос уходит', async () => {
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Пу');

    expect(calls.some((c) => c.includes('q=%D0%9F%D1%83'))).toBe(true);
  });

  it('подсказка называет минимальное число букв', async () => {
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    // Человек должен понять правило до того, как наберёт вторую букву, иначе он
    // решит, что поиск сломан.
    expect(screen.getByText(/хотя бы две буквы/i)).toBeInTheDocument();
  });
});

describe('две секции', () => {
  it('книга из комнаты и книга из каталога — разные списки', async () => {
    roomsResult = { inRooms: [inRoom()], catalog: [inCatalog()] };
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Пушкин');
    await screen.findByText('Евгений Онегин');

    // Секции подписаны: по названию человек видит, что с каждой книгой можно.
    expect(screen.getByRole('heading', { name: 'В моих комнатах' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'В каталоге' })).toBeInTheDocument();
  });

  it('из комнаты ведёт сразу в читалку', async () => {
    roomsResult = { inRooms: [inRoom()], catalog: [] };
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Пушкин');
    await screen.findByText('Евгений Онегин');

    expect(screen.getByRole('link', { name: 'Читать' })).toHaveAttribute(
      'href',
      '/rooms/r1/books/b1',
    );
    // Название строки несёт в себе комнату: книга может лежать в нескольких.
    expect(screen.getByText(/Классика/)).toBeInTheDocument();
  });

  it('из каталога ведёт на страницу книги, а не в читалку', async () => {
    roomsResult = { inRooms: [], catalog: [inCatalog()] };
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Пушкин');
    await screen.findByText('Пиковая дама');

    /*
      Книгу из каталога сначала надо добавить в комнату, а для этого нужно знать,
      что это за книга. Ссылка сразу в читалку была бы ссылкой в никуда.
    */
    expect(screen.getByRole('link', { name: 'Открыть' })).toHaveAttribute('href', '/catalog/b2');
    expect(screen.queryByRole('link', { name: 'Читать' })).not.toBeInTheDocument();
  });

  it('пустая одна из секций не показывается', async () => {
    roomsResult = { inRooms: [], catalog: [inCatalog()] };
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Пушкин');
    await screen.findByText('Пиковая дама');

    // Заголовок пустой секции — шум: человек подумал бы, что там что-то есть.
    expect(screen.getByRole('heading', { name: 'В каталоге' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'В моих комнатах' })).not.toBeInTheDocument();
  });

  it('аудио без текста не обещает читалку', async () => {
    roomsResult = { inRooms: [inRoom({ hasText: false, hasAudio: true })], catalog: [] };
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Пушкин');
    await screen.findByText('Евгений Онегин');

    // Кнопка «Читать» у книги без текста была бы обещанием, которое не выполняется.
    expect(screen.queryByRole('link', { name: 'Читать' })).not.toBeInTheDocument();
    expect(screen.getByText('Аудио')).toHaveAttribute('title', 'Плеер — подэтап 7.5');
  });
});

describe('пусто', () => {
  it('«Ничего не нашлось» объясняет, где искали', async () => {
    roomsResult = { inRooms: [], catalog: [] };
    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Лермонтов');

    expect(await screen.findByRole('heading', { name: 'Ничего не нашлось' })).toBeInTheDocument();
    /*
      Сказано и где искали (в своих комнатах и в каталоге), и что именно, и про
      раскладку: в половине случаев человек ищет «Пушкин», а набирает в
      английской раскладке, и молчаливое «ничего не нашлось» его бы сбило.
    */
    const text = screen.getByText(/Ни в ваших комнатах, ни в каталоге/i);
    expect(text).toHaveTextContent('Лермонтов');
    expect(text).toHaveTextContent(/раскладк/i);
  });
});

describe('сбой', () => {
  it('отказ показывается текстом и предлагает повторить', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(`GET ${url}`);
        if (url.startsWith('/api/books/search')) {
          return jsonResponse(
            { error: { code: 'too_many_requests', message: 'Слишком часто. Подождите минуту.' } },
            429,
          );
        }
        return jsonResponse({});
      }),
    );

    const u = userEvent.setup();
    renderSearch();
    await openBooksTab(u);

    await search(u, 'Пушкин');

    // Текст с сервера, а не «Ошибка 429»: человек знает, что делать — подождать.
    expect(await screen.findByText('Слишком часто. Подождите минуту.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Попробовать снова' })).toBeInTheDocument();
  });
});