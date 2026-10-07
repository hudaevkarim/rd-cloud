import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomView } from '../src/rooms/RoomView.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type { BookSummary, JoinRequest, Room, RoomMember } from '../src/api/types.js';

/**
 * Страница комнаты.
 *
 * ─── Что проверяется ─────────────────────────────────────────────────────────
 *
 * Разделы, состав участников, права владельца. Заявки вынесены в отдельный
 * файл: их проверок много и они про побочные эффекты, а здесь — про вёрстку и
 * права.
 */

let calls: string[] = [];
let room: Room;
let members: RoomMember[];
let requests: JoinRequest[] = [];
let books: BookSummary[] = [];

const USER = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' as const };

/**
 * Книга для списка.
 *
 * `uploadedById` и `hasText` заполнены осмысленно: по первому решается, кому
 * показывать кнопку уборки, по второму — рисуется ли «Читать».
 */
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

function member(id: string, name: string, role: 'owner' | 'member'): RoomMember {
  return {
    userId: id,
    role,
    joinedAt: '2026-01-01T00:00:00.000Z',
    user: { id, username: id, displayName: name, avatar: null },
  };
}

beforeEach(() => {
  calls = [];
  requests = [];
  books = [book()];
  members = [member('u1', 'Аня', 'owner'), member('u2', 'Борис', 'member')];
  room = {
    id: 'r1',
    name: 'Классика',
    description: 'Читаем по кругу',
    inviteCode: 'K3MQR7WD',
    isPublic: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerId: 'u1',
    owner: { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null },
    _count: { members: 2, books: 0 },
    myRole: 'owner',
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);

      /*
        Порядок проверок обязателен: маршруты разбираются по адресу, и общий
        `includes('/api/rooms')` ниже перехватил бы и `/api/rooms/r1/books` —
        вернул бы объект комнаты вместо списка книг, и страница упала бы на
        несуществующем `books.length`. Точные адреса идут первыми.
      */
      if (url.endsWith('/join-requests') && method === 'GET') return jsonResponse({ requests });
      if (url.endsWith('/members') && method === 'GET') return jsonResponse({ members });
      if (url.endsWith('/books') && method === 'GET') return jsonResponse({ books });
      if (url.includes('/join-requests') && method === 'POST') return jsonResponse({ ok: true });
      if (url.includes('/books/') && method === 'DELETE') return jsonResponse({ ok: true });
      if (url === '/api/rooms/r1' && method === 'GET') return jsonResponse({ room });
      if (url.includes('/api/rooms') && method === 'DELETE') return jsonResponse({ ok: true });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  /**
   * Подставной сокет.
   *
   * Отдельная функция, а не объявление в каждом тесте: сокет нужен пяти
   * проверкам, и копия объекта разъезжалась бы. Уже случалось: в одном тесте
   * on забыли, и страница падала с «target.on is not a function» вместо того,
   * чтобы показать, что проверяется.
   */
function fakeSocket(present: Array<{ userId: string }> = []) {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emit = vi.fn((_event: string, _payload?: unknown, ack?: (r: never) => void) => {
    ack?.({ ok: true, members: present } as never);
  });

  const fake = {
    emit,
    connected: true,
    on: (event: string, fn: (payload: unknown) => void) => handlers.set(event, fn),
    off: () => undefined,
    removeAllListeners: () => undefined,
  };

  vi.spyOn(wsModule, 'getSocket').mockReturnValue(fake as never);
  vi.spyOn(wsModule, 'connectSocket').mockReturnValue(fake as never);

  return { emit, handlers };
}
/**
 * Комната на своём маршруте.
 *
 * Отдельный `Route` нужен, чтобы работал `useNavigate`: редиректы «в лобби» и
 * «уйти из комнаты» без него падали бы с «относительный путь вне роутера».
 */
function renderRoom() {
  /*
    Токен кладётся и в хранилище, и в память клиента API.

    Второе — не дублирование ради теста: сокет берёт токен именно оттуда, и
    `AuthProvider` в реальном приложении тоже пишет в оба места при входе и при
    восстановлении сессии. Если бы тест подкладывал только хранилище, проверки
    присутствия проходили бы на странице без сокета — то есть ничего не
    проверяли.
  */
  setToken('токен');

  return render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/rooms/r1']}>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
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

const tabs = async (): Promise<HTMLElement[]> => {
  await screen.findByRole('heading', { name: 'Классика' });
  return screen.getAllByRole('tab');
};

describe('шапка', () => {
  it('показывает микро-лейбл «КОМНАТА», название и описание', async () => {
    renderRoom();

    // Микро-лейбл над названием: по нему видно, где человек находится, даже
    // если название не помещается на одну строку.
    expect(await screen.findByText('КОМНАТА')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Классика' })).toBeInTheDocument();
    expect(screen.getByText('Читаем по кругу')).toBeInTheDocument();
  });

  it('без описания шапка не оставляет пустой строки', async () => {
    room.description = null;
    renderRoom();

    expect(await screen.findByRole('heading', { name: 'Классика' })).toBeInTheDocument();
    expect(document.querySelector('.roomhead__desc')).toBeNull();
  });

  it('владельцу доступны правка и удаление', async () => {
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });

    expect(screen.getByRole('button', { name: 'Переименовать' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
  });

  it('участнику правки и удаления нет', async () => {
    /*
      Отдельным тестом, а не вторым рендером в том же: `cleanup` выполняется в
      `afterEach`, и два рендера в одном тесте оставили бы в документе обе
      версии — проверка нашла бы кнопку от первого рендера и прошла бы на
      неверном основании.
    */
    room.myRole = 'member';
    renderRoom();

    await screen.findByRole('heading', { name: 'Классика' });
    expect(screen.queryByRole('button', { name: 'Переименовать' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
    // А «Покинуть» есть у всех: выйти из комнаты может и владелец.
    expect(screen.getByRole('button', { name: 'Покинуть' })).toBeInTheDocument();
  });

  it('кнопка «Пригласить» копирует ссылку с кодом', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('button', { name: 'Пригласить' }));

    // Ссылка собирается из текущего origin: адрес меняется между localhost и
    // Cloudflare Tunnel, и жёсткий домен сломался бы на одном из них.
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/join/K3MQR7WD`);
  });

  it('без буфера обмена ссылка показывается текстом', async () => {
    const user = userEvent.setup();
    // `navigator.clipboard` есть только в защищённом контексте. Без запасного
    // пути кнопка «Пригласить» молчала бы — хуже, чем показать ссылку.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('нет буфера')) },
    });

    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('button', { name: 'Пригласить' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('/join/K3MQR7WD'),
    );
  });
});

describe('вкладки', () => {
  it('три раздела, по умолчанию книги', async () => {
    renderRoom();

    const list = await tabs();
    expect(list.map((t) => t.textContent)).toEqual(['Книги', 'Участники', 'Заявки']);
    expect(list[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('книга — настоящий список: название, автор и бейдж формата', async () => {
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });

    expect(await screen.findByText('Евгений Онегин')).toBeInTheDocument();
    expect(screen.getByText('А. С. Пушкин')).toBeInTheDocument();
    // Бейдж формата, а не пустоты: человек должен видеть, что это за книга,
    // не открывая меню.
    expect(screen.getByText('Текст')).toBeInTheDocument();
    // «Читать» есть только у книги с текстом.
    expect(screen.getByRole('link', { name: 'Читать' })).toBeInTheDocument();
  });

  it('пустой список объясняет, что делать дальше', async () => {
    books = [];
    renderRoom();

    expect(await screen.findByRole('heading', { name: 'В комнате пока нет книг' })).toBeInTheDocument();
    // Не «ни одной книги» молча: человек должен понять, что можно загрузить
    // или взять из каталога.
    expect(screen.getByText(/добавьте из общего каталога/i)).toBeInTheDocument();
  });

  it('книга с текстом и аудио показывает оба бейджа', async () => {
    books = [
      book({
        id: 'b2',
        title: 'Анна Каренина',
        hasAudio: true,
        files: [
          {
            kind: 'text',
            format: 'epub',
            fileSize: 1024,
            mimeType: 'application/epub+zip',
            durationSec: null,
            parsed: true,
            url: '/api/books/b2/file?kind=text',
          },
          {
            kind: 'audio',
            format: 'mp3',
            fileSize: 2048,
            mimeType: 'audio/mpeg',
            durationSec: 3600,
            parsed: false,
            url: '/api/books/b2/file?kind=audio',
          },
        ],
      }),
    ];
    renderRoom();

    expect(await screen.findByText('Анна Каренина')).toBeInTheDocument();
    expect(screen.getByText('Текст')).toBeInTheDocument();
    expect(screen.getByText('Аудио')).toBeInTheDocument();
    // Аудио показано текстом с подсказкой, а не мёртвой кнопкой: плеер придёт
    // в 7.5, и ссылка на него сейчас была бы ссылкой в никуда.
    expect(screen.queryByRole('link', { name: 'Слушать' })).not.toBeInTheDocument();
    expect(screen.getByTitle('Плеер — подэтап 7.5')).toBeInTheDocument();
  });

  it('участники показываются списком с ролями', async () => {
    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });

    await user.click(screen.getByRole('tab', { name: 'Участники' }));

    expect(await screen.findByText('Борис')).toBeInTheDocument();
    expect(screen.getByText('Аня')).toBeInTheDocument();
    // Роль помечается один раз, у владельца: «владелец» на обоих читался бы
    // как «у комнаты два владельца».
    expect(screen.getAllByText('владелец')).toHaveLength(1);
  });

  it('у каждого участника есть кружок с инициалами', async () => {
    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));

    await screen.findByText('Борис');
    // Кружок — единственное место с ненулевым скруглением, и он обязан нести
    // имя: без `aria-label` список читался бы как «, , ,».
    const avatars = screen.getAllByRole('img');
    expect(avatars.map((a) => a.getAttribute('aria-label'))).toEqual(['Аня', 'Борис']);
  });
});

describe('исключение участника', () => {
  it('владелец исключает, кнопки пропадают', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));
    await screen.findByText('Борис');

    await user.click(screen.getByRole('button', { name: 'Исключить' }));

    await waitFor(() => expect(calls).toContain('DELETE /api/rooms/r1/members/u2'));
  });

  it('владельца исключить нельзя, и кнопки у него нет', async () => {
    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));

    await screen.findByText('Борис');
    // Кнопка предлагала бы действие, которое сервер отвергает с 400.
    expect(screen.getAllByRole('button', { name: 'Исключить' })).toHaveLength(1);
  });

  it('участнику кнопки исключения нет вовсе', async () => {
    const user = userEvent.setup();
    room.myRole = 'member';
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));

    await screen.findByText('Борис');
    expect(screen.queryByRole('button', { name: 'Исключить' })).not.toBeInTheDocument();
  });

  it('отмена подтверждения ничего не удаляет', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));
    await screen.findByText('Борис');

    await user.click(screen.getByRole('button', { name: 'Исключить' }));

    // Исключение необратимо, поэтому подтверждение обязано работать.
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
});

describe('выход', () => {
  it('уводит в лобби и говорит, что произошло', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url.endsWith('/leave')) return jsonResponse({ left: true, roomDeleted: false });
        if (url.endsWith('/join-requests')) return jsonResponse({ requests });
        if (url.endsWith('/members')) return jsonResponse({ members });
        if (url.endsWith('/books')) return jsonResponse({ books });
        if (url === '/api/rooms/r1') return jsonResponse({ room });
        return jsonResponse({});
      }),
    );

    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('button', { name: 'Покинуть' }));

    await waitFor(() => expect(screen.getByText('Лобби')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('вышли');
  });

  it('о последнем участнике говорит, что комната удалена', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string }) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url.endsWith('/leave')) return jsonResponse({ left: true, roomDeleted: true });
        if (url.endsWith('/join-requests')) return jsonResponse({ requests });
        if (url.endsWith('/members')) return jsonResponse({ members });
        if (url.endsWith('/books')) return jsonResponse({ books });
        if (url === '/api/rooms/r1') return jsonResponse({ room });
        return jsonResponse({});
      }),
    );

    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('button', { name: 'Покинуть' }));

    // Разные последствия — разные слова: «вы вышли» звучало бы так, будто
    // комната осталась.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('комната удалена'),
    );
  });
});

describe('недоступная комната', () => {
  it('показывает причину и кнопку в лобби', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/rooms/r1') {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({ error: { code: 'forbidden', message: 'Информация о комнате доступна только участникам' } }),
          };
        }
        return jsonResponse({});
      }),
    );

    renderRoom();

    // Текст с сервера, а не «нет доступа»: по обрезанному «нет доступа»
    // человек не понял бы, что был исключён или что комнаты больше нет.
    expect(await screen.findByRole('heading', { name: 'Комната недоступна' })).toBeInTheDocument();
    expect(screen.getByText(/только участникам/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'В лобби' })).toBeInTheDocument();
  });
});

describe('присутствие', () => {
  it('точки на кружках и счётчик появляются из ответа на вход', async () => {
    /*
      Ответ на `room:join` — единственный источник присутствия в первый момент:
      события `presence:changed` придут только когда кто-то двинет страницу, и до
      того новичок видел бы «никто не читает», хотя все на месте.
    */
    const { handlers } = fakeSocket([{ userId: 'u1' }, { userId: 'u2' }]);

    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));

    await waitFor(() => expect(document.querySelectorAll('.avatar__dot')).toHaveLength(2));
    // Счётчик считает присутствие, а не состав комнаты: подставлять одно вместо
    // другого значило бы врать.
    expect(screen.getByText(/2 человека читают/)).toBeInTheDocument();
  });

  it('уход человека убирает точку', async () => {
    const { handlers } = fakeSocket([{ userId: 'u1' }, { userId: 'u2' }]);

    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));
    await waitFor(() => expect(document.querySelectorAll('.avatar__dot')).toHaveLength(2));

    const leave = handlers.get('presence:left');
    expect(leave).toBeTypeOf('function');
    leave?.({ userId: 'u2', roomId: 'r1' });

    // Ушедшие не копятся: запись удаляется, а не помечается.
    await waitFor(() => expect(document.querySelectorAll('.avatar__dot')).toHaveLength(1));
  });

  it('событие по чужой комнате игнорируется', async () => {
    const { handlers } = fakeSocket([{ userId: 'u1' }]);

    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));
    await waitFor(() => expect(document.querySelectorAll('.avatar__dot')).toHaveLength(1));

    handlers.get('presence:changed')?.({ roomId: 'другая', userId: 'u9' });

    // События приходят по всем комнатам, где человек состоит; без фильтра в
    // словарь попали бы посторонние.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelectorAll('.avatar__dot')).toHaveLength(1);
  });
});

describe('присутствие', () => {
  it('вошедший виден сам себе даже до первого движения', async () => {
    /*
      Сервер кладёт человека в карту присутствия сразу при входе, но в ответе на
      `room:join` список — «кто ещё читает», и без клиентской правки вошедший не
      видел бы и себя: страница показывала бы «0 человек читает сейчас» тому,
      кто только что открыл комнату и читает.
    */
    fakeSocket([]);
    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));

    await waitFor(() => expect(document.querySelectorAll('.avatar__dot')).toHaveLength(1));
    expect(screen.getByText(/1 человек читает/)).toBeInTheDocument();
  });

  it('чужие из ответа считаются вместе с вошедшим', async () => {
    fakeSocket([{ userId: 'u2' }]);
    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });
    await user.click(screen.getByRole('tab', { name: 'Участники' }));

    // Двое: вошедший и тот, кто был до него.
    await waitFor(() => expect(document.querySelectorAll('.avatar__dot')).toHaveLength(2));
    expect(screen.getByText(/2 человека читают/)).toBeInTheDocument();
  });
});

describe('сокет', () => {
  it('при открытии входит в комнату и при уходе выходит', async () => {
    const { emit } = fakeSocket();

    const { unmount } = renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });

    await waitFor(() => expect(emit).toHaveBeenCalledWith('room:join', { roomId: 'r1' }, expect.anything()));

    unmount();

    // Без выхода человек остался бы в списке читателей до обрыва сокета, а это
    // может занять минуты.
    expect(emit).toHaveBeenCalledWith('room:leave', { roomId: 'r1' });
  });
});