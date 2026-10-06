import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LobbyPage } from '../src/pages/Lobby.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { jsonResponse } from './setup.js';
import type { RoomSummary } from '../src/api/types.js';

/**
 * Лобби.
 *
 * ─── Что здесь проверяется по-настоящему ─────────────────────────────────────
 *
 * Список, пустое состояние и обе кнопки. Состояние «загружается» проверяется
 * через наличие спиннера, а не через мгновенный рендер данных: без задержки
 * ответа фаза загрузки не наступает и проверка её была бы пустой.
 */

/** Комната для выдачи `GET /api/rooms`. */
function room(over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id: 'r1',
    name: 'Классика',
    description: 'Читаем по кругу',
    inviteCode: 'K3MQR7WD',
    isPublic: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerId: 'u1',
    _count: { members: 3, books: 2 },
    myRole: 'owner',
    ...over,
  };
}

type Call = { url: string; method: string };

let calls: Call[] = [];
let roomsPayload: RoomSummary[] = [];

beforeEach(() => {
  calls = [];
  roomsPayload = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push({ url, method: init?.method ?? 'GET' });

      if (url === '/api/rooms') return jsonResponse({ rooms: roomsPayload });
      if (url.includes('/join-by-code')) return jsonResponse({ roomId: 'r1', joined: true });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Лобби с сессией.
 *
 * `AuthProvider` обязателен: `LobbyPage` подписан на сокет, а тот читает
 * пользователя через `useAuth`. Без провайдера страница падала бы на
 * «useAuth вызван вне AuthProvider» — и проверялся бы не список комнат, а
 * отсутствие провайдера.
 */
function renderLobby() {
  return render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider
            storage={memoryStorage()}
            fetchMe={vi.fn().mockResolvedValue({
              user: {
                id: 'u1',
                username: 'anya',
                displayName: 'Аня',
                avatar: null,
                role: 'user' as const,
              },
            })}
          >
            <LobbyPage />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Хранилище в памяти: jsdom даёт общий на файл `localStorage`. */
function memoryStorage(): Storage {
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

describe('список комнат', () => {
  it('показывает комнаты с числом участников, книг и своей ролью', async () => {
    roomsPayload = [room()];

    renderLobby();

    await waitFor(() => expect(screen.getByText('Классика')).toBeInTheDocument());

    /*
      Ищется регуляркой по строке целиком: число и слово лежат в разных текстовых
      узлах — они склеены разделителем «·», и поиск по точному тексту такой
      строки не находит ничего.
    */
    expect(screen.getByText(/3 участника/)).toBeInTheDocument();
    expect(screen.getByText(/2 книги/)).toBeInTheDocument();
    expect(screen.getByText('владелец')).toBeInTheDocument();
  });

  it('показывает описание, когда оно есть', async () => {
    roomsPayload = [room({ description: 'Читаем по кругу' })];
    renderLobby();

    await waitFor(() => expect(screen.getByText('Читаем по кругу')).toBeInTheDocument());
  });

  it('без описания строка описания не занимает места', async () => {
    roomsPayload = [room({ description: null })];
    renderLobby();

    await waitFor(() => expect(screen.getByText('Классика')).toBeInTheDocument());
    expect(screen.queryByText('Читаем по кругу')).not.toBeInTheDocument();
  });

  it('склоняет число участников правильно', async () => {
    // «1 участник», «2 участника», «5 участников»: одна форма читалась бы как
    // ошибка в двух случаях из трёх.
    roomsPayload = [
      room({ id: 'a', name: 'А', _count: { members: 1, books: 0 } }),
      room({ id: 'b', name: 'Б', _count: { members: 2, books: 0 } }),
      room({ id: 'c', name: 'В', _count: { members: 5, books: 0 } }),
      room({ id: 'd', name: 'Г', _count: { members: 11, books: 0 } }),
    ];
    renderLobby();

    await waitFor(() => expect(screen.getByText('А')).toBeInTheDocument());

    /*
      Строка мета читается целиком, а не поиском по тексту: «1 участник» входит
      в «11 участников» как подстрока, и обычный поиск находил бы четыре
      совпадения вместо одного.
    */
    const meta = [...document.querySelectorAll('.roomrow__meta')].map(
      (n) => n.textContent ?? '',
    );

    expect(meta).toEqual([
      '1 участник · 0 книг',
      '2 участника · 0 книг',
      '5 участников · 0 книг',
      // Одиннадцать — одно число, а «11 участника» было бы ошибкой.
      '11 участников · 0 книг',
    ]);
  });

  it('каждая комната ведёт на свою страницу', async () => {
    roomsPayload = [room({ id: 'r1' }), room({ id: 'r2', name: 'Тихая' })];

    renderLobby();

    await waitFor(() => expect(screen.getByText('Тихая')).toBeInTheDocument());

    const links = screen.getAllByRole('link', { name: /Классика|Тихая/ });
    expect(links).toHaveLength(2);
    expect(within(links[0] as HTMLElement).getByText('Классика')).toBeInTheDocument();
  });

  it('роль участника не помечается как владение', async () => {
    roomsPayload = [room({ myRole: 'member' })];
    renderLobby();

    await waitFor(() => expect(screen.getByText('Классика')).toBeInTheDocument());
    expect(screen.queryByText('владелец')).not.toBeInTheDocument();
  });
});

describe('пустое состояние', () => {
  it('объясняет, что делать, и предлагает кнопку', async () => {
    roomsPayload = [];
    renderLobby();

    await waitFor(() => expect(screen.getByRole('heading', { name: /нет ни одной комнаты/ })).toBeInTheDocument());

    // Объяснение и действие: заголовка без объяснения человек не понял бы, что
    // комнаты вообще можно завести.
    expect(screen.getByText(/общее место для чтения/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Создать комнату' }).length).toBeGreaterThan(0);
  });

  it('кнопка создания открывает окно', async () => {
    roomsPayload = [];
    const user = userEvent.setup();
    renderLobby();

    await waitFor(() => expect(screen.getByRole('heading', { name: /нет ни одной комнаты/ })).toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Создать комнату' })[0] as HTMLElement);

    const dialog = await screen.findByRole('dialog', { name: 'Новая комната' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Название')).toBeInTheDocument();
  });
});

describe('кнопки в шапке', () => {
  it('показывает вход по коду и ссылку на каталог', async () => {
    roomsPayload = [room()];
    renderLobby();

    await waitFor(() => expect(screen.getByText('Классика')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Войти по коду' })).toBeInTheDocument();
    // Ссылка на каталог обязательна: в проект заведены книги, которые доступны
    // всем, и человек должен находить их из лобби в один клик.
    expect(screen.getByRole('link', { name: /Каталог/ })).toHaveAttribute('href', '/catalog');
  });

  it('окно входа по коду проверяет форму до запроса', async () => {
    roomsPayload = [];
    const user = userEvent.setup();
    renderLobby();

    /*
      Кнопка «Войти по коду» есть и в шапке, и в пустом состоянии — берётся
      первая. Иначе `getByRole` находил бы две и падал: на пустом лобби обе
      ведут в одно окно, и различать их незачем.
    */
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Войти по коду' }).length).toBeGreaterThan(0),
    );
    await user.click(screen.getAllByRole('button', { name: 'Войти по коду' })[0] as HTMLElement);

    const dialog = await screen.findByRole('dialog', { name: 'Войти по коду' });
    const field = within(dialog).getByLabelText('Код приглашения');

    await user.type(field, 'КОРот');
    await user.click(within(dialog).getByRole('button', { name: 'Войти' }));

    // Проверка формы без сети: человек узнаёт об ошибке мгновенно, а не после
    // похода на сервер.
    expect(within(dialog).getByRole('alert')).toHaveTextContent('неверно');
    expect(calls.some((c) => c.url.includes('join-by-code'))).toBe(false);
  });

  it('код приводится в верхний регистр на лету', async () => {
    roomsPayload = [];
    const user = userEvent.setup();
    renderLobby();

    /*
      Кнопка «Войти по коду» есть и в шапке, и в пустом состоянии — берётся
      первая. Иначе `getByRole` находил бы две и падал: на пустом лобби обе
      ведут в одно окно, и различать их незачем.
    */
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Войти по коду' }).length).toBeGreaterThan(0),
    );
    await user.click(screen.getAllByRole('button', { name: 'Войти по коду' })[0] as HTMLElement);

    const dialog = await screen.findByRole('dialog', { name: 'Войти по коду' });
    const field = within(dialog).getByLabelText('Код приглашения');

    await user.type(field, 'k3mq');
    // Код диктуют по телефону строчными; если бы мы показывали то, что введено,
    // человек решил бы, что ошибся.
    expect((field as HTMLInputElement).value).toBe('K3MQ');
  });
});

describe('ошибка загрузки', () => {
  it('показывает текст и даёт повторить', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { code: 'x', message: 'База недоступна' } }),
      })),
    );

    renderLobby();

    await waitFor(() => expect(screen.getByText('База недоступна')).toBeInTheDocument());
    // Без кнопки повтора человек остался бы с одним текстом и без хода.
    expect(screen.getByRole('button', { name: 'Попробовать снова' })).toBeInTheDocument();
  });
});