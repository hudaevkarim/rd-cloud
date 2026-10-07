import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, books as booksApi } from '../api/client.js';
import type { BookSummary } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { useToast } from '../components/ui/Toast.js';
import { useAuth } from '../auth/auth-context.js';
import { messageOf } from '../rooms/room-queries.js';
import { BookCover } from './BookCover.js';
import { BookUploadDialog } from './BookUploadDialog.js';

/**
 * Книги комнаты.
 *
 * ─── Почему список перезапрашивается, а не дополняется событием ──────────────
 *
 * Событие `book:added` несёт шесть полей: идентификатор, название, автора,
 * обложку и два признака формата. Строке списка нужно больше — формат файла,
 * размер, длительность и признак разбора, — иначе «Скачать» не знал бы, что
 * качать. Дополнять список по частям значило бы держать наготове второй запрос,
 * а без него показать строку, в которой половина сведений выдумана.
 *
 * Поэтому событие — сигнал «перечитай», а не источник правды. Список берётся из
 * REST целиком: один запрос на событие вместо одного запроса плюс склейка на
 * клиенте, и никакой строки с неполными данными человек не увидит.
 *
 * ─── Подписка — в `RoomView` ─────────────────────────────────────────────────
 *
 * Сокет один на приложение, а список книг и заявок нужны в одном месте. Держать
 * подписку здесь означало бы её снятие при уходе на вкладку «Участники», и
 * книга, добавленная в этот момент, осталась бы незамеченной.
 */
