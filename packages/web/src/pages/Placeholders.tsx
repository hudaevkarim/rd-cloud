/**
 * Страницы-заглушки.
 *
 * Наполнение — в следующих подэтапах. Здесь только проверка, что навигация,
 * каркас и защита роутов работают: без этого следующий подэтап начинал бы
 * сразу с двух задач сразу — «нарисовать» и «починить раскладку».
 *
 * Заголовок и краткое описание — не декорация: по ним видно, что маршрут
 * вообще существует и куда он ведёт, даже когда содержимого ещё нет.
 */

export function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="placeholder">
      <h1 className="placeholder__title">{title}</h1>
      <p className="placeholder__hint">{hint}</p>
    </div>
  );
}

export function LobbyPage() {
  return <Placeholder title="Лобби" hint="Список ваших комнат и коды приглашений. Подэтап 7.2." />;
}

export function RoomPage({ roomId }: { roomId: string }) {
  return (
    <Placeholder
      title="Комната"
      hint={`Комната ${roomId}. Участники, заявки и книги. Подэтап 7.2.`}
    />
  );
}

export function ReaderPage({ roomId, bookId }: { roomId: string; bookId: string }) {
  return (
    <Placeholder
      title="Читалка"
      hint={`Книга ${bookId} в комнате ${roomId}. Текст и комментарии. Подэтап 7.3.`}
    />
  );
}

export function CatalogPage() {
  return <Placeholder title="Каталог" hint="Классика, доступная всем. Подэтап 7.2." />;
}

export function SearchPage() {
  return <Placeholder title="Поиск" hint="Поиск публичных комнат и книг. Подэтап 7.2." />;
}

export function ProfilePage() {
  return <Placeholder title="Профиль" hint="Аккаунт, тема, выход. Наполнение — 7.2." />;
}

export function AdminPage() {
  return <Placeholder title="Админка" hint="Пользователи, комнаты, каталог. Подэтап 7.2." />;
}
