import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { ApiError } from '../api/client.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useTheme } from '../theme/theme-context.js';

/**
 * Вход по токену.
 *
 * ─── Почему токен, а не пароль ────────────────────────────────────────────────
 *
 * Сервер проверяет токен и сам ставит cookie. Клиент ни разу не показывает его
 * снова: он лежит в `localStorage`, уходит заголовком и cookie, и на экране
 * видно только «вошли как кто».
 *
 * Ошибка показывается текстом с сервера, а не «не удалось войти»: сервер
 * различает «токен неверный» и «слишком много попыток с одного адреса», и второе
 * человеку полезно увидеть буквально.
 *
 * ─── Куда после входа ────────────────────────────────────────────────────────
 *
 * Не всегда в лобби: см. `destinationAfterLogin`. Человек, открывший
 * ссылку-приглашение без сессии, обязан вернуться ровно туда же — иначе
 * приглашение потерялось бы и он оказался бы в лобби без объяснения.
 */
export function LoginPage() {
  const { user, ready, login } = useAuth();
  const { resolved, toggle } = useTheme();
  const location = useLocation();

  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Уже вошедшего отправляем дальше, иначе он видел бы форму входа, будучи
  // авторизованным.
  if (!ready) {
    return (
      <div className="page page--center">
        <Spinner size={20} label="Проверяем сессию" />
      </div>
    );
  }
  if (user !== null) {
    return <Navigate to={destinationAfterLogin(location)} replace />;
  }

  /*
    Ссылка-приглашение объясняет, что будет дальше: после входа человек вернётся
    ровно сюда и попадёт в комнату. Без этой подсказки он подумал бы, что его
    выбросило на форму входа посреди открытой ссылки.
  */
  const hasDestination = destinationAfterLogin(location) !== '/';

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();

    const trimmed = token.trim();
    if (trimmed === '') {
      setError('Введите токен');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await login(trimmed);
      // Навигацию делает `<Navigate>` выше: он сработает, как только
      // `user` станет непустым, и один путь перехода надёжнее двух.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти. Попробуйте ещё раз.');
      setToken('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page--center">
      <form className="login" onSubmit={(e) => void submit(e)}>
        <h1 className="login__title display">ЧИТАЙ</h1>

        <Label size="xs" as="p">
          Совместное чтение
        </Label>

        <Rule />

        {hasDestination && (
          <p className="login__from label label-xs">
            После входа вернёмся на страницу, с которой вы пришли.
          </p>
        )}

        <Input
          label="Токен"
          type="password"
          value={token}
          autoFocus
          autoComplete="current-password"
          placeholder="Токен, выданный администратором"
          onChange={(e) => setToken(e.target.value)}
          error={error ?? undefined}
          hint="Токен выдаётся один раз и не истекает."
        />

        <Button type="submit" full disabled={busy}>
          {busy ? 'Входим…' : 'Войти'}
        </Button>

        <button
          type="button"
          className="login__theme label label-xs"
          onClick={toggle}
          aria-label={resolved === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        >
          {resolved === 'dark' ? 'СВЕТЛАЯ ТЕМА' : 'ТЁМНАЯ ТЕМА'}
        </button>
      </form>
    </div>
  );
}

/**
 * Куда вести после входа.
 *
 * Два источника, и различать их важно:
 *
 *   `state.from`  кладёт `RequireAuth` при редиректе. Это основной путь:
 *                 человек открыл `/join/{код}` без сессии, его увели на форму
 *                 входа, и после входа он обязан вернуться туда же.
 *
 *   `?next=`      нужен для ссылки, пришедшей извне: состояние роутера при
 *                 этом пусто, потому что адрес открыли напрямую, без перехода
 *                 внутри приложения.
 *
 * Значение из query проверяется: это внешние данные, и `next=https://чужой.сайт`
 * уводил бы человека с нашего адреса на чужой — с поддельной формой входа и
 * подписью нашего логотипа. Пустая строка и адрес без ведущей косой черты
 * отбрасываются по той же причине.
 */
export function destinationAfterLogin(location: LocationLike): string {
  const from = (location.state as { from?: unknown } | null)?.from;
  if (typeof from === 'string' && from.startsWith('/')) return from;

  const next = new URLSearchParams(location.search).get('next');
  if (next !== null && next.startsWith('/') && !next.startsWith('//')) return next;

  return '/';
}

/** Ровно та часть `Location`, которая нужна для решения о возврате. */
export interface LocationLike {
  state: unknown;
  search: string;
}
