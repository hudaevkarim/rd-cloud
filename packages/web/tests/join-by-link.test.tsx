import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { JoinByCode } from '../src/pages/JoinByCode.js';
import { isValidInviteCode, INVITE_ALPHABET, normalizeInviteCode } from '../src/rooms/invite-code.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { jsonResponse } from './setup.js';

/**
 * Вход по ссылке-приглашению.
 *
 * ─── Что проверяется ─────────────────────────────────────────────────────────
 *
 * Три состояния страницы: вход идёт, вход удался, вход невозможен. Плюс форма
 * кода — она отсекает мусор до похода в сеть.
 *
 * Проверка «запрос ровно один» здесь обязательна: StrictMode выполняет эффекты
 * дважды, и два `join-by-code` дали бы второй ответ `joined: false` — то есть
 * человеку показалось бы «вы уже присоединились» вместо обычного перехода.
 */

let calls: string[] = [];
let joinResponse: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  joinResponse = { status: 200, body: { roomId: 'r1', joined: true } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);

      if (url === '/api/auth/me') {
        return {
          user: { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' },
        };
      }
      if (url === '/api/rooms/join-by-code') {
        return {
          ok: joinResponse.status < 400,
          status: joinResponse.status,
          text: async () => JSON.stringify(joinResponse.body),
        };
      }
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

/**
 * Страница входа по ссылке под `StrictMode`.
 *
 * `StrictMode` обязателен, и это не формальность. Эффекты выполняются дважды:
 * запуск → cleanup → запуск. Именно на этом ломался вход: флаг отмены в
 * cleanup гасил результат первого запроса, а защита от повтора не давала второму
 * ничего сделать — и переход в комнату не происходил никогда. Тест без
 * `StrictMode` проходил бы на сломанной странице.
 *
 * То же касается `AuthProvider`: его собственная проверка сессии тоже удваивается
 * и защищена флагом.
 */
function renderJoin(code: string) {
  return render(
    <StrictMode>
      <ThemeProvider prefersDark={false}>
        <ToastProvider>
          <MemoryRouter initialEntries={[`/join/${code}`]}>
            <AuthProvider
              storage={storage()}
              fetchMe={vi.fn().mockResolvedValue({
                user: { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' as const },
              })}
            >
              <Routes>
                <Route path="/" element={<span>Лобби</span>} />
                <Route path="/rooms/:roomId" element={<span>Комната r1</span>} />
                <Route path="/join/:inviteCode" element={<JoinByCode />} />
              </Routes>
            </AuthProvider>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}

describe('успешный вход', () => {
  it('уходит один запрос и ведёт в комнату', async () => {
    renderJoin('K3MQR7WD');

    // Ровно один: два вызова означали бы, что второй вернёт `joined: false` и
    // человек увидит «вы уже присоединились».
    await waitFor(() => expect(calls).toContain('/api/rooms/join-by-code'));
    expect(await screen.findByText('Комната r1')).toBeInTheDocument();

    // Кнопка «Войти» осталась одна: двойной клик дал бы второй запрос.
    expect(calls.filter((c) => c === '/api/rooms/join-by-code')).toHaveLength(1);
  });

  it('говорит, что человек присоединился', async () => {
    renderJoin('K3MQR7WD');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('присоединились'));
  });

  it('под StrictMode запрос всё равно один, и переход происходит', async () => {
    /*
      Страница обёрнута в StrictMode, поэтому это проверка настоящего двойного
      запуска эффекта, а не его имитации.

      Поломка, которую ловит именно этот тест: флаг отмены в cleanup гасил
      результат первого запроса, а защита от повтора не давала второму запуску
      ничего сделать. Запрос уходил, а страница вечно висела на «Входим в
      комнату». Обнаружено в живом браузере — тесты шли без StrictMode и
      проходили на сломанной странице.
    */
    renderJoin('K3MQR7WD');

    expect(await screen.findByText('Комната r1')).toBeInTheDocument();
    expect(calls.filter((c) => c === '/api/rooms/join-by-code')).toHaveLength(1);
  });

  it('показывает код, пока идёт вход', async () => {
    /*
      Человек видит, по какой ссылке он пришёл: если код отвергнут, он поймёт,
      какую именно ссылку надо переслать заново.

      Ответ задерживается: без этого страница успела бы перейти в комнату, и
      проверка «пока идёт вход» смотрела бы уже на другую страницу.

      let release!: — с восклицательным знаком: иначе TypeScript сужает
      переменную до 
ull (значение из инициализатора) и не признаёт вызов
      вызываемым — хотя присваивание происходит в теле executor.
    */
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/me') {
          return { user: { id: 'u1', username: 'a', displayName: 'A', avatar: null, role: 'user' } };
        }
        await gate;
        return { ok: true, status: 200, text: async () => JSON.stringify({ roomId: 'r1', joined: true }) };
      }),
    );

    renderJoin('K3MQR7WD');

    expect(await screen.findByText('K3MQR7WD')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Входим в комнату' })).toBeInTheDocument();
    release?.();
  });
});

