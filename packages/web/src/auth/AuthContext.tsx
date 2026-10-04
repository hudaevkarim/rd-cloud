import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { auth, setToken } from '../api/client.js';
import type { CurrentUser } from '../api/types.js';
import { AuthContext, TOKEN_STORAGE_KEY, type AuthContextValue } from './auth-context.js';

/**
 * Провайдер аутентификации.
 *
 * Контекст и хук вынесены в `auth-context.ts`: модуль с компонентом и хуком в
 * одном файле ломает Fast Refresh, и редактор перезагружает страницу целиком.
 * Подробности — там.
 *
 * ─── Токен в двух местах ─────────────────────────────────────────────────────
 *
 * В `localStorage` — чтобы пережить перезагрузку: cookie живёт, но
 * подтвердить его может только `/api/auth/me`, и до первого ответа клиент не
 * знает, вошёл ли человек. В памяти клиента API — как `Authorization`, для
 * случаев, когда cookie ещё не поставлена.
 *
 * Расхождение этих двух источников невозможно: токен кладётся в оба при входе
 * и вычищается из обоих при выходе и при неудачном входе.
 */

function readToken(storage: Storage | undefined): string | null {
  if (storage === undefined) return null;
  try {
    const value = storage.getItem(TOKEN_STORAGE_KEY);
    return value === null || value === '' ? null : value;
  } catch {
    return null;
  }
}

function writeToken(storage: Storage | undefined, token: string | null): void {
  if (storage === undefined) return;
  try {
    if (token === null) storage.removeItem(TOKEN_STORAGE_KEY);
    else storage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Приватный режим: сессия не переживёт перезагрузку, но работать будет.
  }
}

export function AuthProvider({
  children,
  storage,
  /** Подмена в тестах: не поднимать реальную сеть. */
  fetchMe,
}: {
  children: ReactNode;
  storage?: Storage;
  fetchMe?: () => Promise<{ user: CurrentUser }>;
}) {
  const store = storage ?? safeLocalStorage();

  const [user, setUser] = useState<CurrentUser | null>(null);
  const [ready, setReady] = useState(false);

  /**
   * Проверка сессии уходит ровно один раз.
   *
   * Флаг, а не пустой массив зависимостей: в StrictMode эффекты выполняются
   * дважды, и без флага ушло бы два одинаковых запроса `/api/auth/me`.
   *
   * ─── Почему запрос здесь не отменяется ─────────────────────────────────────
   *
   * Казалось бы правильным вернуть cleanup с `abort()`, и сначала так и было.
   * Но StrictMode выполняет эффект так:
   *
   *   запуск → cleanup → запуск
   *
   * `abort()` в cleanup отменяет запрос первого запуска, а второй запуск
   * флагом уже пропущен и нового запроса не делает. Отменённый запрос
   * отклоняется, обработчик отказа выполняется и **стирает токен и выкидывает
   * человека на форму входа** — при верном токене, сразу после перезагрузки.
   *
   * Наблюдалось в живом браузере: после перезагрузки страница приходила на
   * `/login`, токена в хранилище не было, а `/api/auth/me` в списке ресурсов
   * присутствовал с длительностью 1 мс — то есть прерванный, а не быстрый.
   *
   * Поэтому отмены нет. Запрос один и живёт недолго; присваивание состояния
   * после размонтирования React 18 пропускает молча, без предупреждения.
   */
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;

    const token = readToken(store);
    if (token === null) {
      setReady(true);
      return;
    }

    // Токен ставится в память до запроса: `/api/auth/me` уходит с заголовком,
    // а не только с cookie, которая на этом шаге может быть ещё не поставлена.
    setToken(token);

    const load = fetchMe ?? (() => auth.me());

    void load()
      .then((body) => {
        setUser(body.user);
      })
      .catch(() => {
        // Любая ошибка означает одно: сессии нет. Различать «токен неверный» и
        // «сервер недоступен» здесь нельзя — во втором случае человек увидит
        // форму входа и попробует ещё раз.
        setToken(null);
        writeToken(store, null);
        setUser(null);
      })
      .finally(() => {
        setReady(true);
      });
  }, [store, fetchMe]);

  const login = useCallback(
    async (token: string) => {
      // Токен кладётся в хранилище до запроса: если запрос упадёт, он будет
      // убран — см. `catch` ниже.
      writeToken(store, token);

      try {
        const me = await auth.login(token);
        setUser(me);
        setReady(true);
      } catch (error) {
        // Токен, которому отказали, больше не годится, и оставлять его в
        // хранилище нельзя: при следующей перезагрузке приложение пошло бы
        // проверять именно его, получило бы тот же отказ и вернуло на форму
        // входа. Человек увидел бы форму, вводил бы новый токен — и снова
        // оказывался бы здесь же, только уже с двумя попытками вместо одной.
        setToken(null);
        writeToken(store, null);
        throw error;
      }
    },
    [store],
  );

  const logout = useCallback(async () => {
    // Сначала локальная очистка, потом запрос: если сеть не доступна, человек
    // всё равно выйдет, иначе кнопка «выйти» зависала бы при обрыве.
    setToken(null);
    writeToken(store, null);
    setUser(null);
    try {
      await auth.logout();
    } catch {
      // Cookie на сервере не удалена — при следующем входе она заменится новым
      // токеном. Это единственное последствие, и оно безвредно.
    }
  }, [store]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, ready, login, logout }),
    [user, ready, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
