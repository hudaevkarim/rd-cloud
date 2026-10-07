/**
 * Страницы-заглушки.
 *
 * Наполнение — в следующих подэтапах. Здесь только проверка, что навигация,
 * каркас и защита роутов работают: без этого следующий подэтап начинал бы сразу
 * с двух задач — «нарисовать» и «починить раскладку».
 *
 * Заголовок и краткое описание — не декорация: по ним видно, что маршрут
 * вообще существует и куда он ведёт, даже когда содержимого ещё нет.
 *
 * Лобби, поиск, страница комнаты, вход по ссылке, каталог и админский каталог
 * отсюда ушли в подэтапы 7.2 и 7.3 — они больше не заглушки. Остались читалка
 * (7.4), плеер (7.5) и профиль.
 */

export function Placeholder({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="placeholder">
      <h1 className="placeholder__title">{title}</h1>
      <p className="placeholder__hint">{hint}</p>
    </div>
  );
}

export function ReaderPage({ roomId, bookId }: { roomId: string; bookId: string }) {
  return (
    <Placeholder
      title="Читалка"
      hint={`Книга ${bookId} в комнате ${roomId}. Текст и комментарии. Подэтап 7.4.`}
    />
  );
}

export function ProfilePage() {
  return <Placeholder title="Профиль" hint="Аккаунт, тема, выход. Наполнение — 7.7." />;
}
