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
    // `state.from` — куда человек собирался: без него вход с глубокой ссылки
    // бросал бы на лобби, и пришлось бы искать заново.
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

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
