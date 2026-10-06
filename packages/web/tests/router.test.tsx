import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { App } from '../src/App.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { jsonResponse } from './setup.js';

/**
 * Роутинг и защита маршрутов.
 *
 * Собирается всё приложение целиком, а не отдельный `RequireAuth`: проверка
 * «неавторизованного выкидывает на `/login`» имеет смысл только на настоящих
 * маршрутах. На вырожденном компоненте она прошла бы при сломанной разметке
 * `Routes`.
 */

const ADMIN = { id: 'u1', username: 'admin', displayName: 'admin', avatar: null, role: 'admin' as const };
const READER = { id: 'u2', username: 'boris', displayName: 'Борис', avatar: null, role: 'user' as const };

/** Показывает текущий путь и сохранённое состояние перехода. */
function Where() {
  const location = useLocation();
  return (
    <>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="from">{String((location.state as { from?: string } | null)?.from ?? '—')}</span>
    </>
  );
}

/** Хранилище в памяти: jsdom даёт общий на файл `localStorage`. */
function memoryStorage(token: string | null): Storage {
  const map = new Map<string, string>();
  if (token !== null) map.set('rd.token', token);
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
 * Приложение целиком.
 *
 * `user === null` — сессии нет: хранилище пустое, и проверка `/api/auth/me`
 * отклоняется. Иначе сессия есть и `fetchMe` возвращает пользователя.
 */
function renderApp(initial: string, user: typeof ADMIN | typeof READER | null) {
  const me =
    user === null
      ? vi.fn().mockRejectedValue(new Error('401'))
      : vi.fn().mockResolvedValue({ user });

  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initial]}>
          <AuthProvider
            fetchMe={me}
            storage={memoryStorage(user === null ? null : 'токен')}
          >
            <App />
            <Where />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/**
 * Ответы API по адресу.
 *
 * Один ответ на все запросы не годится: страницы стали настоящими и тянут
 * данные. Ответ `{ user: null }` на `GET /api/rooms/abc123` означал бы, что
 * комната пришла как объект без названия, и страница отрисовала бы пустой
 * заголовок — тест прошёл бы на сломанной странице.
 */
function respondByUrl(url: string): unknown {
  if (url.includes('/api/auth/me')) return { user: null };

  /*
    Порядок обязателен: `/api/rooms` совпадает и с `includes('/api/rooms')`, и с
    точной строкой списка. Проверка по `includes` для одной комнаты стояла выше
    и перехватывала список — `rooms.list()` получал `{ room: … }` и возвращал
    `undefined`, а лобби падало на `data.length`. Проверено: тест «обе
    навигации» падал с «Cannot read properties of undefined (reading 'length')».
  */
  if (url === '/api/rooms' || url.startsWith('/api/rooms?')) return { rooms: [] };

  if (url.endsWith('/join-requests')) return { requests: [] };
  if (url.endsWith('/members')) return { members: [] };

  if (url.includes('/api/rooms/')) {
    return {
      room: {
        id: 'abc123',
        name: 'Классика',
        description: 'Читаем по кругу',
        inviteCode: 'K3MQR7WD',
        isPublic: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        ownerId: 'u2',
        owner: { id: 'u2', username: 'boris', displayName: 'Борис', avatar: null },
        _count: { members: 2, books: 0 },
        myRole: 'owner',
      },
    };
  }

  return {};
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => jsonResponse(respondByUrl(url))),
  );
});

