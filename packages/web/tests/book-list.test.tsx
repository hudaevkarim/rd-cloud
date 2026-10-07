import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomView } from '../src/rooms/RoomView.js';
import { BooksTab } from '../src/books/BooksTab.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type { BookSummary, CurrentUser, Room } from '../src/api/types.js';
import type { BookAddedPayload } from '../src/rooms/useRoomSocket.js';

/**
 * Список книг в комнате: обновление по сокету и права на уборку.
 *
 * Проверяется ровно то, что ломается в живом приложении: список, который не
 * обновился после чужой загрузки, и кнопка, которая у человека есть, но упрётся
 * в 403.
 */

const USER: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' };
const OWNER: CurrentUser = { ...USER, role: 'admin' };

let books: BookSummary[] = [];
let room: Room;
let user: CurrentUser = USER;
let handlers: Map<string, (payload: unknown) => void>;
let calls: string[] = [];

function book(over: Partial<BookSummary> = {}): BookSummary {
  return {
    id: 'b1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    description: null,
    authorBio: null,
    coverUrl: null,
    isCatalog: false,
    language: 'ru',
    year: 1825,
    uploadedById: 'u2',
    createdAt: '2026-01-01T00:00:00.000Z',
    hasText: true,
    hasAudio: false,
    files: [
      {
        kind: 'text',
        format: 'epub',
        fileSize: 1024,
        mimeType: 'application/epub+zip',
        durationSec: null,
        parsed: true,
        url: '/api/books/b1/file?kind=text',
      },
    ],
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
  user = USER;
  books = [book()];
  room = {
    id: 'r1',
    name: 'Классика',
    description: null,
    inviteCode: 'K3MQR7WD',
    isPublic: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerId: 'u2',
    owner: { id: 'u2', username: 'boris', displayName: 'Борис', avatar: null },
    _count: { members: 2, books: books.length },
    myRole: 'member',
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.endsWith('/books') && method === 'GET') return jsonResponse({ books });
      if (url.endsWith('/join-requests')) return jsonResponse({ requests: [] });
      if (url.endsWith('/members')) return jsonResponse({ members: [] });
      if (url.includes('/books/') && method === 'DELETE') return jsonResponse({ ok: true });
      if (url === '/api/rooms/r1') return jsonResponse({ room });
      return jsonResponse({});
    }),
  );

  // Сокет подменён целиком: проверяется обработчик страницы, а не сеть.
  const fake = {
    emit: vi.fn((_event: string, _payload?: unknown, ack?: (r: never) => void) => {
      ack?.({ ok: true, members: [] } as never);
    }),
    connected: true,
    on: (event: string, fn: (payload: unknown) => void) => handlers.set(event, fn),
    off: () => undefined,
    removeAllListeners: () => undefined,
  };
  vi.spyOn(wsModule, 'getSocket').mockReturnValue(fake as never);
  vi.spyOn(wsModule, 'connectSocket').mockReturnValue(fake as never);

  // Сокет берёт токен из памяти клиента, а не из `localStorage` напрямую.
  setToken('токен');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setToken(null);
});

/** Страница комнаты целиком: нужна подписка на сокет из `RoomView`. */
function renderRoom(): void {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/rooms/r1']}>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user })}>
            <Routes>
              <Route path="/" element={<span>Лобби</span>} />
              <Route path="/rooms/:roomId" element={<RoomView roomId="r1" />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Одна вкладка книг, без страницы комнаты. */
function renderTab(onRemoved = vi.fn()): void {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user })}>
            <BooksTab
              room={{ id: 'r1', myRole: room.myRole }}
              books={{ status: 'ready', data: books }}
              reloadBooks={onRemoved}
            />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('список', () => {
  it('показывает название, автора и бейджи форматов', () => {
    books = [book({ hasAudio: true })];
    renderTab();

    expect(screen.getByText('Евгений Онегин')).toBeInTheDocument();
    expect(screen.getByText('А. С. Пушкин')).toBeInTheDocument();
    expect(screen.getByText('Текст')).toBeInTheDocument();
    expect(screen.getByText('Аудио')).toBeInTheDocument();
  });

  it('пустой список объясняет, что делать дальше', () => {
    books = [];
    renderTab();

    expect(screen.getByRole('heading', { name: 'В комнате пока нет книг' })).toBeInTheDocument();
    expect(screen.getByText(/добавьте из общего каталога/i)).toBeInTheDocument();
  });

  it('обложка или инициалы автора', () => {
    renderTab();
    // Без обложки показываются инициалы: пустой прямоугольник читался бы как
    // «картинка не загрузилась».
    expect(document.querySelector('.cover--empty')?.textContent).toBe('АП');

    books = [book({ coverUrl: '/api/books/b1/cover' })];
    renderTab();
    expect(document.querySelectorAll('img.cover__img').length).toBeGreaterThan(0);
  });
});