export function BooksTab({
  room,
  books,
  reloadBooks,
}: {
  room: { id: string; myRole: string | null };
  books:
    | { status: 'loading' }
    | { status: 'error'; error: string }
    | { status: 'ready'; data: BookSummary[] };
  reloadBooks: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  if (books.status === 'loading') {
    return (
      <div className="page__center">
        <SpinnerLike label="Открываем книги" />
      </div>
    );
  }

  if (books.status === 'error') {
    return (
      <div className="empty">
        <p className="empty__text">{books.error}</p>
        <Button variant="ghost" onClick={reloadBooks}>
          Попробовать снова
        </Button>
      </div>
    );
  }

  return (
    <div className="books">
      <div className="books__head">
        <p className="books__count label label-xs">
          {books.data.length === 0
            ? 'ни одной книги'
            : `${books.data.length} ${plural(books.data.length, 'книга', 'книги', 'книг')}`}
        </p>
        <Button onClick={() => setUploading(true)}>Загрузить книгу</Button>
      </div>

      {books.data.length === 0 ? (
        <div className="empty">
          <h2 className="empty__title">В комнате пока нет книг</h2>
          <p className="empty__text">
            Загрузите первую или добавьте из общего каталога — там лежит классика,
            а загружать её заново в каждую комнату незачем.
          </p>
          <Button onClick={() => setUploading(true)}>Загрузить книгу</Button>
        </div>
      ) : (
        <ul className="rows">
          {books.data.map((book) => (
            <BookRow
              key={book.id}
              book={book}
              room={room}
              menuOpen={menuFor === book.id}
              onToggleMenu={() => setMenuFor(menuFor === book.id ? null : book.id)}
              onCloseMenu={() => setMenuFor(null)}
              onRemoved={reloadBooks}
            />
          ))}
        </ul>
      )}

      <BookUploadDialog
        roomId={room.id}
        open={uploading}
        onClose={() => setUploading(false)}
        onUploaded={reloadBooks}
      />
    </div>
  );
}

/** Склонение для счётчика книг. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = Math.abs(n) % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Заглушка загрузки: тот же спиннер, что и на остальных страницах. */
function SpinnerLike({ label }: { label: string }) {
  return (
    <div className="page__center">
      <span className="spinner" role="status" aria-label={label} />
    </div>
  );
}

/**
 * Строка книги.
 *
 * Отдельным компонентом, а не разметкой в цикле: у строки своё состояние «меню
 * открыто», и без отдельного компонента оно было бы общим для всего списка —
 * открыл «…» у одной книги и увидел открытые меню у всех.
 */
function BookRow({
  book,
  room,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  onRemoved,
}: {
  book: BookSummary;
  room: { id: string; myRole: string | null };
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onRemoved: () => void;
}) {
  const toast = useToast();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);

  /*
    Закрытие по клику вне и по Escape.

    Без этого меню оставалось бы открытым после ухода на другую вкладку, и человек
    увидел бы кнопку удаления у книги, к которой уже не обращается.
  */
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent): void => {
      if (menu.current !== null && !menu.current.contains(event.target as Node)) onCloseMenu();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseMenu();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, onCloseMenu]);

  /*
    Кто может убрать книгу — то же правило, что на сервере: владелец комнаты убирает
    любую, участник только загруженную им самим.

    Кнопка считается здесь, а не прячется на сервере: человек, которому нельзя, не
    должен видеть действие, которое упрётся в 403.
  */
  const canRemove =
    user !== null &&
    (user.role === 'admin' ||
      room.myRole === 'owner' ||
      (book.uploadedById !== null && book.uploadedById === user.id));

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await booksApi.removeFromRoom(room.id, book.id);
      toast.info('Книга убрана из комнаты');
      onCloseMenu();
      onRemoved();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  /*
    Скачивание идёт в два шага: сервер отдаёт адрес файла по запросу, потому что
    у `/files/**` есть проверка токена, а книга может лежать в закрытой комнате.

    Ссылка создаётся программно, а не `<a download>` в разметке: адреса ещё нет
    при рендере, а строка без ссылки читалась бы как «скачать нечем».
  */
  const download = async (): Promise<void> => {
    const kind = book.hasText ? 'text' : 'audio';
    try {
      const info = await booksApi.fileInfo(book.id, kind);
      const link = document.createElement('a');
      link.href = info.url;
      link.download = `${sanitizeFileName(book.title)}.${info.fileNameExtension}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      onCloseMenu();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : messageOf(error));
    }
  };

  /*
    Выбор формата, когда их два.

    «Читать» одна при наличии текста, а аудио показан текстом с подсказкой:
    плеер придёт в 7.5, и кнопка-ссылка сейчас была бы ссылкой в никуда. Но
    показать надо оба: при двух форматах и одной кнопке человек не понял бы,
    что вторую половину книги послушать нельзя.

    Кнопка «Скачать» в меню не исчезает вместе с этим: файл у книги один на
    формат, и скачать аудио можно независимо от того, что плеера ещё нет.
  */
  return (
    <li className="rows__item">
      <div className="bookrow">
        <BookCover coverUrl={book.coverUrl} author={book.author} title={book.title} />

        <div className="bookrow__body">
          <span className="bookrow__title">{book.title}</span>
          <span className="bookrow__author">{book.author}</span>
          <span className="bookrow__badges">
            {book.hasText && <span className="badge">Текст</span>}
            {book.hasAudio && <span className="badge">Аудио</span>}
            {book.year !== null && <span className="badge">{book.year}</span>}
          </span>
        </div>

        <div className="bookrow__actions">
          {book.hasText && (
            <Link className="btn btn--ghost" to={`/rooms/${room.id}/books/${book.id}`}>
              Читать
            </Link>
          )}
          {book.hasAudio && (
            <span className="bookrow__notready" title="Плеер — подэтап 7.5">
              Слушать
            </span>
          )}

          <div className="bookmenu" ref={menu}>
            <button
              type="button"
              className="bookmenu__button"
              onClick={onToggleMenu}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Действия с книгой «${book.title}»`}
            >
              …
            </button>

            {menuOpen && (
              <div className="bookmenu__list" role="menu">
                <button type="button" role="menuitem" className="bookmenu__item" onClick={() => void download()}>
                  Скачать
                </button>
                {canRemove && (
                  <button
                    type="button"
                    role="menuitem"
                    className="bookmenu__item bookmenu__item--danger"
                    onClick={() => void remove()}
                    disabled={busy}
                  >
                    Убрать из комнаты
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * Имя файла для сохранения.
 *
 * Из названия книги: так скачанный файл сразу узнаётся в папке загрузок. Слэши и
 * двоеточия убираются — иначе Windows назвал бы файл `Книга: том 1` как что-то
 * подозрительное, а часть систем отказалась бы вовсе.
 */
export function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[/\\:*?"<>|]/g, '').trim();
  return cleaned === '' ? 'книга' : cleaned;
}