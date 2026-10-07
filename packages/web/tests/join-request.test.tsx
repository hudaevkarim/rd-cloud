import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomView } from '../src/rooms/RoomView.js';
import { describeNotification } from '../src/rooms/room-notifications.js';
import {
  isAdmitted,
  isEvicted,
  isJoinRequest,
  isMyRequestAnswered,
} from '../src/rooms/Notifications.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import { jsonResponse } from './setup.js';
import type { JoinRequest, Room, WireNotification } from '../src/api/types.js';

/**
 * Заявки и тексты уведомлений.
 *
 * ─── Почему заявки проверяются через страницу, а не через эндпоинт ───────────
 *
 * Эндпоинты проверяет `rooms-notify.test.ts` на сервере. Здесь проверяется то,
 * чего сервер не знает: что человек видит список, что счётчик появляется, что
 * после «Принять» строка исчезает, и что текст уведомления объясним.
 */

let calls: string[] = [];
let requests: JoinRequest[] = [];
let room: Room;

const USER = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' as const };

function request(id: string, name: string): JoinRequest {
  return {
    id,
    createdAt: '2026-10-01T10:00:00.000Z',
    status: 'pending',
    user: { id: `u${id}`, username: `u${id}`, displayName: name, avatar: null },
  };
}

beforeEach(() => {
  calls = [];
  requests = [request('3', 'Вера'), request('4', 'Глеб')];
  room = {
    id: 'r1',
    name: 'Классика',
    description: null,
    inviteCode: 'K3MQR7WD',
    isPublic: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ownerId: 'u1',
    owner: { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null },
    _count: { members: 1, books: 0 },
    myRole: 'owner',
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);

      if (url.endsWith('/join-requests') && method === 'GET') return jsonResponse({ requests });

      if (url.includes('/join-requests/') && method === 'POST') {
        /*
          Решение очищает выдачу — так ведёт себя сервер: одобренная или
          отклонённая заявка больше не `pending`.

          Условие на `/join-requests/`, а не на точный конец строки: адрес
          одобрения — `/join-requests/{id}/approve`, он не заканчивается на
          `/join-requests`. С точной проверкой заглушка молча отвечала `{}` и не
          обновляла список — строка оставалась, и проверка «исчезла после
          принятия» падала бы на заглушке, а не на коде.
        */
        requests = [];
        return jsonResponse({ ok: true });
      }
      if (url.endsWith('/members')) return jsonResponse({ members: [] });
      if (url === '/api/rooms/r1') return jsonResponse({ room });
      // Список книг страница комнаты берёт всегда, а не только на вкладке «Книги».
      // Без этой строки заглушка ниже вернула бы объект комнаты, и страница
      // упала бы на несуществующем `books.length`.
      if (url.endsWith('/books')) return jsonResponse({ books: [] });
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setToken(null);
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

function renderRoom() {
  // Токен в памяти клиента API: оттуда его берёт сокет. См. замечание в
  // `room-page.test.tsx`.
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

/** Открыть вкладку «Заявки». */
async function openRequests(): Promise<void> {
  renderRoom();
  await screen.findByRole('heading', { name: 'Классика' });
  await userEvent.setup().click(screen.getByRole('tab', { name: /Заявки/ }));
  await screen.findByText('Вера');
}

describe('список заявок', () => {
  it('показывает имя и дату', async () => {
    await openRequests();

    expect(screen.getByText('Вера')).toBeInTheDocument();
    expect(screen.getByText('Глеб')).toBeInTheDocument();
    // Дата без года внутри текущего года: «1 октября 2026 года» рядом с
    // сегодняшней датой — шум.
    expect(screen.getAllByText('1 октября')).toHaveLength(2);
  });

  it('счётчик на вкладке показывает число заявок', async () => {
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });

    // Человек должен понять, что вкладка стоит открытия, не заходя на неё.
    const tab = screen.getByRole('tab', { name: /Заявки/ });
    await waitFor(() => expect(tab).toHaveTextContent('2'));
  });

  it('при пустом списке счётчика нет, а вкладка объясняет', async () => {
    requests = [];
    const user = userEvent.setup();
    renderRoom();
    await screen.findByRole('heading', { name: 'Классика' });

    // Ноль на вкладке читался бы как «может, что-то и есть».
    await waitFor(() => expect(screen.getByRole('tab', { name: /Заявки/ })).not.toHaveTextContent('0'));

    await user.click(screen.getByRole('tab', { name: /Заявки/ }));
    expect(await screen.findByRole('heading', { name: 'Заявок нет' })).toBeInTheDocument();
    // Подсказка ведёт к приглашению: иначе пустой раздел выглядит тупиком.
    expect(screen.getByText(/ссылкой-приглашением/)).toBeInTheDocument();
  });
});

describe('принятие и отклонение', () => {
  it('принимает: уходит approve и строка исчезает', async () => {
    const user = userEvent.setup();
    await openRequests();

    const row = screen.getByText('Вера').closest('li') as HTMLElement;
    await user.click(row.querySelector('button') as HTMLElement);

    await waitFor(() => expect(calls).toContain('POST /api/rooms/r1/join-requests/3/approve'));
    // Список обновился: иначе человек принял бы вторую заявку, думая, что
    // первая ещё ждёт.
    await waitFor(() => expect(screen.queryByText('Вера')).not.toBeInTheDocument());
  });

  it('отклоняет: уходит reject и строка исчезает', async () => {
    const user = userEvent.setup();
    await openRequests();

    const row = screen.getByText('Глеб').closest('li') as HTMLElement;
    const buttons = [...row.querySelectorAll('button')];
    await user.click(buttons[1] as HTMLElement);

    await waitFor(() => expect(calls).toContain('POST /api/rooms/r1/join-requests/4/reject'));
    await waitFor(() => expect(screen.queryByText('Глеб')).not.toBeInTheDocument());
  });
});

describe('тексты уведомлений', () => {
  const note = (over: Partial<WireNotification>): WireNotification => ({
    id: 'n1',
    type: 'join_request',
    payload: { roomId: 'r1', roomName: 'Классика', userName: 'Вера' },
    createdAt: '2026-10-01T10:00:00.000Z',
    ...over,
  });

  it('о заявке называет комнату и человека', () => {
    const { text } = describeNotification(note({}));
    // Без названия комнаты при нескольких комнатах непонятно, куда идти, а без
    // имени — кто подал.
    expect(text).toContain('Классика');
    expect(text).toContain('Вера');
  });

  it('об отказе тон ошибки, об одобрении — обычный', () => {
    // Отказ — это «нет», и его надо удержать дольше: тон ошибки держит 6 секунд.
    expect(describeNotification(note({ type: 'join_rejected' })).tone).toBe('error');
    expect(describeNotification(note({ type: 'join_approved' })).tone).toBe('info');
    expect(describeNotification(note({ type: 'kicked' })).tone).toBe('error');
  });

  it('при добавлении и принятии говорит, что человек теперь в комнате', () => {
    expect(describeNotification(note({ type: 'added' })).text).toContain('добавили');
    expect(describeNotification(note({ type: 'join_approved' })).text).toContain('приняли');
  });

  it('неизвестный тип даёт нейтральный текст, а не пустой', () => {
    /*
      Сервер может добавить тип раньше клиента. Тогда человек увидел бы тост без
      текста — выглядит как поломка, хотя всё работает.
    */
    const { text } = describeNotification(note({ type: 'что-то-новое' as WireNotification['type'] }));
    expect(text).not.toBe('');
    expect(text).toBe('Новое уведомление');
  });

  it('без названия комнаты текст не рассыпается', () => {
    const { text } = describeNotification(note({ payload: { userName: 'Вера' } }));
    expect(text).toContain('Вера');
    // Заглушка вместо `undefined`: React не показал бы «undefined» в тексте.
    expect(text).not.toContain('undefined');
  });
});

describe('признаки событий', () => {
  const note = (over: Partial<WireNotification>): WireNotification => ({
    id: 'n1',
    type: 'join_request',
    payload: { roomId: 'r1', roomName: 'Классика' },
    createdAt: '2026-10-01T10:00:00.000Z',
    ...over,
  });

  it('добавление и принятие — это «меня впустили»', () => {
    expect(isAdmitted(note({ type: 'added' }))).toBe(true);
    expect(isAdmitted(note({ type: 'join_approved' }))).toBe(true);
    expect(isAdmitted(note({ type: 'kicked' }))).toBe(false);
  });

  it('исключение распознаётся только для своей комнаты', () => {
    // Уведомление о комнате, из которой исключили, не должно уводить с той
    // страницы, на которой человек находится.
    expect(isEvicted(note({ type: 'kicked' }), 'r1')).toBe(true);
    expect(isEvicted(note({ type: 'kicked', payload: { roomId: 'r2' } }), 'r1')).toBe(false);
  });

  it('заявка распознаётся только для своей комнаты', () => {
    expect(isJoinRequest(note({}), 'r1')).toBe(true);
    expect(isJoinRequest(note({}), 'r2')).toBe(false);
  });

  it('ответ на заявку — оба исхода, а не только одобрение', () => {
    // Только одобрение оставило бы «Запрос отправлен» на отклонённой заявке
    // навсегда.
    expect(isMyRequestAnswered(note({ type: 'join_approved' }))).toBe(true);
    expect(isMyRequestAnswered(note({ type: 'join_rejected' }))).toBe(true);
    expect(isMyRequestAnswered(note({ type: 'reaction' }))).toBe(false);
  });
});