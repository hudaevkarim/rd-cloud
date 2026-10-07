import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { catalog as catalogApi, rooms as roomsApi, books as booksApi } from '../api/client.js';
import type { BookSummary } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Dialog } from '../components/ui/Dialog.js';
import { Input } from '../components/ui/Input.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../components/ui/Toast.js';
import { useQuery, useDebounced } from '../rooms/room-queries.js';
import { useRoomSocket } from '../rooms/useRoomSocket.js';
import { BookCover } from '../books/BookCover.js';
import type { RoomSummary } from '../api/types.js';

/**
 * Каталог классики.
 *
 * ─── Фильтр по автору отдельно от поиска ─────────────────────────────────────
 *
 * Поиск ищет по названию и автору одновременно, а фильтр по автору — точное
 * «всё этого автора». Один список на две разные задачи означал бы, что человеку,
 * ищущему конкретного автора, приходится угадывать, как его фамилия написана в
 * названии.
 *
 * ─── Обновление по событию `catalog:book:added` ──────────────────────────────
 *
 * Каталог общий, и новая книга появляется у всех. Событие приходит без сведений
 * о форматах и разборе, поэтому список перечитывается: одна строка с
 * недоказанными данными хуже, чем запрос.
 */
export function CatalogPage() {
  const [q, setQ] = useState('');
  const [author, setAuthor] = useState('');
  const [withAudio, setWithAudio] = useState(false);

  // Задержка на обоих полях: без неё каждый ввод порождал бы запрос.
  const settledQ = useDebounced(q.trim(), 300);
  const settledAuthor = useDebounced(author.trim(), 300);

  const [adding, setAdding] = useState<BookSummary | null>(null);

  const catalog = useQuery<BookSummary[]>(
    async () =>
      catalogApi.list({
        ...(settledQ === '' ? {} : { q: settledQ }),
        ...(settledAuthor === '' ? {} : { author: settledAuthor }),
        ...(withAudio ? { hasAudio: true } : {}),
      }),
    [settledQ, settledAuthor, withAudio],
  );

  const onCatalogAdded = useCallback(() => {
    catalog.reload();
  }, [catalog]);

  useRoomSocket({ onCatalogBookAdded: onCatalogAdded });

  // Фильтр по аудио не ждёт debounce: это переключатель, а не ввод текста, и
  // задержка на нём читалась бы как «не сработало».

  return (
    <div className="page">
      <div className="page__head">
        <Label size="xs" as="p">
          КАТАЛОГ
        </Label>
        <h1 className="page__title">Классика</h1>
        <p className="page__hint">
          Книги, доступные всем. Добавьте нужную в комнату — файл не копируется,
          а читают её все участники.
        </p>
      </div>

      <div className="filters">
        <Input
          label="Название"
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Евгений Онегин"
        />
        <Input
          label="Автор"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          placeholder="Пушкин"
        />
        <label className="checkline">
          <input
            type="checkbox"
            checked={withAudio}
            onChange={(event) => setWithAudio(event.target.checked)}
          />
          <span className="label">Только с аудио</span>
        </label>
      </div>

      <Rule />

      {catalog.status === 'loading' && (
        <div className="page__center">
          <Spinner size={20} label="Открываем каталог" />
        </div>
      )}

      {catalog.status === 'error' && (
        <div className="empty">
          <p className="empty__text">{catalog.error}</p>
          <Button variant="ghost" onClick={catalog.reload}>
            Попробовать снова
          </Button>
        </div>
      )}

      {catalog.status === 'ready' && catalog.data.length === 0 && (
        <div className="empty">
          <h2 className="empty__title">Ничего не нашлось</h2>
          <p className="empty__text">{emptyHint(author, q, withAudio)}</p>
        </div>
      )}

      {catalog.status === 'ready' && catalog.data.length > 0 && (
        <ul className="rows">
          {catalog.data.map((book) => (
            <li className="rows__item" key={book.id}>
              <div className="catrow">
                <BookCover coverUrl={book.coverUrl} author={book.author} title={book.title} />

                <div className="catrow__body">
                  <Link className="catrow__title link" to={`/catalog/${book.id}`}>
                    {book.title}
                  </Link>
                  <span className="catrow__author">{book.author}</span>
                  {/*
                    Описание обрезано одной строкой: в аннотации есть всё, но
                    каталог — это список, а не чтение. Полное — на странице книги.
                  */}
                  {book.description !== null && book.description !== '' && (
                    <span className="catrow__desc">{book.description}</span>
                  )}
                  <span className="catrow__badges">
                    {book.hasText && <span className="badge">Текст</span>}
                    {book.hasAudio && <span className="badge">Аудио</span>}
                    {book.year !== null && <span className="badge">{book.year}</span>}
                  </span>
                </div>

                <div className="catrow__action">
                  <Button onClick={() => setAdding(book)}>В комнату</Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddToRoomDialog
        book={adding}
        onClose={() => setAdding(null)}
        onDone={() => catalog.reload()}
      />
    </div>
  );
}

/**
 * Выбор комнаты для книги.
 *
 * ─── Почему список, а не поле ввода ──────────────────────────────────────────
 *
 * Человек добавляет книгу в комнату, в которой уже состоит, и её всегда можно
 * назвать. Ввод с подсказками выглядел бы умнее, но означал бы, что человек
 * помнит идентификатор комнаты — а он его не знает.
 *
 * Окно без скруглений и по центру — как и все остальные модальные окна проекта.
 */
function AddToRoomDialog({
  book,
  onClose,
  onDone,
}: {
  book: BookSummary | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [busyRoom, setBusyRoom] = useState<string | null>(null);

  const rooms = useQuery<RoomSummary[]>(async () => (book === null ? [] : roomsApi.list()), [book?.id]);

  const add = async (room: RoomSummary): Promise<void> => {
    if (book === null) return;
    setBusyRoom(room.id);
    try {
      const result = await booksApi.addFromCatalog(room.id, book.id);
      // `added: false` — не ошибка: книга уже там. Отдельное сообщение, потому
      // что «добавлено» при этом было бы неправдой.
      toast.info(result.added ? `Добавлено в «${room.name}»` : `В «${room.name}» уже есть`);
      onDone();
      onClose();
    } catch {
      toast.error('Не удалось добавить книгу');
    } finally {
      setBusyRoom(null);
    }
  };

  return (
    <Dialog
      open={book !== null}
      onClose={onClose}
      title="Добавить книгу в комнату"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
      }
    >
      {book === null && <p className="empty__text">Выберите комнату</p>}

      {book !== null && rooms.status === 'loading' && (
        <div className="page__center">
          <Spinner size={20} label="Открываем ваши комнаты" />
        </div>
      )}

      {book !== null && rooms.status === 'error' && (
        <p className="empty__text">{rooms.error}</p>
      )}

      {book !== null && rooms.status === 'ready' && rooms.data.length === 0 && (
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

      {book !== null && rooms.status === 'ready' && rooms.data.length > 0 && (
        <>
          <p className="dialog__lead">{book.title}</p>
          <ul className="rows">
            {rooms.data.map((room) => (
              <li className="rows__item" key={room.id}>
                <div className="pickrow">
                  <span className="pickrow__name">{room.name}</span>
                  <Button
                    variant="ghost"
                    onClick={() => void add(room)}
                    disabled={busyRoom !== null}
                  >
                    {busyRoom === room.id ? 'Добавляем…' : 'Добавить'}
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

/**
 * Подсказка под пустым результатом.
 *
 * Отдельной функцией, а не тернарником в разметке: фильтров три, вариантов
 * текста четыре, и в разметке это разрослось бы в цепочку условий, которую
 * невозможно прочитать.
 *
 * Главное здесь — не сказать «каталог пуст», когда пуст фильтр. Человек снял
 * галочку «только с аудио», увидел пустоту и решил бы, что каталога нет вовсе.
 */
function emptyHint(author: string, q: string, onlyAudio: boolean): string {
  if (onlyAudio) {
    // Фильтр аудио — единственный, при котором «ничего не нашлось» ничего не
    // говорит о каталоге: книг без аудио там может быть сколько угодно.
    return author !== '' || q !== ''
      ? 'Под фильтрами книг с аудио не нашлось. Снимите галочку «только с аудио» или уточните запрос.'
      : 'Под фильтром «только с аудио» пусто: ни одной книги с аудио в каталоге нет. Снимите галочку, чтобы увидеть остальные.';
  }

  if (author !== '' || q !== '') {
    return 'Попробуйте другую фамилию или снимите фильтр по автору: в названии она может быть написана иначе.';
  }

  return 'Каталог пока пуст. Книги добавляет администратор — попросите его, если нужная не нашлась.';
}