describe('неверный код', () => {
  it('короткий код — без запроса, с объяснением', async () => {
    renderJoin('КОРОТ');

    // Форма проверяется на клиенте: код длиной пять не может быть выдан, и поход
    // в сеть только показал бы задержку.
    expect(await screen.findByRole('heading', { name: 'Не получилось войти' })).toBeInTheDocument();
    expect(screen.getByText(/восьми знаков/)).toBeInTheDocument();
    expect(calls.some((c) => c === '/api/rooms/join-by-code')).toBe(false);
  });

  it('неизвестный код — сообщение сервера и путь назад', async () => {
    joinResponse = {
      status: 404,
      body: { error: { code: 'not_found', message: 'Комната с таким кодом' } },
    };

    renderJoin('ZZZZZZZZ');

    expect(await screen.findByText('Комната с таким кодом')).toBeInTheDocument();
    // Оба выхода: в лобби и в поиск. Иначе человек остался бы на странице без
    // единого действия.
    expect(screen.getByRole('button', { name: 'В лобби' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Поискать комнату' })).toBeInTheDocument();
  });

  it('код с запрещённым символом не отправляется', async () => {
    // Ноль и «о» в алфавите нет: такой код не мог быть выдан.
    renderJoin('ABCD0EFG');

    expect(await screen.findByRole('heading', { name: 'Не получилось войти' })).toBeInTheDocument();
    expect(calls.some((c) => c === '/api/rooms/join-by-code')).toBe(false);
  });
});

describe('форма кода', () => {
  it('совпадает с правилами сервера', () => {
    /*
      Правила на клиенте и на сервере продублированы намеренно: сервер проверяет
      код на входе, клиент подсказывает ошибку без сети. Но разойтись им нельзя —
      клиент откажет коду, который сервер принял бы.
    */
    // 31 знак: 23 буквы и 8 цифр. Раньше в комментарии на сервере стояло «32»,
    // и тест это поймал: цифр не девять, «0» исключён вместе с «O».
    expect(INVITE_ALPHABET).toHaveLength(31);
    // 0, O, 1, I, l путают при переписывании на бумаге и при диктовке.
    expect(INVITE_ALPHABET).not.toMatch(/[01OIl]/);

    expect(isValidInviteCode('K3MQR7WD')).toBe(true);
    expect(isValidInviteCode('k3mqr7wd')).toBe(true);
    expect(isValidInviteCode(' K3MQR7WD ')).toBe(true);
    expect(isValidInviteCode('K3MQR7W')).toBe(false);
    expect(isValidInviteCode('K3MQR7WDD')).toBe(false);
    expect(isValidInviteCode('K3MQR7W0')).toBe(false);
    expect(isValidInviteCode('')).toBe(false);
    expect(isValidInviteCode(null)).toBe(false);
    expect(isValidInviteCode(12345678)).toBe(false);
  });

  it('нормализация обрезает края и поднимает регистр', () => {
    expect(normalizeInviteCode(' k3mqr7wd ')).toBe('K3MQR7WD');
    // Внутренние пробелы не схлопываются: код без пробелов длиной восемь, и строка с пробелом
    // строка с пробелом внутри отвергается проверкой ниже.
    expect(normalizeInviteCode('не код')).toBe('НЕ КОД');
    expect(isValidInviteCode('не код')).toBe(false);
  });
});