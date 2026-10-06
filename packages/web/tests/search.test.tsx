import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SearchPage } from '../src/pages/Search.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { jsonResponse } from './setup.js';
import type { RoomSearchHit } from '../src/api/types.js';

/**
 * Поиск.
 *
 * ─── Debounce проверяется числом запросов, а не временем ──────────────────────
 *
 * Ожидание «через 300 мс пришёл ответ» прошло бы и при нулевом задержке —
 * ответ пришёл бы раньше, чем тест посмотрел. Проверяется обратное: при
 * мгновенном вводе четырёх букв запрос **один**. Это и есть смысл debounce.
 */

let calls: string[] = [];
let hits: RoomSearchHit[] = [];
let joinRequestStatus = 201;

beforeEach(() => {
  calls = [];
  hits = [];
  joinRequestStatus = 201;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);

      if (url.includes('/join-request')) {
        return {
          ok: joinRequestStatus < 400,
          status: joinRequestStatus,
          text: async () => JSON.stringify(joinRequestStatus < 400 ? { request: { id: 'q1' } } : { error: { code: 'conflict', message: 'Заявка уже отправлена' } }),
        };
      }
      if (url.includes('/api/rooms/search')) return jsonResponse({ rooms: hits });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function renderSearch() {
  return render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider
            storage={storage()}
            fetchMe={vi.fn().mockResolvedValue({
              user: { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' as const },
            })}
          >
            <SearchPage />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Результат поиска с заданным состоянием кнопки. */
function hit(over: Partial<RoomSearchHit> = {}): RoomSearchHit {
  return {
    id: 'r1',
    name: 'Анна Каренина',
    description: 'Читаем по кругу',
    memberCount: 3,
    owner: { id: 'u2', displayName: 'Борис' },
    myRole: null,
    myPendingRequest: false,
    ...over,
  };
}

/** Ждёт первого запроса поиска: без этого ввод ушёл бы в пустоту. */
async function waitForSearch(): Promise<void> {
  await waitFor(() => expect(calls.some((c) => c.includes('/api/rooms/search'))).toBe(true));
}

const field = (): HTMLInputElement => screen.getByLabelText('Название комнаты') as HTMLInputElement;

describe('вкладки', () => {
  it('обе вкладки на месте, книги пустые', async () => {
    renderSearch();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Комнаты', 'Книги']);

    // Вкладка «Книги» заведена сейчас, наполнение — в 7.3. Иначе потом пришлось бы
    // переделывать навигацию.
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Книги' }));
    expect(screen.getByRole('heading', { name: 'Скоро' })).toBeInTheDocument();
  });

  it('введённое сохраняется при переключении вкладок', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(field(), 'анна');
    await user.click(screen.getByRole('tab', { name: 'Книги' }));
    await user.click(screen.getByRole('tab', { name: 'Комнаты' }));

    // Сброс поиска при переключении означал бы, что вкладку нельзя поменять
    // «посмотреть, не потеряв запрос».
    expect(field().value).toBe('анна');
  });
});

describe('ввод и debounce', () => {
  it('четыре буквы подряд дают один запрос', async () => {
    const user = userEvent.setup();
    hits = [hit()];

    renderSearch();

    /*
      Пустое поле не спрашивает сервер, поэтому `waitForSearch` до ввода
      ждал бы в пустоту. Отсчёт начинается после ввода: и смысл проверки в том,
      сколько запросов принесут четыре буквы, а не в том, что первый уже был.
    */
    await user.type(field(), 'анна');

    await waitFor(() => expect(calls.some((c) => c.includes('/api/rooms/search'))).toBe(true));
    // Ждём задержку целиком: запросы по каждой букве пришли бы раньше этого
    // момента, и счётчик их поймал бы.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(calls.filter((c) => c.includes('/api/rooms/search'))).toHaveLength(1);
  });

  it('пустой запрос не спрашивает сервер', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(field(), '   ');

    // Пробелы обрезаются, и запрос с пустым `q` сервер отверг бы с 400.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(calls.some((c) => c.includes('/api/rooms/search'))).toBe(false);
    expect(screen.getByRole('heading', { name: 'Что ищем?' })).toBeInTheDocument();
  });

  it('запрос кодируется', async () => {
    const user = userEvent.setup();
    hits = [hit()];
    renderSearch();

    await user.type(field(), 'анна');
    await waitForSearch();

    // Кириллица обязана быть закодирована: необработанная приходит на сервер
    // как latin1 и не совпадает с UTF-8 в базе.
    const call = calls.find((c) => c.includes('/api/rooms/search'));
    expect(call).toContain('%D0%B0');
    expect(call).not.toContain('анна');
  });
});

describe('результаты', () => {
  it('показывает название, описание, участников и хозяина', async () => {
    const user = userEvent.setup();
    hits = [hit()];
    renderSearch();

    await user.type(field(), 'анна');

    await waitFor(() => expect(screen.getByText('Анна Каренина')).toBeInTheDocument());
    expect(screen.getByText('Читаем по кругу')).toBeInTheDocument();
    expect(screen.getByText(/3 участника/)).toBeInTheDocument();
    expect(screen.getByText(/Борис/)).toBeInTheDocument();
  });

  it('пустое состояние повторяет запрос и объясняет', async () => {
    const user = userEvent.setup();
    hits = [];
    renderSearch();

    await user.type(field(), 'анна');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ничего не нашлось' })).toBeInTheDocument());
    // Подсказка про раскладку: «анна» и «Анна» — один запрос, а человек не
    // всегда это знает.
    expect(screen.getByText(/по названию целиком/)).toBeInTheDocument();
  });
});

describe('кнопка «Попроситься»', () => {
  it('отправляет заявку и переключается на «Запрос отправлен»', async () => {
    const user = userEvent.setup();
    hits = [hit()];
    renderSearch();

    await user.type(field(), 'анна');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Попроситься' })).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Попроситься' }));

    // Кнопка блокируется сразу: иначе между нажатием и ответом оставалось бы
    // активное «Попроситься», и второе нажатие вернуло бы 409 после успеха.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Запрос отправлен' })).toBeDisabled());
    expect(calls.some((c) => c === 'POST /api/rooms/r1/join-request')).toBe(true);
  });

  it('повторное нажатие невозможно', async () => {
    const user = userEvent.setup();
    hits = [hit()];
    renderSearch();

    await user.type(field(), 'анна');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Попроситься' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Попроситься' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Запрос отправлен' })).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Попроситься' })).not.toBeInTheDocument();
  });

  it('уже отправленная заявка приходит от сервера', async () => {
    const user = userEvent.setup();
    // `myPendingRequest` — это ответ сервера, а не локальное состояние: после
    // перезагрузки страницы клиент ничего не помнит.
    hits = [hit({ myPendingRequest: true })];
    renderSearch();

    await user.type(field(), 'анна');

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Запрос отправлен' })).toBeDisabled(),
    );
    expect(screen.queryByRole('button', { name: 'Попроситься' })).not.toBeInTheDocument();
  });

  it('участнику показывается вход в комнату, а не кнопка заявки', async () => {
    const user = userEvent.setup();
    hits = [hit({ myRole: 'member' })];
    renderSearch();

    await user.type(field(), 'анна');

    // Кнопка «Попроситься» у участника вернула бы 409 «Вы уже в комнате».
    const link = await screen.findByRole('link', { name: 'Вы уже в комнате' });
    expect(link).toHaveAttribute('href', '/rooms/r1');
    expect(screen.queryByRole('button', { name: 'Попроситься' })).not.toBeInTheDocument();
  });

  it('владельцу показывается вход, а не заявка', async () => {
    const user = userEvent.setup();
    hits = [hit({ myRole: 'owner' })];
    renderSearch();

    await user.type(field(), 'анна');
    expect(await screen.findByRole('link', { name: 'Вы уже в комнате' })).toBeInTheDocument();
  });

  it('отказ сервера показывается текстом и кнопка остаётся', async () => {
    const user = userEvent.setup();
    hits = [hit()];
    joinRequestStatus = 409;
    renderSearch();

    await user.type(field(), 'анна');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Попроситься' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Попроситься' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Заявка уже отправлена'));
    // Кнопка не исчезает: заявка не прошла, и человек должен иметь право
    // повторить после того, как разберётся.
    expect(screen.getByRole('button', { name: 'Попроситься' })).toBeEnabled();
  });
});