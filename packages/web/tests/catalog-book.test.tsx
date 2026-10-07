import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CatalogBookPage } from '../src/pages/CatalogBook.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type { BookFileSummary, BookSummary, CurrentUser } from '../src/api/types.js';

/**
 * Страница книги в каталоге.
 *
 * Проверяется то, в чём человек принимает решение: обложка, форматы с
 * длительностью, описание, биография автора и выбор комнаты.
 */

const USER: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' };

let book: BookSummary;
let rooms: Array<{ id: string; name: string }> = [];
let calls: string[] = [];
/** Ответ `from-catalog` для следующего добавления. */
let addResult = { added: true };

function file(over: Partial<BookFileSummary> = {}): BookFileSummary {
  return {
    kind: 'text',
    format: 'epub',
    fileSize: 1024,
    mimeType: 'application/epub+zip',
    durationSec: null,
    parsed: true,
    url: '/api/books/b1/file?kind=text',
    ...over,
  };
}

function makeBook(over: Partial<BookSummary> = {}): BookSummary {
  return {
    id: 'b1',
    title: 'Мастер и Маргарита',
    author: 'М. А. Булгаков',
    description: 'Роман о договоре между писателем и дьяволом.',
    authorBio: 'Михаил Афанасьевич Булгаков (1891—1940).',
    coverUrl: null,
    isCatalog: true,
    language: 'ru',
    year: 1967,
    uploadedById: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    hasText: true,
    hasAudio: false,
    files: [file()],
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
  addResult = { added: true };
  book = makeBook();
  rooms = [
    { id: 'r1', name: 'Классика' },
    { id: 'r2', name: 'Настольная' },
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/catalog/b1') return jsonResponse({ book });
      if (url === '/api/rooms') return jsonResponse({ rooms });
      if (url.includes('/from-catalog')) return jsonResponse(addResult, addResult.added ? 201 : 200);
      return jsonResponse({});
    }),
  );

  const fake = {
    emit: vi.fn(),
    connected: true,
    on: () => undefined,
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

function renderPage(): void {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/catalog/b1']}>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
            <Routes>
              <Route path="/catalog/:bookId" element={<CatalogBookPage />} />
              <Route path="/catalog" element={<span>Список каталога</span>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('страница книги', () => {
  it('название, автор, год, описание и биография', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Мастер и Маргарита' })).toBeInTheDocument();
    expect(screen.getByText('М. А. Булгаков')).toBeInTheDocument();
    expect(screen.getByText('1967')).toBeInTheDocument();
    // Биография автора — половина смысла отдельной страницы: по названию из
    // поиска непонятно, кто это и о чём книга.
    expect(screen.getByText('Михаил Афанасьевич Булгаков (1891—1940).')).toBeInTheDocument();
  });

  it('обложка или инициалы автора', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });
    expect(document.querySelector('.cover--empty')?.textContent).toBe('МБ');

    book = makeBook({ coverUrl: '/api/books/b1/cover' });
    renderPage();
    await waitFor(() => {
      expect(document.querySelector('img.cover__img')?.getAttribute('src')).toBe('/api/books/b1/cover');
    });
  });

  it('форматы перечислены рядом с бейджами «Текст» и «Аудио»', async () => {
    book = makeBook({
      hasAudio: true,
      files: [file(), file({ kind: 'audio', format: 'mp3', durationSec: 26 * 3600, mimeType: 'audio/mpeg' })],
    });
    renderPage();

    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });
    expect(screen.getByText('Текст')).toBeInTheDocument();
    expect(screen.getByText('Аудио')).toBeInTheDocument();
    expect(screen.getByText('EPUB')).toBeInTheDocument();
    // Часы, а не «1560 мин»: человек решает, потянет ли он книгу за вечер.
    expect(screen.getByText('MP3 · 26 ч')).toBeInTheDocument();
  });

  it('короткая запись показывает секунды, а не «0 мин»', async () => {
    book = makeBook({
      hasAudio: true,
      files: [file(), file({ kind: 'audio', format: 'mp3', durationSec: 26, mimeType: 'audio/mpeg' })],
    });
    renderPage();

    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });
    /*
      Округление до минут превращало короткую запись в «0 мин»: человек, который
      выбирает между книгами, видел бы ноль вместо ответа на вопрос «сколько
      это слушать».
    */
    expect(screen.getByText('MP3 · 26 с')).toBeInTheDocument();
    expect(screen.queryByText(/0 мин/)).not.toBeInTheDocument();
  });

  it('без обложки и без аудио кнопка «Слушать» не обещана', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });

    // У книги нет аудио, и кнопка «Слушать» была бы обещанием, которое не
    // выполняется: плеер появится только в 7.5.
    expect(screen.queryByRole('link', { name: 'Слушать' })).not.toBeInTheDocument();
  });
});

describe('добавление в комнату со страницы книги', () => {
  it('окно со списком комнат', async () => {
    const u = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });

    await u.click(screen.getByRole('button', { name: 'Добавить в комнату' }));

    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Классика')).toBeInTheDocument();
    expect(within(dlg).getByText('Настольная')).toBeInTheDocument();
  });

  it('добавление зовёт from-catalog и говорит тостом', async () => {
    const u = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });

    await u.click(screen.getByRole('button', { name: 'Добавить в комнату' }));
    const dlg = await screen.findByRole('dialog');
    await u.click(within(dlg).getAllByRole('button', { name: 'Добавить' })[0] as HTMLElement);

    await waitFor(() => {
      expect(calls).toContain('POST /api/rooms/r1/books/from-catalog');
    });
    expect(await screen.findByText(/Добавлено в «Классика»/)).toBeInTheDocument();
  });

  it('«уже есть» — не ошибка', async () => {
    addResult = { added: false };
    const u = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });

    await u.click(screen.getByRole('button', { name: 'Добавить в комнату' }));
    const dlg = await screen.findByRole('dialog');
    await u.click(within(dlg).getAllByRole('button', { name: 'Добавить' })[0] as HTMLElement);

    // «Добавлено» при `added: false` было бы неправдой: книга уже стояла.
    expect(await screen.findByText(/уже есть/)).toBeInTheDocument();
  });

  it('нет комнат — предложение создать', async () => {
    rooms = [];
    const u = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'Мастер и Маргарита' });

    await u.click(screen.getByRole('button', { name: 'Добавить в комнату' }));

    expect(await screen.findByRole('heading', { name: 'У вас пока нет комнат' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'В лобби' })).toHaveAttribute('href', '/');
  });
});

describe('книга не найдена', () => {
  it('отдельное сообщение и путь назад в каталог', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(`GET ${url}`);
        if (url === '/api/catalog/b1') {
          return jsonResponse({ error: { code: 'not_found', message: 'Книга не найдена' } }, 404);
        }
        return jsonResponse({});
      }),
    );

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Книга не найдена' })).toBeInTheDocument();
    // Человек должен вернуться к списку, а не гадать адрес.
    expect(screen.getByRole('link', { name: 'В каталог' })).toHaveAttribute('href', '/catalog');
  });
});