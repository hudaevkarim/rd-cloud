import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, books as booksApi, catalog as catalogApi, rooms as roomsApi } from '../api/client.js';
import type { BookSummary, RoomSummary } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Dialog } from '../components/ui/Dialog.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../components/ui/Toast.js';
import { messageOf, useQuery } from '../rooms/room-queries.js';
import { BookCover } from '../books/BookCover.js';

/**
 * Страница книги в каталоге.
 *
 * Отдельный адрес, а не разворот списка: ссылку на книгу хочется отправить
 * человеку, и в адресе страницы она переживёт и перезагрузку, и историю. Хеш
 * добавил бы кнопку «Назад» на одну лишнюю позицию и сломал бы ссылку целиком.
 */
export function CatalogBookPage() {
  const { bookId = '' } = useParams();
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const book = useQuery<BookSummary>(async () => catalogApi.get(bookId), [bookId]);

  if (book.status === 'loading') {
    return (
      <div className="page__center">
        <Spinner size={20} label="Открываем книгу" />
      </div>
    );
  }

  if (book.status === 'error') {
    return (
      <div className="page page--center">
        <h1 className="placeholder__title">Книга не найдена</h1>
        <p className="placeholder__hint">{book.error}</p>
        <Link className="btn" to="/catalog">
          В каталог
        </Link>
      </div>
    );
  }

  const data = book.data;

  return (
    <div className="page">
      <div className="bookpage">
        <div className="bookpage__cover">
          <BookCover coverUrl={data.coverUrl} author={data.author} title={data.title} size="lg" />
        </div>

        <div className="bookpage__head">
          <Label size="xs" as="p">
            КАТАЛОГ
          </Label>
          <h1 className="bookpage__title">{data.title}</h1>
          <p className="bookpage__author">{data.author}</p>

          {data.year !== null && <p className="bookpage__meta label label-xs">{data.year}</p>}

          <div className="bookpage__badges">
            {data.hasText && <span className="badge">Текст</span>}
            {data.hasAudio && <span className="badge">Аудио</span>}
            {data.files.map((f) => (
              <span className="badge badge--quiet" key={f.kind}>
                {f.format.toUpperCase()}
                {f.durationSec !== null && ` · ${Math.round(f.durationSec / 60)} мин`}
              </span>
            ))}
          </div>

          <div className="bookpage__actions">
            {/*
              «Читать» ведёт в читалку, а она живёт в 7.4. Ссылка уже сейчас, чтобы
              адрес не менялся после: страница книги в каталоге — постоянная, и её
              разумно сохранять закладкой.
            */}
            {data.hasText && (
              <span className="bookpage__notready" title="Читалка — подэтап 7.4">
                Читать
              </span>
            )}
            {data.hasAudio && (
              <span className="bookpage__notready" title="Плеер — подэтап 7.5">
                Слушать
              </span>
            )}
            <Button onClick={() => setAdding(true)}>Добавить в комнату</Button>
          </div>
        </div>
      </div>

      {data.description !== null && data.description !== '' && (
        <>
          <Rule />
          <section className="prose">
            <h2 className="prose__title">О книге</h2>
            <p>{data.description}</p>
          </section>
        </>
      )}

      {/*
        Биография отдельным разделом, а не внутри описания: описание — про книгу,
        биография — про автора, и человек ищет их разными вопросами.
      */}
      {data.authorBio !== null && data.authorBio !== '' && (
        <>
          <Rule />
          <section className="prose">
            <h2 className="prose__title">Об авторе</h2>
            <p>{data.authorBio}</p>
          </section>
        </>
      )}

      <AddToRoomDialog
        book={data}
        open={adding}
        onClose={() => setAdding(false)}
      />
    </div>
  );
}

/**
 * Выбор комнаты.
 *
 * Отдельный компонент, а не общий с каталогом: список комнат здесь берётся один
 * раз при открытии окна, а на странице каталога — при каждом открытии своего
 * окна. Разница в том, что окно на странице книги уже знает книгу, и лишних
 * состояний у него нет.
 */
function AddToRoomDialog({
  book,
  open,
  onClose,
}: {
  book: BookSummary;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const rooms = useQuery<RoomSummary[]>(async () => (open ? roomsApi.list() : []), [open]);

  const add = async (room: RoomSummary): Promise<void> => {
    setBusy(room.id);
    try {
      const result = await booksApi.addFromCatalog(room.id, book.id);
      // `added: false` — не ошибка: книга уже там. Отдельная формулировка, потому
      // что «добавлено» при этом было бы неправдой.
      toast.info(result.added ? `Добавлено в «${room.name}»` : `В «${room.name}» уже есть`);
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : messageOf(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Добавить книгу в комнату"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
      }
    >
      {rooms.status === 'loading' && (
        <div className="page__center">
          <Spinner size={20} label="Открываем ваши комнаты" />
        </div>
      )}

      {rooms.status === 'error' && <p className="empty__text">{rooms.error}</p>}

      {rooms.status === 'ready' && rooms.data.length === 0 && (
        <div className="empty">
          <h2 className="empty__title">У вас пока нет комнат</h2>
          <p className="empty__text">
            Создайте комнату, а потом добавьте в неё книгу — так её увидят другие.
          </p>
          <Link className="btn" to="/" onClick={onClose}>
            В лобби
          </Link>
        </div>
      )}

      {rooms.status === 'ready' && rooms.data.length > 0 && (
        <>
          <p className="dialog__lead">{book.title}</p>
          <ul className="rows">
            {rooms.data.map((room) => (
              <li className="rows__item" key={room.id}>
                <div className="pickrow">
                  <span className="pickrow__name">{room.name}</span>
                  <Button variant="ghost" onClick={() => void add(room)} disabled={busy !== null}>
                    {busy === room.id ? 'Добавляем…' : 'Добавить'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}