import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, comments as commentsApi } from '../api/client.js';
import type { WireComment } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { repliesOf, sortByPosition } from './comments-tree.js';
import { scrollBehavior } from './scroll-behavior.js';

/**
 * Панель комментариев к главе.
 *
 * ─── Почему на мобильном это выдвижная панель, а не лист снизу ────────────────
 *
 * В проекте уже есть выдвижное оглавление: на узком экране оно уезжает
 * поверх текста по `translateX`. Панель сделана так же — тем же приёмом, тем же
 * переключателем в шапке читалки. Лист снизу потребовал бы жеста перетаскивания,
 * полупрозрачной подложки и второго правила закрытия, то есть трёх новых
 * вещей для показа списка, который умещается в ту же форму.
 *
 * ─── Почему ответ не в модальном окне ─────────────────────────────────────────
 *
 * Ответ — продолжение разговора, а не новая задача. Модальное окно убирает
 * исходный комментарий из поля зрения, и человек перечитывает его, чтобы
 * понять, на что отвечает. Раскрывающееся поле оставляет оба текста рядом.
 */

/*
  Длительность подсветки задана в CSS, а не константой здесь.

  Подсветка живёт ровно одну анимацию: заканчивается она вместе с классом,
  который снимает страница по таймеру. Синхронизировать две длительности в
  двух файлах — значит однажды забыть про одну и получить подсветку, которая
  гаснет раньше, чем её сняли, или мигает второй раз.
*/

export interface CommentsPanelProps {
  roomId: string;
  bookId: string;
  /** Корневые комментарии главы — сортируются здесь же. */
  comments: WireComment[];
  /** Пользователь, от имени которого отправляются ответы. */
  meId: string;
  /** Комментарий, к которому панель должна подкрутить: `null` — не прокручивать. */
  focusId: string | null;
  /** Идентификатор комментария, который человек открыл из текста. */
  flashId: string | null;
  /** Развёрнута ли панель. На десктопе она всегда на виду, но кнопка есть. */
  open: boolean;
  onToggle: () => void;
  onAdd: (comment: WireComment) => void;
  /** Ответ уходит к своему родителю, а не в список корневых. */
  onAddReply: (parentId: string, reply: WireComment) => void;
  /** Клик по комментарию: прокрутка текста к его маркеру. */
  onPick?: (commentId: string) => void;
}

