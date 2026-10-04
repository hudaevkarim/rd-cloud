import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import { useAuth } from '../auth/auth-context.js';
import { Spinner } from '../components/ui/Spinner.js';

/**
 * Защита маршрутов.
 *
 * ─── Почему ждём `ready`, а не сразу редиректим ───────────────────────────────
 *
 * При загрузке страницы ещё неизвестно, есть ли токен: он лежит в
 * `localStorage`, а подтвердить его может только `/api/auth/me`. Редирект до
 * ответа снёс бы человека с любой страницы на `/login` при каждой перезагрузке,
 * даже с верным токеном — и после входа он оказывался бы снова в логине.
 *
 * ─── Откуда пришли ───────────────────────────────────────────────────────────
 *
 * `state.from` запоминает адрес. Без него вход с глубокой ссылки бросил бы на
 * лобби, и открытая страница терялась бы молча.
 *
 * ─── Почему `replace` ────────────────────────────────────────────────────────
 *
 * Без `replace` запись «войти» осталась бы в истории: назад отдавал бы снова
 * `/login`, который тут же выкидывал бы назад, и человек попадал в цикл
 * «назад ничего не делает».
 */
export function RequireAuth() {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="page page--center">
        <Spinner size={20} label="Проверяем сессию" />
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <Outlet />;
}

/**
 * Защита админских маршрутов.
 *
 * Вложен под `RequireAuth`: иначе проверка «роль админа» выполнялась бы при
 * `user === null`, и человек без сессии получал бы не 403, а сообщение
 * «нужны права администратора» вместо формы входа.
 *
 * Админка показывает «нет доступа», а не редиректит на лобби: человек вошёл,
 * прав у него нет, и молчаливая отправка выглядела бы поломкой.
 */
export function RequireAdmin(): ReactElement {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="page page--center">
        <Spinner size={20} label="Проверяем права" />
      </div>
    );
  }

  if (user === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (user.role !== 'admin') {
    return (
      <div className="page page--center">
        <h1 className="placeholder__title">Нет доступа</h1>
        <p className="placeholder__hint">Раздел доступен только администратору.</p>
      </div>
    );
  }

  return <Outlet />;
}
