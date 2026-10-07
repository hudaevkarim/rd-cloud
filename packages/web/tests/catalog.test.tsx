import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CatalogPage } from '../src/pages/Catalog.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type { BookSummary } from '../src/api/types.js';

/**
 * Каталог: фильтры и добавление в комнату.
 *
 * Проверяется ровно то, что человек делает руками: сужает список фильтром и
 * выбирает комнату из окна. Здесь важно, что фильтр по автору не смешивается с
 * поиском по названию — это два разных вопроса, и один список на оба означал бы,
 * что человеку приходится угадывать, как написана фамилия.
 */

const USER = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' as const };

let catalog: BookSummary[] = [];
let rooms: Array<{ id: string; name: string }> = [];
let calls: string[] = [];
let handlers: Map<string, (payload: unknown) => void>;
/** Ответ `from-catalog` для следующего добавления. */
let addResult = { added: true };

function book(over: Partial<BookSummary> = {}): BookSummary {
  return {
    id: 'b1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    description: 'Роман в стихах',
    authorBio: 'Родился в 1799 году.',
    coverUrl: null,
    isCatalog: true,
    language: 'ru',
    year: 1825,
    uploadedById: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    hasText: true,
    hasAudio: false,
    files: [],
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
  addResult = { added: true };
  catalog = [
    book(),
    book({ id: 'b2', title: 'Пиковая дама', author: 'А. С. Пушкин', hasAudio: true }),
    book({ id: 'b3', title: 'Преступление и наказание', author: 'Ф. М. Достоевский' }),
  ];
  rooms = [
    { id: 'r1', name: 'Классика' },
    { id: 'r2', name: 'Настольная' },
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);

      if (url.startsWith('/api/catalog')) {
        const parsed = new URL(`http://x${url}`);
        const author = parsed.searchParams.get('author');
        const hasAudio = parsed.searchParams.get('hasAudio') === 'true';
        const q = parsed.searchParams.get('q');

        /*
          Фильтры повторяются в заглушке, а не игнорируются: проверка «фильтр по
          автору» прошла бы и на заглушке, которая отдаёт весь каталог, а человек
          увидел бы неотфильтрованный список.
        */
        return jsonResponse({
          books: catalog.filter(
            (b) =>
              (author === null || b.author.toLowerCase().includes(author.toLowerCase())) &&
              (q === null || b.title.toLowerCase().includes(q.toLowerCase())) &&
              (!hasAudio || b.hasAudio),
          ),
        });
      }

      if (url === '/api/rooms') return jsonResponse({ rooms });
      if (url.includes('/from-catalog')) return jsonResponse(addResult, addResult.added ? 201 : 200);
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

function renderCatalog(): void {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
            <CatalogPage />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

describe('список', () => {
  it('показывает книги с бейджами форматов', async () => {
    renderCatalog();

    expect(await screen.findByText('Евгений Онегин')).toBeInTheDocument();
    expect(screen.getByText('Пиковая дама')).toBeInTheDocument();
    // Бейдж «Аудио» есть только у книги, которой он принадлежит.
    expect(screen.getAllByText('Текст')).toHaveLength(3);
    expect(screen.getAllByText('Аудио')).toHaveLength(1);
  });

  it('название ведёт на страницу книги, а не сразу в читалку', async () => {
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    // Книгу из каталога сначала надо добавить в комнату, а для этого нужно знать,
    // что это за книга. Плюс оттуда есть описание и биография автора.
    expect(screen.getByRole('link', { name: 'Евгений Онегин' })).toHaveAttribute('href', '/catalog/b1');
  });

  it('пустой каталог объясняет, кто его наполняет', async () => {
    catalog = [];
    renderCatalog();

    expect(await screen.findByRole('heading', { name: 'Ничего не нашлось' })).toBeInTheDocument();
    expect(screen.getByText(/Книги добавляет администратор/i)).toBeInTheDocument();
  });
});

describe('фильтры', () => {
  it('по автору — отдельный вопрос, а не часть поиска', async () => {
    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    await u.type(field('Автор'), 'Пушкин');

    await waitFor(() => {
      expect(calls.some((c) => c.includes('author=%D0%9F'))).toBe(true);
    });
    await waitFor(() => expect(screen.queryByText('Преступление и наказание')).not.toBeInTheDocument());
    expect(screen.getByText('Евгений Онегин')).toBeInTheDocument();
    expect(screen.getByText('Пиковая дама')).toBeInTheDocument();
  });

  it('переключатель аудио не ждёт debounce', async () => {
    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');
    calls = [];

    await u.click(screen.getByLabelText('Только с аудио'));

    // Фильтр-галочка, а не ввод текста: задержка на нём читалась бы как «не
    // сработало».
    await waitFor(() => {
      expect(calls.some((c) => c.includes('hasAudio=true'))).toBe(true);
    });
    await waitFor(() => expect(screen.queryByText('Евгений Онегин')).not.toBeInTheDocument());
    expect(screen.getByText('Пиковая дама')).toBeInTheDocument();
  });

  it('пустой результат подсказывает снять фильтр', async () => {
    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    await u.type(field('Автор'), 'Лермонтов');

    expect(await screen.findByRole('heading', { name: 'Ничего не нашлось' })).toBeInTheDocument();
    // Подсказка полезнее голого «ничего не нашлось»: в половине случаев человек
    // просто написал фамилию иначе.
    expect(screen.getByText(/снимите фильтр по автору/i)).toBeInTheDocument();
  });

  it('пустой результат под фильтром аудио не говорит, что каталог пуст', async () => {
    // В каталоге есть книга с аудио, поэтому для пустого результата под
    // фильтром она не годится: фильтр оставил бы её на месте.
    catalog = [book(), book({ id: 'b3', title: 'Преступление и наказание', author: 'Ф. М. Достоевский' })];

    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    await u.click(screen.getByLabelText('Только с аудио'));

    await screen.findByRole('heading', { name: 'Ничего не нашлось' });
    /*
      Самое вредное здесь — сказать «каталог пуст». Человек снял галочку, увидел
      пустоту и решил бы, что каталога нет вовсе, хотя книг в нём полно.
    */
    const hint = screen.getByText(/только с аудио/i, { selector: 'p' });
    expect(hint).toBeInTheDocument();
    expect(hint).not.toHaveTextContent(/каталог пока пуст/i);
    expect(hint).toHaveTextContent(/снимите галочку/i);
  });

  it('без фильтров пустота означает пустой каталог', async () => {
    catalog = [];
    const u = userEvent.setup();
    renderCatalog();

    expect(await screen.findByRole('heading', { name: 'Ничего не нашлось' })).toBeInTheDocument();
    // Тут подсказка правильная: фильтров нет, значит каталог действительно пуст.
    expect(screen.getByText(/Книги добавляет администратор/i)).toBeInTheDocument();
  });
});

describe('добавление в комнату', () => {
  /** Открыть окно выбора комнаты. */
  async function openDialog(u: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    await u.click(screen.getAllByRole('button', { name: 'В комнату' })[0] as HTMLElement);
    return screen.findByRole('dialog', { name: 'Добавить книгу в комнату' });
  }

  it('окно со списком комнат', async () => {
    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    const dialog = await openDialog(u);
    // Поиск по окну, а не по странице: «Классика» есть и в заголовке страницы, и
    // в списке комнат, и общий поиск нашёл бы не то.
    expect(within(dialog).getByText('Классика')).toBeInTheDocument();
    expect(within(dialog).getByText('Настольная')).toBeInTheDocument();
  });

  it('добавление зовёт from-catalog', async () => {
    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    const dialog = await openDialog(u);
    await u.click(within(dialog).getAllByRole('button', { name: 'Добавить' })[0] as HTMLElement);

    await waitFor(() => {
      expect(calls.some((c) => c === 'POST /api/rooms/r1/books/from-catalog')).toBe(true);
    });
  });

  it('«уже есть» — не ошибка, а отдельное сообщение', async () => {
    addResult = { added: false };
    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    const dialog = await openDialog(u);
    await u.click(within(dialog).getAllByRole('button', { name: 'Добавить' })[0] as HTMLElement);

    // «Добавлено» при `added: false` было бы неправдой: книга уже стояла.
    expect(await screen.findByText('В «Классика» уже есть')).toBeInTheDocument();
  });

  it('нет комнат — предложение создать', async () => {
    rooms = [];
    const u = userEvent.setup();
    renderCatalog();
    await screen.findByText('Евгений Онегин');

    await openDialog(u);

    expect(await screen.findByRole('heading', { name: 'У вас пока нет комнат' })).toBeInTheDocument();
  });
});

describe('обновление по сокету', () => {
  it('catalog:book:added перечитывает список', async () => {
    renderCatalog();
    await screen.findByText('Евгений Онегин');
    const before = calls.filter((c) => c.startsWith('GET /api/catalog')).length;

    handlers.get('catalog:book:added')?.({
      book: { id: 'b9', title: 'Новая', author: 'Кто-то', coverUrl: null, hasText: true, hasAudio: false },
      addedBy: { id: 'u9', displayName: 'Админ' },
    });

    await waitFor(() => {
      // Каталог общий: новая книга появляется у всех, и перезапрос это один
      // источник правды.
      expect(calls.filter((c) => c.startsWith('GET /api/catalog')).length).toBeGreaterThan(before);
    });
  });
});