describe('защита маршрутов', () => {
  it('неавторизованного с лобби отправляет на /login', async () => {
    renderApp('/', null);

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/login');
    });
    expect(screen.getByRole('heading', { name: 'ЧИТАЙ' })).toBeInTheDocument();
  });

  it('неавторизованного с глубокой ссылки отправляет на /login', async () => {
    renderApp('/rooms/abc/books/xyz', null);

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/login');
    });
  });

  it('адрес, с которого ушли, запоминается для возврата после входа', async () => {
    // Потеря адреса молча сбрасывала бы человека на лобби после входа с
    // глубокой ссылки, и открытая страница пропадала бы без объяснения.
    renderApp('/rooms/abc/books/xyz', null);

    await waitFor(() => {
      expect(screen.getByTestId('from')).toHaveTextContent('/rooms/abc/books/xyz');
    });
  });

  it('авторизованный видит лобби и остаётся на месте', async () => {
    renderApp('/', READER);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Лобби' })).toBeInTheDocument();
    });
    expect(screen.getByTestId('path')).toHaveTextContent('/');
  });

  it('вошедший, открывший /login, отправляется на лобби', async () => {
    // Форма входа для вошедшего — ошибка состояния: человек уже авторизован,
    // и предъявлять ему поле токена незачем.
    renderApp('/login', READER);

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/');
    });
    expect(screen.getByRole('heading', { name: 'Лобби' })).toBeInTheDocument();
  });

  it('комната открывается по адресу', async () => {
    // Настоящая страница комнаты, а не заглушка: она берёт название из ответа
    // API, и подстановка `abc123` доказывает, что параметр маршрута дошёл.
    renderApp('/rooms/abc123', READER);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Классика' })).toBeInTheDocument();
    });

    expect(screen.getByText('Читаем по кругу')).toBeInTheDocument();
    expect(screen.getByTestId('path')).toHaveTextContent('/rooms/abc123');
  });

  it('вход по ссылке-приглашению не пускает без сессии', async () => {
    // `/join/{код}` под `RequireAuth`: без пользователя некого добавлять в
    // комнату. Адрес обязан сохраниться, иначе после входа приглашение
    // потерялось бы и человек оказался бы в лобби.
    renderApp('/join/K3MQR7WD', null);

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/login');
    });
    expect(screen.getByTestId('from')).toHaveTextContent('/join/K3MQR7WD');
  });

  it('после входа со ссылки-приглашения возвращает на неё', async () => {
    renderApp('/login?next=/join/K3MQR7WD', READER);

    // `?next=` нужен для ссылки извне: состояние роутера при прямом открытии
    // пусто, и `state.from` помочь не может.
    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/join/K3MQR7WD');
    });
  });
});

describe('админский маршрут', () => {
  it('обычному пользователю показывает «нет доступа», а не логин', async () => {
    renderApp('/admin', READER);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Нет доступа' })).toBeInTheDocument();
    });
    // Человек вошёл — прав нет. Отправлять его на форму входа значило бы
    // выглядеть поломкой.
    expect(screen.getByTestId('path')).toHaveTextContent('/admin');
  });

  it('неавторизованного отправляет на /login, а не на «нет доступа»', async () => {
    // Порядок проверок важен: сначала сессия, потом роль. Иначе человек без
    // сессии получил бы «нужны права админа» вместо формы входа.
    renderApp('/admin', null);

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/login');
    });
    expect(screen.queryByRole('heading', { name: 'Нет доступа' })).not.toBeInTheDocument();
  });

  it('администратора пускает', async () => {
    renderApp('/admin', ADMIN);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Админка' })).toBeInTheDocument();
    });
  });
});

describe('неизвестный адрес', () => {
  it('отправляет на лобби', async () => {
    renderApp('/такой-страницы-нет', READER);

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/');
    });
    expect(screen.getByRole('heading', { name: 'Лобби' })).toBeInTheDocument();
  });
});

describe('каркас', () => {
  it('обе навигации есть в разметке', async () => {
    // Проверяется наличие, а не видимость: CSS в jsdom не применяется, и
    // проверка `toBeVisible` прошла бы для обоих состояний одинаково.
    renderApp('/', READER);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Лобби' })).toBeInTheDocument();
    });

    expect(screen.getByRole('navigation', { name: 'Навигация' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Основная навигация' })).toBeInTheDocument();
  });

  it('ссылка «к содержимому» есть и помечена классом skip', async () => {
    // Без неё первое нажатие Tab уходит в адресную строку, и до шапки не
    // добраться: навигация с клавиатуры ломается целиком.
    renderApp('/', READER);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Лобби' })).toBeInTheDocument();
    });

    expect(screen.getByRole('link', { name: 'К содержимому' })).toHaveClass('skip');
  });

  it('на форме входа нет ни шапки, ни нижней навигации', async () => {
    // Страница входа не должна показывать ником того, кто ещё не вошёл, и
    // навигацию, по которой некуда идти.
    renderApp('/login', null);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'ЧИТАЙ' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('navigation', { name: 'Навигация' })).not.toBeInTheDocument();
  });
});
