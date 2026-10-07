import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Layout } from './components/layout/Layout.js';
import { RequireAdmin, RequireAuth } from './components/RequireAuth.js';
import { LoginPage } from './pages/Login.js';
import { LobbyPage } from './pages/Lobby.js';
import { SearchPage } from './pages/Search.js';
import { JoinByCode } from './pages/JoinByCode.js';
import { CatalogPage } from './pages/Catalog.js';
import { CatalogBookPage } from './pages/CatalogBook.js';
import { AdminCatalogPage } from './pages/AdminCatalog.js';
import { RoomView } from './rooms/RoomView.js';
import { Notifications } from './rooms/Notifications.js';
import { ReaderPage } from './pages/Reader.js';
import { ProfilePage } from './pages/Placeholders.js';

/**
 * Витрина компонентов грузится отдельно и только в разработке.
 *
 * ─── Почему не просто `import.meta.env.DEV && <Route/>` ──────────────────────
 *
 * Статический импорт попал бы в бандл независимо от условия: модуль уже
 * загружен, а условие лишь решает, рисовать его или нет. Проверено на этой
 * странице — до правки поиск по `dist` находил и код витрины, и её стили.
 *
 * Динамический `import()` внутри условия выбрасывается сборщиком вместе с
 * отдельным куском: в продакшене `import.meta.env.DEV` — это `false`,
 * выражение `false ? … : null` сворачивается, и ссылка на модуль исчезает
 * вместе с ним.
 *
 * Гарантия проверяется не на слово, а поиском по `dist` — см.
 * `scripts/check-no-dev-in-dist.mjs`, который идёт в CI сразу после сборки.
 */
const ShowcasePage = import.meta.env.DEV
  ? lazy(() => import('./dev/ShowcasePage.js').then((m) => ({ default: m.ShowcasePage })))
  : null;

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

      {/*
        Витрина компонентов — вне каркаса и вне `RequireAuth`.
        Вне каркаса: у неё своя панель управления шириной, а шапка с ником и
        нижняя навигация мешали бы разглядывать компоненты. Вне `RequireAuth`:
        страница нужна, когда сессии ещё нет, — ровно в момент, когда
        разрабатывают форму входа.

        Условие `ShowcasePage !== null`, а не само `DEV`: в продакшене здесь
        `false`, и ветка вместе с ленивым импортом исчезает из бандла.
      */}
      {ShowcasePage !== null && (
        <Route
          path="/dev/components"
          element={
            <Suspense fallback={null}>
              <ShowcasePage />
            </Suspense>
          }
        />
      )}

      <Route element={<RequireAuth />}>
        {/*
          `/join/{код}` — под каркасом и под `RequireAuth`.

          Под `RequireAuth` потому, что войти без пользователя нельзя: некого
          добавлять в `RoomMember`. Он же запомнит адрес в `location.state.from`,
          и после входа `LoginPage` вернёт ровно сюда — иначе приглашение
          потерялось бы и человек оказался бы в лобби.

          Вне `<Layout>`, потому что это не страница приложения, а переход по
          внешней ссылке: шапка с ником и нижняя навигация здесь только мешают.
        */}
        <Route path="/join/:inviteCode" element={<JoinByCode />} />

        <Route element={<Layout />}>
          <Route path="/" element={<LobbyPage />} />
          <Route path="/rooms/:roomId" element={<RoomRoute />} />
          <Route path="/rooms/:roomId/books/:bookId" element={<ReaderRoute />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/catalog/:bookId" element={<CatalogBookPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/profile" element={<ProfilePage />} />

          {/* Админские маршруты — отдельной веткой под тем же `RequireAuth`.
              Вложенный `RequireAdmin` дублирует проверку сессии, но это
              один вызов хука и никаких лишних запросов. */}
          <Route element={<RequireAdmin />}>
            <Route path="/admin" element={<AdminCatalogPage />} />
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
  return <RoomView roomId={roomId} />;
}

/**
 * Читалка.
 *
 * Значения `''` в `useParams` означают, что маршрут не совпал, — то есть адрес
 * вида `/rooms//books/b1` сюда не дойдёт: `*` перебросит в лобби. Проверки на
 * пустоту здесь не стоит: она была бы недостижимой, а страховка, которая не
 * может сработать, защитой не считается.
 *
 * Проверка «а вдруг `roomId` придёт пустым» сделана там, где это возможно
 * на самом деле: адреса запросов в `api/client.ts` собираются строкой, и
 * пустой сегмент дал бы `/api/rooms//books/…`. Тест на это — в
 * `tests/api-client.test.ts`.
 */
function ReaderRoute() {
  const { roomId = '', bookId = '' } = useParams();
  return <ReaderPage roomId={roomId} bookId={bookId} />;
}