export function CommentsPanel({
  roomId,
  bookId,
  comments,
  meId,
  focusId,
  flashId,
  open,
  onToggle,
  onAdd,
  onAddReply,
  onPick,
}: CommentsPanelProps) {
  const listRef = useRef<HTMLDivElement | null>(null);

  /*
    Сортировка на месте: `comments` приходит уже отфильтрованным по главе, и
    копия означала бы, что панель держит второй список комментариев главы.
    Мутация безопасна — массив создаётся фильтром на странице и здесь уже никем
    не используется.
  */
  const ordered = useMemo(() => sortByPosition(comments), [comments]);

  /*
    Прокрутка к комментарию из маркера.

    `scrollIntoView` вместо расчёта `offsetTop`: панель — это отдельный
    прокручиваемый блок, и браузер знает, как прокрутить до элемента внутри
    него, не трогая остальную страницу. Ручной расчёт пришлось бы повторять для
    каждого нового способа прокрутки браузера.

    Блок пропускается — иначе прокрутка целиком встанет на самое начало списка.
    Вид прокрутки спрашивается у `scrollBehavior`: движение, которое человек
    просил не показывать, не показывается и здесь.
  */
  useEffect(() => {
    if (focusId === null) return;
    const el = listRef.current?.querySelector(`[data-comment-card="${focusId}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  }, [focusId]);

  return (
    <aside className={`comments${open ? ' is-open' : ''}`} aria-label="Комментарии к главе">
      <header className="comments__head">
        <h2 className="comments__title">
          Комментарии
          <span className="comments__count label label-xs">{ordered.length}</span>
        </h2>
        {/*
          Сворачивание и на десктопе: третья колонка отдаёт тексту треть ширины,
          а человек читает книгу, а не переписку. Состояние общее с мобильным
          случаем — тот же переключатель, одна кнопка.
        */}
        <button
          type="button"
          className="comments__close"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? 'Скрыть комментарии' : 'Показать комментарии'}
        >
          {open ? '×' : '···'}
        </button>
      </header>

      <div className="comments__list" ref={listRef}>
        {ordered.length === 0 ? (
          <p className="comments__empty label label-xs">К этой главе пока нет комментариев</p>
        ) : (
          ordered.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              roomId={roomId}
              bookId={bookId}
              meId={meId}
              flash={flashId === comment.id}
              onAddReply={onAddReply}
              onPick={onPick}
            />
          ))
        )}
      </div>
    </aside>
  );
}

/** Один комментарий с ответами и формой ответа. */
function CommentCard({
  comment,
  roomId,
  bookId,
  meId,
  flash,
  onAddReply,
  onPick,
}: {
  comment: WireComment;
  roomId: string;
  bookId: string;
  meId: string;
  flash: boolean;
  onAddReply: (parentId: string, reply: WireComment) => void;
  onPick?: (commentId: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [text, setText] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const replies = repliesOf(comment);
  const quote = quoteOf(comment);

  const send = useCallback(async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === '' || busy) return;

    setBusy(true);
    setFailure(null);
    try {
      /*
        Якорь ответа — якор родителя.

        Ответ относится к тому же месту текста, что и комментарий, на который
        он отвечает: обсуждение ведётся вокруг фрагмента, а не вокруг ответа.
        Отдельного якоря у ответа и быть не может — привязать его было бы не к
        чему, и маркер на тексте не появился бы.

        `anchorType` не отправляется — как и при создании корневого.
      */
      const created = await commentsApi.create(roomId, bookId, {
        text: trimmed,
        bookFileKind: 'text',
        anchor: comment.anchor,
        parentId: comment.id,
      });
      onAddReply(comment.id, created);
      setText('');
      setReplying(false);
      // Свёрнутый тред после ответа раскрывается сам: человек только что
      // отправил реплику, и не увидеть её — обидное молчание.
      setCollapsed(false);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : 'Ответ не отправлен');
    } finally {
      setBusy(false);
    }
  }, [text, busy, comment.anchor, comment.id, roomId, bookId, onAddReply]);

  return (
    <article
      className={`comment${flash ? ' is-flash' : ''}`}
      data-comment-card={comment.id}
      onClick={onPick === undefined ? undefined : () => onPick(comment.id)}
    >
      <header className="comment__head">
        {comment.author.avatar !== null ? (
          <img className="comment__avatar" src={comment.author.avatar} alt="" />
        ) : (
          /*
            Инициалы вместо пустой аватарки: круг с буквой читается как человек,
            а пустой круг — как сломанная картинка.
          */
          <span className="comment__avatar comment__avatar--initial" aria-hidden="true">
            {initialsOf(comment.author.displayName)}
          </span>
        )}
        <span className="comment__author">{comment.author.displayName}</span>
        <time className="comment__time label label-xs" dateTime={comment.createdAt}>
          {when(comment.createdAt)}
        </time>
      </header>

      {quote !== null && <p className="comment__quote-inline">{quote}</p>}
      <p className="comment__text">{comment.text}</p>

      <footer className="comment__foot">
        <button
          type="button"
          className="comment__link"
          onClick={(event) => {
            event.stopPropagation();
            setReplying((on) => !on);
          }}
        >
          Ответить
        </button>

        {replies.length > 0 && (
          <button
            type="button"
            className="comment__link"
            onClick={(event) => {
              event.stopPropagation();
              setCollapsed((on) => !on);
            }}
            aria-expanded={!collapsed}
          >
            {collapsed ? `Показать ${replies.length} ${plural(replies.length)}` : 'Свернуть ответы'}
          </button>
        )}
      </footer>

      {replying && (
        <form
          className="comment__reply"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            className="field__input field__input--area"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void send();
              }
              if (event.key === 'Escape') setReplying(false);
            }}
            placeholder="Ответить"
            rows={2}
            disabled={busy}
            aria-label={`Ответ на комментарий ${comment.author.displayName}`}
            autoFocus
          />
          {failure !== null && (
            <p className="formproblem" role="alert">
              {failure}
            </p>
          )}
          <div className="comment__reply-actions">
            <Button
              variant="ghost"
              type="button"
              onClick={() => setReplying(false)}
              disabled={busy}
            >
              Отмена
            </Button>
            <Button type="submit" disabled={busy || text.trim() === ''}>
              {busy ? 'Отправляем…' : 'Отправить'}
            </Button>
          </div>
        </form>
      )}

      {!collapsed && replies.length > 0 && (
        <div className="comment__replies">
          {replies.map((reply) => (
            <ReplyCard key={reply.id} reply={reply} meId={meId} />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Ответ внутри треда.
 *
 * Отдельным компонентом, а не стилем на том же: у ответа нет ни кнопок, ни
 * своей формы, и повторять всё дерево элементов ради того, чтобы у него было
 * другое отступление, означало бы две копии разметки, которые разъедутся.
 */
function ReplyCard({ reply, meId }: { reply: WireComment; meId: string }) {
  return (
    <div className="comment__reply-card" data-comment-card={reply.id}>
      <header className="comment__head">
        {reply.author.avatar !== null ? (
          <img className="comment__avatar" src={reply.author.avatar} alt="" />
        ) : (
          <span className="comment__avatar comment__avatar--initial" aria-hidden="true">
            {initialsOf(reply.author.displayName)}
          </span>
        )}
        <span className="comment__author">{reply.author.displayName}</span>
        {reply.author.id === meId && <span className="comment__mine label label-xs">вы</span>}
        <time className="comment__time label label-xs" dateTime={reply.createdAt}>
          {when(reply.createdAt)}
        </time>
      </header>
      <p className="comment__text">{reply.text}</p>
    </div>
  );
}

/** Инициалы из имени: первые буквы двух первых слов. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const second = parts.length > 1 ? (parts[1]![0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** Цитата, за которую зацеплен комментарий, — первая строка. */
function quoteOf(comment: WireComment): string | null {
  const anchor = comment.anchor;
  if (typeof anchor !== 'object' || anchor === null) return null;
  const value = (anchor as { quote?: unknown }).quote;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Время в интерфейсе.
 *
 * Только «сегодня» и «вчера», дальше дата: точное время в обсуждении не решает
 * ничего, а год назад в переписке важнее, чем «19:42».
 */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date();
  const days = startOfDay(now) - startOfDay(at);
  if (days === 0) return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  if (days === 86_400_000) return 'вчера';
  return `${String(at.getDate()).padStart(2, '0')}.${String(at.getMonth() + 1).padStart(2, '0')}.${at.getFullYear()}`;
}

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/** Русское склонение: 1 ответ, 2 ответа, 5 ответов. */
function plural(count: number): string {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'ответов';
  const mod10 = count % 10;
  if (mod10 === 1) return 'ответ';
  if (mod10 >= 2 && mod10 <= 4) return 'ответа';
  return 'ответов';
}