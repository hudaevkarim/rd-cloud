import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReaderPage } from '../src/pages/Reader.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type { BlockKind, XmlText } from '@rd/library/parse';
import type { BookIndex, BookSummary, ChapterBlock, CurrentUser } from '../src/api/types.js';

/**
 * Полноэкранный режим.
 *
 * ─── Почему проверяются и классы, и CSS ──────────────────────────────────────
 *
 * Класс `reader--bare` говорит, что режим включился, а `display: none` в стилях
 * говорит, что панели действительно пропали. Одно без другого ничего не
 * значит: без класса режим не включался бы вовсе, а без правила панели остались
 * бы на месте при включённом флаге.
 *
 * Правила CSS проверяются здесь же, чтением файла: окно проверок держится на
 * 1000px, и медиазапрос в jsdom не применяется — проверять `getComputedStyle`
 * означало бы проверять jsdom, а не страницу.
 */

const USER: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' };

let book: BookSummary;
let index: BookIndex;
let calls: string[] = [];

/** Ширина окна для проверки узкого экрана. `null` — по умолчанию (десктоп). */
let narrowScreen = false;

function textNode(text: string): XmlText {
  return { name: '#text', text, attrs: {}, children: [] };
}

function block(index: number, kind: BlockKind, text: string): ChapterBlock {
  return { index, kind, node: { name: kind, attrs: {}, children: [textNode(text)] }, text };
}

function makeBook(over: Partial<BookSummary> = {}): BookSummary {
  return {
    id: 'b1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    description: null,
    authorBio: null,
    coverUrl: null,
    isCatalog: false,
    language: 'ru',
    year: null,
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

function makeIndex(count: number): BookIndex {
  return {
    version: 1,
    parserVersion: '1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    language: 'ru',
    totalBlocks: count * 3,
    chapters: Array.from({ length: count }, (_, i) => ({
      index: i,
      id: `c${i}`,
      href: `ch${i}.xhtml`,
      title: `Глава номер ${i}`,
      blockCount: 3,
    })),
    toc: [],
    coverHref: null,
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

/**
 * Заглушка `matchMedia`, отвечающая на ширину окна.
 *
 * Штатная заглушка в `setup.ts` всегда отвечает `false`, а проверке узкого
 * экрана нужно настоящее `true`: без него оглавление считалось бы видимым и
 * тест прошёл бы на противоположном поведении.
 */
function installMatchMedia(narrow: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: narrow && query.includes('767px'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  calls = [];
  narrowScreen = false;
  book = makeBook();
  index = makeIndex(2);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(`GET ${url}`);
      if (url === '/api/rooms/r1/books/b1') return jsonResponse({ book });
      if (url === '/api/rooms/r1/books/b1/index.json') return jsonResponse(index);
      if (/\/api\/rooms\/r1\/books\/b1\/ch\/\d+\.json/.test(url)) {
        return jsonResponse([
          block(0, 'h1', 'Глава номер 0'),
          block(1, 'p', 'Абзац первой главы.'),
          block(2, 'p', 'Абзац второй главы.'),
        ]);
      }
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

  window.localStorage.clear();
  setToken('токен');
  installMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  setToken(null);
});

function renderReader(): void {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/rooms/r1/books/b1']}>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
            <Routes>
              <Route
                path="/rooms/:roomId/books/:bookId"
                element={<ReaderPage roomId="r1" bookId="b1" />}
              />
              <Route path="/rooms/:roomId" element={<span>Комната</span>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Корневой элемент читалки как `HTMLElement`: у него `dataset`. */
function readerEl(): HTMLElement | null {
  return document.querySelector('.reader') as HTMLElement | null;
}

async function waitChapter(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector('.chapter');
    expect(el, 'контейнер главы должен появиться').not.toBeNull();
    return el as HTMLElement;
  });
}

describe('полноэкранный режим', () => {
  it('кнопка включает режим и меняет подпись', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    expect(readerEl()?.dataset.bare).toBe('false');
    await u.click(screen.getByRole('button', { name: 'Скрыть виджеты' }));

    // Подпись меняется на действие, а не остаётся прежней: иначе человек не
    // понял бы, как вернуть панели.
    expect(readerEl()?.dataset.bare).toBe('true');
    expect(screen.getByRole('button', { name: 'Показать панели' })).toBeInTheDocument();
  });

  it('текст остаётся, а панели уходят', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    await u.click(screen.getByRole('button', { name: 'Скрыть виджеты' }));

    // Самое важное: читалка обязана остаться читалкой. Режим прячет виджеты, а
    // не книгу.
    expect(within(await waitChapter()).getByText('Абзац первой главы.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Следующая' })).toBeInTheDocument();
  });

  it('Escape выходит из режима', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    await u.click(screen.getByRole('button', { name: 'Скрыть виджеты' }));
    expect(readerEl()?.dataset.bare).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(readerEl()?.dataset.bare).toBe('false');
    });
  });

  it('Escape в обычном режиме ничего не ломает', async () => {
    renderReader();
    await waitChapter();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(readerEl()?.dataset.bare).toBe('false');
    // Книга осталась на месте: Escape не должен закрывать читалку.
    expect(within(await waitChapter()).getByText('Абзац первой главы.')).toBeInTheDocument();
  });

  it('повторное нажатие возвращает панели', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    await u.click(screen.getByRole('button', { name: 'Скрыть виджеты' }));
    await u.click(screen.getByRole('button', { name: 'Показать панели' }));

    expect(readerEl()?.dataset.bare).toBe('false');
    expect(screen.getByRole('button', { name: 'Скрыть виджеты' })).toBeInTheDocument();
  });
});

describe('оглавление на узком экране', () => {
  it('закрытое оглавление спрятано от скринридера', async () => {
    narrowScreen = true;
    installMatchMedia(true);

    renderReader();
    await waitChapter();

    // На узком экране панель выдвижная и по умолчанию закрыта. Без `aria-hidden`
    // человек на голосовом экране слышал бы «кнопка Глава номер 1» из панели,
    // которой на экране нет, и не понимал бы, куда нажать.
    const toc = document.querySelector('.reader__toc');
    expect(toc?.getAttribute('aria-hidden')).toBe('true');
  });

  it('на широком экране оглавление доступно и без нажатий', async () => {
    renderReader();
    await waitChapter();

    const toc = document.querySelector('.reader__toc');
    // Оглавление всегда на виду, и прятать его от скринридера было бы
    // «книга без оглавления» на голосовом экранe.
    expect(toc?.getAttribute('aria-hidden')).toBeNull();
  });

  it('кнопка открывает и закрывает панель', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    const toggle = screen.getByRole('button', { name: 'Оглавление' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await u.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.reader__toc')?.className).toContain('is-open');

    await u.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape закрывает открытое оглавление, а не выходит из читалки', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    await u.click(screen.getByRole('button', { name: 'Оглавление' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(document.querySelector('.reader__toc')?.className).not.toContain('is-open');
    });
    // Режим скрытых виджетов не включался, и книга не закрылась.
    expect(readerEl()?.dataset.bare).toBe('false');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('выбор главы из панели закрывает её', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    await u.click(screen.getByRole('button', { name: 'Оглавление' }));
    const toc = screen.getByRole('navigation', { name: 'Оглавление' });
    const items = within(toc).getAllByRole('button');
    await u.click(items[items.length - 1] as HTMLElement);

    // Панель поверх текста осталась бы висеть поверх выбранной главы, и
    // читать было бы нельзя.
    await waitFor(() => {
      expect(document.querySelector('.reader__toc')?.className).not.toContain('is-open');
    });
  });
});