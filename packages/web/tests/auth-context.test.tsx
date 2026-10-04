import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrictMode, type ReactElement } from 'react';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { useAuth } from '../src/auth/auth-context.js';
import { jsonResponse, errorResponse } from './setup.js';

/**
 * Контекст аутентификации.
 *
 * Проверяется ровно то, что ломается на живом сайте: восстановление сессии
 * после перезагрузки, выход и поведение при неверном токене.
 */

const ADMIN = { id: 'u1', username: 'admin', displayName: 'admin', avatar: null, role: 'admin' as const };
const READER = { id: 'u2', username: 'boris', displayName: 'Борис', avatar: null, role: 'user' as const };

/** Обёртка для рендера с роутером: `useNavigate` без него падает. */
function wrap(node: ReactElement) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

/** Кнопка, вызывающая хук: без неё проверять нечего. */
function Probe() {
  const { user, ready, login, logout } = useAuth();

  // `void promise` здесь означал бы «обещание брошено», а не «ошибки не будет»:
  // `login` отклоняется при неверном токене, и без `catch` это всплывало бы
  // как необработанный промис и ломало прогон целиком. Приём «запустил и
  // забыл» здесь недопустим — компонент обязан реагировать на отказ сам.
  const fireAndForget = (run: () => Promise<void>): void => {
    void run().catch(() => undefined);
  };

  return (
    <div>
      <span data-testid="ready">{String(ready)}</span>
      <span data-testid="user">{user === null ? 'нет' : user.displayName}</span>
      <span data-testid="role">{user?.role ?? '—'}</span>
      <button type="button" onClick={() => fireAndForget(() => login('новый-токен'))}>
        Войти
      </button>
      <button type="button" onClick={() => fireAndForget(() => logout())}>
        Выйти
      </button>
    </div>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn());
});

describe('восстановление сессии', () => {
  it('без токена сразу готов и никого не считает вошедшим', async () => {
    render(wrap(<AuthProvider fetchMe={async () => ({ user: ADMIN })}><Probe /></AuthProvider>));

    // Проверка сессии не уходит, если токена нет: незачем спрашивать сервер,
    // кого он не узнает.
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('user')).toHaveTextContent('нет');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('токен в хранилище восстанавливает пользователя', async () => {
    window.localStorage.setItem('rd.token', 'старый-токен');
    const me = vi.fn().mockResolvedValue({ user: READER });

    render(wrap(<AuthProvider fetchMe={me}><Probe /></AuthProvider>));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('Борис');
    });
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
    expect(screen.getByTestId('role')).toHaveTextContent('user');
  });

  it('неверный токен: сессия не восстанавливается, токен вычищается', async () => {
    window.localStorage.setItem('rd.token', 'испорченный');
    const me = vi.fn().mockRejectedValue(new Error('401'));

    render(wrap(<AuthProvider fetchMe={me}><Probe /></AuthProvider>));

    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('user')).toHaveTextContent('нет');
    // Токен убран, иначе при следующей перезагрузке ушёл бы тот же запрос и
    // человек видел бы форму входа по кругу.
    expect(window.localStorage.getItem('rd.token')).toBeNull();
  });

  it('пока идёт проверка, ready ещё false', async () => {
    window.localStorage.setItem('rd.token', 'токен');
    let release: (value: { user: typeof ADMIN }) => void = () => undefined;
    const me = vi.fn(
      () =>
        new Promise<{ user: typeof ADMIN }>((resolve) => {
          release = resolve;
        }),
    );

    render(wrap(<AuthProvider fetchMe={me}><Probe /></AuthProvider>));

    // До ответа `ready` обязан быть false: иначе редирект на `/login`
    // сработал бы раньше, чем стало известно о токене.
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('false');
    });

    release({ user: ADMIN });
    await waitFor(() => {
      expect(screen.getByTestId('ready')).toHaveTextContent('true');
    });
  });

  /**
   * Сессия восстанавливается в StrictMode.
   *
   * Регрессия на конкретное поведение: эффект выполнялся «запуск → cleanup →
   * запуск», отмена в cleanup прерывала первый запрос, а второй запуск
   * пропускался флагом. Отменённый запрос отклонялся, обработчик отказа стирал
   * токен и выкидывал на форму входа — **после каждой перезагрузки, при верном
   * токене**. В тестах без StrictMode это не воспроизводилось, а в живом
   * браузере воспроизводилось всегда.
   */
  it('восстанавливает сессию под StrictMode, как в приложении', async () => {
    window.localStorage.setItem('rd.token', 'токен');
    const me = vi.fn().mockResolvedValue({ user: ADMIN });

    render(
      wrap(
        <StrictMode>
          <AuthProvider fetchMe={me}><Probe /></AuthProvider>
        </StrictMode>,
      ),
    );

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('admin');
    });
    // Токен обязан уцелеть: стирание его на этой стадии и есть тот баг.
    expect(window.localStorage.getItem('rd.token')).toBe('токен');
    // Запрос при этом один: второй ушёл бы только при отсутствии флага.
    expect(me).toHaveBeenCalledTimes(1);
  });
});

describe('вход и выход', () => {
  it('вход кладёт токен в хранилище и показывает пользователя', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ user: ADMIN })),
    );

    const user = userEvent.setup();
    render(wrap(<AuthProvider fetchMe={async () => ({ user: ADMIN })}><Probe /></AuthProvider>));

    await user.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('admin');
    });
    expect(window.localStorage.getItem('rd.token')).toBe('новый-токен');
  });

  it('выход чистит и хранилище, и состояние', async () => {
    window.localStorage.setItem('rd.token', 'токен');
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(jsonResponse({ user: ADMIN })) // /api/auth/me
        .mockResolvedValueOnce(jsonResponse({ ok: true })),      // /api/auth/logout
    );

    const user = userEvent.setup();
    render(wrap(<AuthProvider fetchMe={async () => ({ user: ADMIN })}><Probe /></AuthProvider>));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('admin');
    });

    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('нет');
    });
    expect(window.localStorage.getItem('rd.token')).toBeNull();
  });

  it('выход работает даже когда сервер недоступен', async () => {
    window.localStorage.setItem('rd.token', 'токен');
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(jsonResponse({ user: ADMIN }))
        .mockRejectedValueOnce(new Error('сеть недоступна')),
    );

    const user = userEvent.setup();
    render(wrap(<AuthProvider fetchMe={async () => ({ user: ADMIN })}><Probe /></AuthProvider>));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('admin');
    });

    // Локальная очистка выполняется до запроса: иначе кнопка «выйти» зависала
    // бы при обрыве, и человек остался бы в интерфейсе вошедшего.
    await user.click(screen.getByRole('button', { name: 'Выйти' }));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('нет');
    });
    expect(window.localStorage.getItem('rd.token')).toBeNull();
  });

  it('ошибка входа показывается и токен не сохраняется', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(401, 'unauthorized', 'Токен не подходит')),
    );

    const user = userEvent.setup();
    render(wrap(<AuthProvider fetchMe={async () => ({ user: ADMIN })}><Probe /></AuthProvider>));

    await user.click(screen.getByRole('button', { name: 'Войти' }));

    await waitFor(() => {
      expect(screen.getByTestId('user')).toHaveTextContent('нет');
    });
    expect(window.localStorage.getItem('rd.token')).toBeNull();
  });
});
