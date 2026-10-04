import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Layout } from './components/layout/Layout.js';
import { RequireAdmin, RequireAuth } from './components/RequireAuth.js';
import { LoginPage } from './pages/Login.js';
import {
  AdminPage,
  CatalogPage,
  LobbyPage,
  ProfilePage,
  ReaderPage,
  RoomPage,
  SearchPage,
} from './pages/Placeholders.js';

/**
 * Маршруты.
 *
 * `/login` стоит вне каркаса: страница входа не должна показывать шапку с
 * ником того, кто ещё не вошёл, и нижнюю навигацию, по которой некуда идти.
 *
 * Порядок важен: `RequireAdmin` вложен в `RequireAuth`, а не наоборот. Иначе
 * проверка роли выполнялась бы при `user === null` и человек без сессии увидел
 * бы «нет доступа» вместо формы входа.
 *
 * `*` на конце — не раздел, а заглушка на неизвестный адрес: без неё React
 * Router показывает пустой `<Layout>` без шапки, что выглядит как сломанная
 * страница.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/" element={<LobbyPage />} />
          <Route path="/rooms/:roomId" element={<RoomRoute />} />
          <Route path="/rooms/:roomId/books/:bookId" element={<ReaderRoute />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/profile" element={<ProfilePage />} />

          {/* Админские маршруты — отдельной веткой под тем же `RequireAuth`.
              Вложенный `RequireAdmin` дублирует проверку сессии, но это
              один вызов хука и никаких лишних запросов. */}
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<AdminPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

/**
 * Параметры маршрута.
 *
 * `useParams` вызывается внутри компонента, а не в обработчике маршрута:
 * параметры появляются при рендере, и достать их на верхнем уровне нельзя.
 * Отдельные компоненты нужны ещё и потому, что `RoomRoute` находится под
 * `RequireAuth`, где маршруты уже смонтированы.
 */

function RoomRoute() {
  const { roomId = '' } = useParams();
  return <RoomPage roomId={roomId} />;
}

function ReaderRoute() {
  const { roomId = '', bookId = '' } = useParams();
  return <ReaderPage roomId={roomId} bookId={bookId} />;
}
