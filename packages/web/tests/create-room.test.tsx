import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CreateRoomDialog } from '../src/rooms/CreateRoomDialog.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { jsonResponse } from './setup.js';

/**
 * Создание комнаты.
 *
 * ─── Границы взяты со схемы сервера ──────────────────────────────────────────
 *
 * 128 и 1000 — это `createBody` в `routes/rooms.ts`. Проверка на клиенте
 * существует ради мгновенного ответа: без неё человек узнал бы о слишком
 * длинном названии после похода на сервер. Но границы обязаны совпадать с
 * серверными, иначе клиент пропустил бы то, что сервер отвергнет, — и человек
 * увидел бы «не удалось создать» вместо понятного «слишком длинное имя».
 */

type Call = { url: string; method: string; body: unknown };

let calls: Call[] = [];
let createResponse: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  createResponse = { status: 201, body: { room: { id: 'r1', name: 'Классика' } } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });

      if (url === '/api/rooms' && init?.method === 'POST') {
        return {
          ok: createResponse.status < 400,
          status: createResponse.status,
          text: async () => JSON.stringify(createResponse.body),
        };
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Куда ушёл переход: без него редирект нечего проверять. */
function PathProbe() {
  return null;
}

/** Разобранное тело запроса: в `fetch` оно приходит строкой. */
function sentBody(index: number): unknown {
  const body = calls[index]?.body;
  return typeof body === 'string' ? JSON.parse(body) : body;
}

function renderDialog(close = vi.fn()) {
  return render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <CreateRoomDialog open onClose={close} />
          <PathProbe />
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

const dialog = async (): Promise<HTMLElement> => screen.findByRole('dialog', { name: 'Новая комната' });

describe('форма создания', () => {
  it('показывает название, описание и чекбокс', async () => {
    renderDialog();

    const box = await dialog();
    expect(within(box).getByLabelText('Название')).toBeInTheDocument();
    expect(within(box).getByLabelText('Описание')).toBeInTheDocument();
    expect(within(box).getByRole('checkbox')).toBeInTheDocument();
  });

  it('подпись под чекбоксом объясняет последствия', async () => {
    renderDialog();

    // Без объяснения «видна в поиске» читалось бы как украшение, и человек не
    // понял бы, чем рискует.
    const box = await dialog();
    expect(within(box).getByText(/видна в поиске/i)).toBeInTheDocument();
  });

  it('пустое название не отправляется', async () => {
    const user = userEvent.setup();
    renderDialog();

    const box = await dialog();
    await user.click(within(box).getByRole('button', { name: 'Создать' }));

    expect(within(box).getByRole('alert')).toHaveTextContent('Укажите название');
    // Запроса быть не должно: человек ничего не ввёл, и поход в сеть показал бы
    // только то, что интерфейс не дождался его ввода.
    expect(calls).toHaveLength(0);
  });

  it('пробелы в названии считаются пустым', async () => {
    const user = userEvent.setup();
    renderDialog();

    const box = await dialog();
    await user.type(within(box).getByLabelText('Название'), '    ');
    await user.click(within(box).getByRole('button', { name: 'Создать' }));

    expect(calls).toHaveLength(0);
  });

  it('слишком длинное название отвергается до запроса', async () => {
    const user = userEvent.setup();
    renderDialog();

    const box = await dialog();
    // 129 знаков: граница 128 приходит из схемы сервера.
    await user.click(within(box).getByLabelText('Название'));
    await user.paste('я'.repeat(129));
    await user.click(within(box).getByRole('button', { name: 'Создать' }));

    expect(within(box).getByRole('alert')).toHaveTextContent('128');
    expect(calls).toHaveLength(0);
  });
});

describe('отправка', () => {
  it('уходит запрос с названием и без описания, если его не вводили', async () => {
    const user = userEvent.setup();
    renderDialog();

    const box = await dialog();
    await user.type(within(box).getByLabelText('Название'), 'Классика');
    await user.click(within(box).getByRole('button', { name: 'Создать' }));

    await waitFor(() => expect(calls).toHaveLength(1));

    // Тело приходит строкой: `client.ts` сам ставит `JSON.stringify`, и тест
    // разбирает её, а не сравнивает строки — иначе он проверял бы порядок
    // ключей, а не содержимое запроса.
    //
    // Отсутствующее описание не отправляется пустой строкой: сервер отличил бы
    // «нет описания» от «описание пустое».
    expect(sentBody(0)).toEqual({ name: 'Классика', isPublic: false });
  });

  it('отправляет описание, если его ввели, и чекбокс', async () => {
    const user = userEvent.setup();
    renderDialog();

    const box = await dialog();
    await user.type(within(box).getByLabelText('Название'), 'Классика');
    await user.type(within(box).getByLabelText('Описание'), 'Читаем по кругу');
    await user.click(within(box).getByRole('checkbox'));
    await user.click(within(box).getByRole('button', { name: 'Создать' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(sentBody(0)).toEqual({
      name: 'Классика',
      description: 'Читаем по кругу',
      isPublic: true,
    });
  });

  it('название обрезается по краям', async () => {
    const user = userEvent.setup();
    renderDialog();

    const box = await dialog();
    await user.type(within(box).getByLabelText('Название'), '  Классика  ');
    await user.click(within(box).getByRole('button', { name: 'Создать' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    // Сервер обрезает края сам, но отправлять пробелы значит отправлять имя,
    // которое человек не написал.
    expect((sentBody(0) as { name: string }).name).toBe('Классика');
  });

  it('показывает текст сервера при отказе', async () => {
    const user = userEvent.setup();
    createResponse = { status: 409, body: { error: { code: 'conflict', message: 'Комната уже есть' } } };

    renderDialog();

    const box = await dialog();
    await user.type(within(box).getByLabelText('Название'), 'Классика');
    await user.click(within(box).getByRole('button', { name: 'Создать' }));

    // Текст с сервера, а не свой: 409 человек поймёт, а «что-то пошло не так» —
    // нет.
    await waitFor(() => expect(within(box).getByRole('alert')).toHaveTextContent('Комната уже есть'));
  });

  it('окно закрывается при отмене', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    renderDialog(close);

    const box = await dialog();
    await user.click(within(box).getByRole('button', { name: 'Отмена' }));

    expect(close).toHaveBeenCalled();
  });

  it('на время запроса кнопка занята и не отправляет повторно', async () => {
    const user = userEvent.setup();
    /*
      Ответ задерживается, чтобы успеть нажать дважды.
      `let release!:` — с восклицательным знаком: иначе TypeScript сужает
      переменную до `null` (значение из инициализатора) и не признаёт вызов
      вызываемым — хотя присваивание происходит в теле `executor`.
    */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
        if (url === '/api/rooms' && init?.method === 'POST') {
          await gate;
          calls.push({ url, method: 'POST', body: init?.body });
          return { ok: true, status: 201, text: async () => JSON.stringify(createResponse.body) };
        }
        return jsonResponse({});
      }),
    );

    renderDialog();

    const box = await dialog();
    await user.type(within(box).getByLabelText('Название'), 'Классика');
    const submit = within(box).getByRole('button', { name: 'Создать' });

    await user.click(submit);
    await user.click(submit);

    // Второе нажатие не даёт второго запроса: сервер вернул бы 409 на
    // «уже отправлено», и человек увидел бы ошибку после успешного создания.
    expect(calls).toHaveLength(0);
    expect(within(box).getByRole('button', { name: 'Создаём…' })).toBeDisabled();

    release?.();
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});