describe('обновление по сокету', () => {
  it('book:added перечитывает список', async () => {
    renderRoom();
    await screen.findByText('Евгений Онегин');
    const before = calls.filter((c) => c.endsWith('/api/rooms/r1/books')).length;

    const payload: BookAddedPayload = {
      roomId: 'r1',
      book: { id: 'b2', title: 'Новая', author: 'Кто-то', coverUrl: null, hasText: true, hasAudio: false },
      addedBy: { id: 'u3', displayName: 'Гость' },
      source: 'upload',
    };
    handlers.get('book:added')?.(payload);

    // Список перечитывается, а не дополняется: в событии шесть полей, а строке
    // нужны ещё формат и размер файла.
    await waitFor(() => {
      const after = calls.filter((c) => c.endsWith('/api/rooms/r1/books')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('событие по чужой комнате игнорируется', async () => {
    renderRoom();
    await screen.findByText('Евгений Онегин');
    const before = calls.filter((c) => c.endsWith('/api/rooms/r1/books')).length;

    handlers.get('book:added')?.({
      roomId: 'чужая',
      book: { id: 'b2', title: 'Чужая', author: 'Кто-то', coverUrl: null, hasText: true, hasAudio: false },
      addedBy: { id: 'u3', displayName: 'Гость' },
      source: 'upload',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    // События приходят по всем комнатам, где человек состоит; без фильтра список
    // перечитывался бы по уведомлению не о той комнате.
    expect(calls.filter((c) => c.endsWith('/api/rooms/r1/books')).length).toBe(before);
  });

  it('book:removed перечитывает список', async () => {
    renderRoom();
    await screen.findByText('Евгений Онегин');
    const before = calls.filter((c) => c.endsWith('/api/rooms/r1/books')).length;

    handlers.get('book:removed')?.({ roomId: 'r1', bookId: 'b1' });

    await waitFor(() => {
      expect(calls.filter((c) => c.endsWith('/api/rooms/r1/books')).length).toBeGreaterThan(before);
    });
  });
});

describe('меню действий', () => {
  it('меню закрывается по Escape и по клику вне', async () => {
    const u = userEvent.setup();
    renderTab();

    await u.click(screen.getByLabelText(/Действия с книгой/));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await u.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await u.click(screen.getByLabelText(/Действия с книгой/));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await u.click(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('владельцу комнаты видна уборка любой книги', async () => {
    room.myRole = 'owner';
    const u = userEvent.setup();
    renderTab();

    await u.click(screen.getByLabelText(/Действия с книгой/));
    // Книга загружена другим человеком, но владелец комнаты убирает любую.
    expect(screen.getByRole('menuitem', { name: 'Убрать из комнаты' })).toBeInTheDocument();
  });

  it('участнику уборка чужой книги недоступна вовсе', async () => {
    const u = userEvent.setup();
    renderTab();

    await u.click(screen.getByLabelText(/Действия с книгой/));
    /*
      Кнопки нет, а не отключена: человек, которому нельзя, не должен видеть
      действие, которое упрётся в 403.
    */
    expect(screen.queryByRole('menuitem', { name: 'Убрать из комнаты' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Скачать' })).toBeInTheDocument();
  });

  it('загрузившему видна уборка своей книги', async () => {
    user = { ...USER, id: 'u2' };
    const u = userEvent.setup();
    renderTab();

    await u.click(screen.getByLabelText(/Действия с книгой/));
    expect(screen.getByRole('menuitem', { name: 'Убрать из комнаты' })).toBeInTheDocument();
  });

  it('уборка зовёт снятие связи, а не глобальное удаление', async () => {
    const u = userEvent.setup();
    const onRemoved = vi.fn();
    user = { ...USER, id: 'u2' };
    renderTab(onRemoved);

    await u.click(screen.getByLabelText(/Действия с книгой/));
    await u.click(screen.getByRole('menuitem', { name: 'Убрать из комнаты' }));

    await waitFor(() => {
      expect(calls).toContain('DELETE /api/rooms/r1/books/b1');
    });
    // Глобальное удаление — только админское, и в комнате его звать нельзя: книга
    // из каталога лежит сразу во многих комнатах.
    expect(calls.some((c) => c === 'DELETE /api/books/b1')).toBe(false);
    expect(onRemoved).toHaveBeenCalled();
  });
});

describe('админ', () => {
  it('админу видна уборка книги чужой комнаты', async () => {
    user = OWNER;
    const u = userEvent.setup();
    renderTab();

    await u.click(screen.getByLabelText(/Действия с книгой/));
    expect(screen.getByRole('menuitem', { name: 'Убрать из комнаты' })).toBeInTheDocument();
  });
});