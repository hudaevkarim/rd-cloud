import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, books as booksApi, comments as commentsApi } from '../api/client.js';
import type { BookIndex, BookSummary, ChapterBlock, CommentPage, WireComment } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { messageOf, useQuery } from '../rooms/room-queries.js';
import { useAuth } from '../auth/auth-context.js';
import { ChapterView } from '../books/ChapterView.js';
import { CommentComposer } from '../books/CommentComposer.js';
import { CommentsPanel } from '../books/CommentsPanel.js';
import { addComment as addToTree } from '../books/comments-tree.js';
import { scrollBehavior } from '../books/scroll-behavior.js';
import { COMMENT_ATTR } from '../books/comment-markers.js';
import {
  createPositionSaver,
  readPosition,
  type PositionStorage,
  type ReadingPosition,
} from '../books/reading-position.js';

/**
 * Читалка.
 *
 * ─── Три запроса и почему именно три ─────────────────────────────────────────
 *
 * Метаданные книги, оглавление и первая глава. Оглавление нужно до первой
 * главы: без него неизвестно, сколько их и как они называются, а «следующая
 * глава» без числа глав неотличима от последней.
 *
 * ─── Почему позиция восстанавливается после рендера, а не до ────────────────
 *
 * Прокручивать к блоку можно только когда блок есть в DOM. Восстановление до
 * рендера искало бы пустоту и теряло позицию. Поэтому рендер сообщает о себе
 * через `onRendered`, и только тогда страница меряет и прокручивает.
 *
 * ─── Почему читается блок, а не страница ─────────────────────────────────────
 *
 * Позиция нужна там, где человек остановился, а блок — самая мелкая единица,
 * которая переживает смену размера шрифта и ширины окна. Сохранять координаты
 * экрана значило бы возвращать человека «примерно туда же» — и каждый раз
 * немного мимо.
 */

/**
 * Пауза перед записью позиции при прокрутке.
 *
 * Меньше секунды: она нужна, чтобы десятки событий прокрутки превратились в одну
 * запись, но человек при возврате к потерянному месту не должен ждать.
 */
const SAVE_COALESCE_MS = 150;

/**
 * Сколько комментариев забираем за один запрос.
 *
 * 100 — потолок сервера (`MAX_LIMIT` в `routes/comments.ts`), и `zod`
 * отвергает большее число как ошибку запроса: страница обсуждения просто не
 * открылась бы. Значение дублируется здесь намеренно, как `NARROW_QUERY`
 * ниже: правило одно на стороне сервера и клиента, а общей константы между
 * пакетами нет.
 */
const COMMENT_PAGE_LIMIT = 100;

/**
 * Постоянный пустой список.
 *
 * Нужен, чтобы пропуски отфильтрованных комментариев не выглядели сменой
 * данных: без него `allComments` получал бы новый массив на каждом рендере, и
 * зависимость `useMemo` ниже пересчитывала бы фильтр без причины.
 */
const EMPTY_COMMENTS: WireComment[] = [];

/**
 * Сколько миллисекунд горит подсветка найденного комментария.
 *
 * Ровно секунда: меньше — человек не успевает посмотреть, куда его увели, больше
 * — подсветка начинает выглядеть как постоянное выделение и мешает читать
 * дальше. Длительность анимации в CSS такая же, синхронно они не связаны: класс
 * снимается по этому таймеру, а анимация просто заканчивается вместе с ним.
 */
const FLASH_MS = 1_000;

/**
 * Номер главы из текстового якоря.
 *
 * `anchor` приходит с сервера как `unknown` — это осознанно: значение
 * присылает сервер, и клиент не должен притворяться, что проверил его тип.
 * Здесь единственное место, где якорь читается по полям, поэтому проверка
 * обязана быть здесь, а не в компоненте маркеров.
 */
function textAnchorChapter(comment: WireComment): number | null {
  const anchor = comment.anchor;
  if (typeof anchor !== 'object' || anchor === null) return null;
  const value = (anchor as { chapterIndex?: unknown }).chapterIndex;
  return typeof value === 'number' ? value : null;
}

export function ReaderPage({ roomId, bookId }: { roomId: string; bookId: string }) {
  const book = useQuery<BookSummary>(async () => booksApi.get(roomId, bookId), [roomId, bookId]);
  const index = useQuery<BookIndex>(
    async (signal) => booksApi.index(roomId, bookId, signal),
    [roomId, bookId],
  );
  const narrow = useNarrow();
  /*
    Идентификатор текущего пользователя — только ради пометки «вы» у собственных
    ответов. Пока человек не входил, его нет, и подставлять пустую строку
    правильнее, чем рисовать пометку у всех подряд.
  */
  const { user: me } = useAuth();

  const [chapter, setChapter] = useState(0);
  const [blocks, setBlocks] = useState<ChapterBlock[] | null>(null);
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [bare, setBare] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  /** Контейнер отрисованной главы: по нему ищем якорь выделения. */
  const [chapterHost, setChapterHost] = useState<HTMLElement | null>(null);

  /*
    Комментарии книги.

    Запрашиваются на книгу, а не на главу: фильтр по `chapterIndex` всё равно
    делается на странице, а запрос на каждую главу означал бы, что при
    перелистывании человек ждёт сеть, чтобы увидеть чужие пометки в тексте, и
    при первом же сбое запроса остаётся с главой без маркеров.

    Потолок `limit` на сервере — 100 (`MAX_LIMIT`), и `zod` отвергает большее
    число как ошибку запроса. Поэтому «забрать всё» здесь означает 100: на
    десять-двадцать человек этого хватает с запасом, а когда перестанет —
    пагинация появится вместе с боковой панелью в 7.4.2.3, где она и нужна.

    Ошибка загрузки не показывается читателю и не мешает чтению: главный текст
    книги тут важнее обсуждения. Комментарии без маркеров выглядят как обычная
    страница книги, что и требуется при недоступном обсуждении.
  */
  /*
    Комментарии грузятся вместе со страницей, а не по первому выделению.

    Запрос при выделении выглядел бы экономнее, но платил бы каждый раз заново:
    прокрутка, переход между главами и первый экран — три разных момента, и на
    первом человек увидел бы главу без чужих пометок, то есть маркеры появились
    бы не с книгой, а с движением мыши. Один запрос на книгу предсказуем.
  */
  const commentPage = useQuery<CommentPage>(
    async (signal) => commentsApi.list(roomId, bookId, { limit: COMMENT_PAGE_LIMIT }, signal),
    [roomId, bookId],
  );

  /*
    Комментарии, добавленные в этой сессии.

    Отдельное состояние, а не перезагрузка списка: ответ сервера содержит уже
    присланный комментарий, и повторный запрос после отправки стоил бы ещё
    одного захода в сеть ради данных, которые уже в руках. Список и правленые
    комментарии соединяются ниже, поэтому оба видны одинаково.

    Пока сокета нет (7.4.2.4), это единственный способ увидеть свой комментарий
    без перезагрузки страницы: маркер появляется в ту же секунду, что и ответ
    сервера, и глава не перерисовывается.
  */
  const [myComments, setMyComments] = useState<WireComment[]>([]);
  const addComment = useCallback((comment: WireComment) => {
    setMyComments((current) => (current.some((c) => c.id === comment.id) ? current : addToTree(current, comment)));
  }, []);

  /*
    Ответ приходит с тем же якорем, что и родитель, поэтому он попадает в
    `commentsOfChapter` тем же фильтром и без отдельной обработки: единственное,
    что нужно, — положить его не в список, а в тред родителя.
  */
  const [myReplies, setMyReplies] = useState<Record<string, WireComment[]>>({});
  const addReply = useCallback((parentId: string, reply: WireComment) => {
    setMyReplies((current) => {
      const existing = current[parentId] ?? [];
      if (existing.some((r) => r.id === reply.id)) return current;
      return { ...current, [parentId]: [...existing, reply] };
    });
  }, []);

  /** Комментарий, к которому панель должна подкрутить: из маркера в тексте. */
  const [panelFocus, setPanelFocus] = useState<string | null>(null);
  /** Комментарий, который в панели горит после клика по маркеру. */
  const [panelFlash, setPanelFlash] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  /** Идентификатор маркера, который человек открыл из панели. */
  const [markFlash, setMarkFlash] = useState<string | null>(null);

  /**
   * Подсветка гаснет сама.
   *
   * Таймер, а не постоянный класс: иначе подсветка горела бы до следующего
   * клика и выглядела бы как «этот комментарий выделен», а не «сюда пришли».
   */
  useEffect(() => {
    if (panelFlash === null) return;
    const timer = window.setTimeout(() => setPanelFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [panelFlash]);

  useEffect(() => {
    if (markFlash === null) return;
    const timer = window.setTimeout(() => setMarkFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [markFlash]);

  /** Клик по маркеру в тексте: панель к этому комментарию. */
  const onMarkerClick = useCallback((commentId: string) => {
    setPanelOpen(true);
    setPanelFocus(commentId);
    setPanelFlash(commentId);
  }, []);

  /**
   * Клик по комментарию в панели: текст к его маркеру.
   *
   * Прокрутка идёт по самому маркеру, а не по блоку: человек кликнул на
   * конкретную фразу и хочет видеть именно её, а не начало абзаца.
   */
  const onCardClick = useCallback((commentId: string) => {
    setPanelOpen(true);
    const mark = chapterHost?.querySelector(`[data-comment-id="${commentId}"]`);
    if (mark === undefined || mark === null) return;
    mark.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
    setMarkFlash(commentId);
  }, [chapterHost]);

  /*
    Клик по маркеру должен и панель открыть, и комментарий найти. Слушатель
    висит на контейнере главы, а не на документе: перехватывать клики по всей
    странице означало бы ловить и нажатия на панели, и на кнопки читалки.
  */
  useEffect(() => {
    if (chapterHost === null) return;
    const onClick = (event: MouseEvent): void => {
      const mark = (event.target as HTMLElement | null)?.closest?.(`[${COMMENT_ATTR}]`);
      if (mark === null || mark === undefined) return;
      const id = mark.getAttribute(COMMENT_ATTR);
      if (id !== null && id !== '') onMarkerClick(id);
    };
    chapterHost.addEventListener('click', onClick);
    return () => chapterHost.removeEventListener('click', onClick);
  }, [chapterHost, onMarkerClick]);

  /*
    Комментарии текущей главы.

    `useMemo` обязателен, а не оптимизация: без него `filter` даёт новый массив
    на каждом рендере страницы, и `ChapterView` получил бы в пропсах новую
    ссылку на каждом кадре — а его второй эффект зависит от `comments` и
    пересчитывал бы маркеры на каждом рендере страницы.

    Фильтр уважает тип якоря: у аудиокомментария `chapterIndex` нет, и без
    проверки он отсеивался бы правильно (`undefined !== chapter`), но по
    неверной причине. Явная проверка читается как правило, а не как совпадение.

    Ответ без массива — тоже не повод падать на книге: `comments` приходит как
    `CommentPage`, но поле внутри него ничем не защищено на стороне клиента, и
    при расхождении схем человек потерял бы даже текст. Пустой список даёт
    обычную страницу книги.
  */
  const commentsOfChapter = useMemo(() => {
    /*
      Два пути, а не `ready ? data.comments : []`.

      Пока комментарий добавлен этой сессией, его надо показать даже если запрос
      списка ещё грузится: человек только что отправил реплику и ждёт её
      появления, а пустой список отдал бы пустую главу и убрал бы только что
      увиденную отметку. Серверный список придёт и добавит своё, а совпадение по
      `id` уберёт дубль.
    */
    const fromServer = commentPage.status === 'ready' ? commentPage.data.comments : EMPTY_COMMENTS;
    /*
      Слияние по `id`, а не конкатенация: серверный список и правленый содержат
      один и тот же комментарий, как только список перезагрузится — в 7.4.2.4
      это случится при первом же событии сокета. Без проверки на блоке появился
      бы второй маркер поверх первого, и в списке было бы два одинаковых.
    */
    const seen = new Set(myComments.map((c) => c.id));
    const merged = Array.isArray(fromServer)
      ? [...fromServer.filter((c) => !seen.has(c.id)), ...myComments]
      : myComments;
    const withReplies = merged.map((c) => {
      const replies = myReplies[c.id];
      return replies === undefined || replies.length === 0 ? c : { ...c, replies: [...(c.replies ?? []), ...replies] };
    });
    return withReplies.filter((c) => c.anchorType === 'text' && textAnchorChapter(c) === chapter);
  }, [commentPage, myComments, myReplies, chapter]);

  /*
    Прокручиваемый блок хранится в ссылке и в состоянии одновременно, и это не
    избыточность.

    Ссылка нужна для чтения сразу при фиксации DOM: ссылки обновляются во время
    фиксации, до выполнения эффектов, и потому всегда актуальна.

    Состояние нужно для того, чтобы эффект слушателя прокрутки перезапускался
    ровно тогда, когда блок появился или исчез. Пока грузится книга, блока на
    экране нет, и эффект видел бы пустую ссылку и ушёл бы навсегда: на
    живой странице прокрутка после свежего открытия не записывалась ни разу.
  */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  const attachScroller = useCallback((el: HTMLDivElement | null) => {
    scrollerRef.current = el;
    setScroller(el);
  }, []);
  const saver = useMemo(() => createPositionSaver(bookId, positionStorage()), [bookId]);
  /**
   * Позиция, к которой надо вернуться.
   *
   * Живёт до смены главы, а не до первого прохода: под StrictMode эффект
   * рендера главы вызывается дважды, и сброс после первого уводил прокрутку
   * вверх вторым. Подробности — в `onRendered`.
   */
  const pending = useRef<ReadingPosition | null>(null);
  /** Решение «куда возвращаться» принято. Главы грузятся только после него. */
  const [restoreDone, setRestoreDone] = useState(false);

  const chapters = index.status === 'ready' ? index.data.chapters : [];
  const chapterCount = chapters.length;
  const current = chapters[chapter];

  /*
    Восстановление позиции — эффектом, а не прямо в теле компонента.
    —
    Сначала это было написано в теле рендера: `setState` во время рендера того же
    компонента React обрабатывает, но только если компонент не в StrictMode.
    В StrictMode рендер вызывается дважды, первая попытка отбрасывается вместе с
    поставленным в очередь `setChapter`, а флаг «уже восстановились» успевает
    встать. Итог: позиция читалась, номер главы менялся — и тут же терялся, и
    книга открывалась с первой главы.

    Наблюдалось в живом браузере: в хранилище `chapter: 8`, открыта глава 1, в
    журнале сервера запроса `ch/8.json` нет. Тесты это не видели: они рендерят
    без StrictMode — ровно тот случай, который уже ломал страницу входа по коду
    в 7.2. Ниже проверка обёрнута в StrictMode.
  */
  useEffect(() => {
    if (index.status !== 'ready' || restoreDone) return;

    const saved = readPosition(bookId, positionStorage());
    // Номер главы здесь не обрезается: правило одно, и оно живёт в эффекте
    // загрузки. Два обрезания в двух местах разошлись бы при первой же правке.
    if (saved !== null) {
      pending.current = saved;
      setChapter(saved.chapter);
    }
    setRestoreDone(true);
  }, [roomId, bookId, index.status, restoreDone]);

  /* ─── Глава ───────────────────────────────────────────────────────────────── */

  useEffect(() => {
    // Пока не решено, куда возвращаться, грузить нечего: иначе первая глава
    // была бы запрошена и выброшена, а на медленной сети человек увидел бы
    // лишний переход.
    if (index.status !== 'ready' || chapterCount === 0 || restoreDone === false) return;

    /*
      Глав меньше, чем помнили: сохранённая позиция ушла за конец книги — или
      книгу пересобрали из другого издания. Открываем последнюю, а не первую:
      человек, скорее всего, долистывал до конца, и возврат в начало выглядел бы
      как «позиция потерялась».
    */
    if (chapter >= chapterCount) {
      setChapter(Math.max(0, chapterCount - 1));
      return;
    }

    const controller = new AbortController();
    let stale = false;
    setBlocks(null);
    setChapterError(null);

    booksApi
      .chapter(roomId, bookId, chapter, controller.signal)
      .then((data) => {
        if (!stale) setBlocks(data);
      })
      .catch((error: unknown) => {
        if (stale || controller.signal.aborted) return;
        setChapterError(error instanceof ApiError ? error.message : messageOf(error));
      });

    return () => {
      stale = true;
      controller.abort();
    };
  }, [roomId, bookId, chapter, chapterCount, index.status, restoreDone]);

  /* ─── Позиция ─────────────────────────────────────────────────────────────── */

  const onRendered = useCallback((chapterHost: HTMLElement) => {
    /*
      Контейнер главы нужен не только для позиции: по нему вычисляется якорь
      из выделения мышью. React не создаёт новый элемент при каждом рендере,
      поэтому присваивание того же значения состояния перерисовку не вызывает —
      лишних проходов на каждый ответ сервера не будет.
    */
    setChapterHost(chapterHost);

    // Прокручивается не глава, а блок вокруг неё, поэтому ссылка на него, а не
    // сам `chapterHost`.
    const host = scrollerRef.current;
    if (host === null) return;

    const target = pending.current;

    if (target === null) {
      host.scrollTop = 0;
      return;
    }

    /*
      Раскладку приходится принудительно завершить, иначе прокрутка ставится
      вслепую.

      Только что в контейнер вставлен текст главы, но браузер ещё не измерил
      высоту: `scrollHeight` ещё старый. Присваивание `scrollTop = 7668` в
      контейнер высотой 40px обрезается до нуля — и человек открывает главу
      ровно с того места, где и так был.

      Чтение `scrollHeight` заставляет браузер досчитать раскладку. Стоит перед
      установкой прокрутки и ничего не стоит: это одна выборка из уже готового
      дерева.
    */
    const height = host.scrollHeight;
    if (height === 0) return;

    // Блок ищем по `data-block`: рендерер ставит этот атрибут на каждый элемент,
    // и по нему же потом ищутся якоря комментариев. Ищем внутри контейнера
    // главы, а не всего документа: глав на странице одна, но проверка должна
    // быть верной и при появлении второй.
    const el = chapterHost.querySelector(`[data-block="${target.block}"]`);
    if (el === null) {
      // Блок не нашёлся: книгу пересобрали или это была другая глава. Тогда
      // возвращаемся к сохранённому месту экрана — это ближе, чем в начало.
      host.scrollTop = target.scrollY;
      return;
    }

    host.scrollTop = Math.max(0, (el as HTMLElement).offsetTop - 24);

    /*
      Позиция намеренно НЕ сбрасывается здесь.

      Под StrictMode эффект монтирования вызывается дважды, и второй проход
      видел `pending` уже пустым — а значит, уводил прокрутку в начало главы
      сразу после того, как первый её вернул. Наблюдалось в браузере: в
      хранилище `scrollY: 8000`, а глава открывалась наверху.

      Позиция живёт до смены главы: её сбрасывают `go` и `jump`. Повторный вызов
      восстановит ту же прокрутку, что и нужно — он идемпотентен.
    */
  }, []);

  /** Номер блока, ближайший к верхней границе просмотра. */
  const currentBlock = useCallback((): number => {
    const host = scrollerRef.current;
    if (host === null) return 0;

    const top = host.scrollTop + 24;
    const els = host.querySelectorAll<HTMLElement>('[data-block]');

    let found = 0;
    for (const el of els) {
      if (el.offsetTop <= top) found = Number(el.getAttribute('data-block'));
      else break;
    }
    return found;
  }, []);

  const scheduleSave = useCallback(() => {
    saver.schedule({
      chapter,
      block: currentBlock(),
      scrollY: scrollerRef.current?.scrollTop ?? 0,
    });
  }, [saver, chapter, currentBlock]);

  /*
    Прокрутка шлёт событие десятками раз в секунду, поэтому оно огрубляется
    таймером.

    ┌──────────────────────────────────────────────────────────────────────────┐
    │ НЕ ВОЗВРАЩАТЬ НА `requestAnimationFrame`.                                │
    │                                                                          │
    │ `rAF` здесь не «правильнее» — он просто не работает там, где работает     │
    │ таймер: во вкладке, которая не на экране, браузер не рисует кадры и не    │
    │ вызывает `rAF` вовсе. Человек сворачивает книгу, чтобы посмотреть в      │
    │ соседней вкладке, и в этот момент позиция перестаёт записываться;        │
    │ вернувшись, он оказывается там, откуда ушёл.                              │
    │                                                                          │
    │ Замерено в живом браузере: вкладка в фоне, `scrollTop` 4200, а в           │
    │ хранилище `scrollY: 0`. Ни один тест этого не видел: в jsdom вкладка      │
    │ всегда «на экране», и `rAF` исправно срабатывает.                         │
    │                                                                          │
    │ Работа на кадр — несколько чтений из DOM и одна запись в хранилище, то    │
    │ есть слишком мало, чтобы ради неё рисковать потерей позиции.              │
    └──────────────────────────────────────────────────────────────────────────┘

    ─── Почему и состояние, и ссылка ───────────────────────────────────────────
    —
    Прокручиваемый блок появляется не сразу: пока грузится книга, страница
    показывает «часики» и блока нет.

    Ссылка нужна, чтобы прочитать элемент сразу при фиксации DOM — ссылки
    обновляются до выполнения эффектов. Состояние нужно, чтобы этот эффект
    перезапускался ровно тогда, когда блок появился: со ссылкой он видел бы
    `null` на первом проходе и ушёл бы, а перевеситься не был бы чем. Наблюдалось
    вживую: после свежего открытия прокрутка не записывалась ни разу.
  */
  useEffect(() => {
    const host = scroller;
    if (host === null) return;

    let timer: number | null = null;
    const onScroll = (): void => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        scheduleSave();
      }, SAVE_COALESCE_MS);
    };

    host.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      host.removeEventListener('scroll', onScroll);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [scheduleSave, scroller]);

  /*
    Уход со страницы: запись последней позиции. На `pagehide`, а не на
    `beforeunload`, — на телефоне `beforeunload` может не прийти вовсе, а
    страница закрывается, и человек возвращается в начало книги.
  */
  useEffect(() => {
    const onLeave = (): void => saver.flush();
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.removeEventListener('pagehide', onLeave);
      onLeave();
    };
  }, [saver]);

  /*
    Смена главы — тоже повод записать, и без всякой задержки.
    —
    Три правки по итогам живых проверок.

    Первая: стоял `flush` вместо `schedule`, и позиция знала только о прокрутке.
    Человек нажимал «Следующая», дочитывал и закрывал вкладку — прокрутки не
    было, `latest` пустой, и возврат шёл в начало книги.

    Вторая: стоял `schedule`, и запись появлялась через секунду. Замерено в
    браузере: переход на главу и перезагрузка в пределах этой секунды возвращали
    человека на предыдущую главу.

    Третья, самая неприятная: первая же загрузка главы затирала только что
    восстановленную позицию нулями. Человек открывает книгу, восстановление
    отматывает его на нужный абзац, а сохранение в тот же кадр пишет «начало
    главы» — и при возврате он оказывается в начале. Поэтому первый проход
    пропускается: на нём позицию ещё не восстановили, записывать нечего.

    Порядок важен: сначала отметить, потом записать — иначе `flush` не увидит
    новой позиции.
  */
  const firstChapterSave = useRef(true);
  useEffect(() => {
    if (blocks === null) return;
    if (firstChapterSave.current) {
      firstChapterSave.current = false;
      return;
    }
    saver.schedule({ chapter, block: 0, scrollY: 0 });
    saver.flush();
  }, [chapter, blocks, saver]);

  /* ─── Навигация ───────────────────────────────────────────────────────────── */

  const go = useCallback(
    (delta: number) => {
      const next = chapter + delta;
      if (next < 0 || next >= chapterCount) return;
      pending.current = null;
      setChapter(next);
    },
    [chapter, chapterCount],
  );

  const jump = useCallback((to: number) => {
    pending.current = null;
    setChapter(to);
    setTocOpen(false);
  }, []);

  /*
    Горячие клавиши.
    —
    Слушатель на `document`, а не на контейнере: прокручиваемый блок не всегда
    в фокусе, и на нём клавиши не сработали бы, пока человек не кликнул по
    тексту.

    Поля ввода пропускаются: стрелка в поле поиска должна двигать курсор, а
    листать книгу — нет.
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // С модификаторами не вмешиваемся: ctrl+стрелка — это «в начало/в конец».
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        go(1);
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        go(-1);
        return;
      }
      if (event.key === 'Escape') {
        // Закрывается то, что открыто: панель оглавления, иначе полный экран.
        if (tocOpen) setTocOpen(false);
        else if (bare) setBare(false);
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go, bare, tocOpen]);

  /* ─── Отрисовка ───────────────────────────────────────────────────────────── */

  if (book.status === 'loading') {
    return (
      <div className="page__center">
        <Spinner size={20} label="Открываем книгу" />
      </div>
    );
  }

  if (book.status === 'error') {
    return <ReaderNotice message={book.error} roomId={roomId} />;
  }

  const data = book.data;

  if (!data.hasText) {
    return <ReaderNotice message="У книги нет текста — её можно только слушать." roomId={roomId} />;
  }

  const isParsed = data.files.some((f) => f.kind === 'text' && f.parsed);

  return (
    <div className={`reader${bare ? ' reader--bare' : ''}`} data-bare={bare ? 'true' : 'false'}>
      <header className="reader__bar">
        <Link className="reader__back link" to={`/rooms/${roomId}`}>
          В комнату
        </Link>

        <span className="reader__where label label-xs">
          {chapterCount === 0
            ? data.title
            : `Глава ${chapter + 1} из ${chapterCount}${current === undefined || current.title === '' ? '' : ` · ${current.title}`}`}
        </span>

        <button
          type="button"
          className="reader__toc-toggle"
          onClick={() => setTocOpen((open) => !open)}
          aria-expanded={tocOpen}
          aria-label="Оглавление"
        >
          Оглавление
        </button>

        <button
          type="button"
          className="reader__comments-toggle"
          onClick={() => setPanelOpen((on) => !on)}
          aria-pressed={panelOpen}
          aria-label="Комментарии к главе"
        >
          Комментарии{commentsOfChapter.length > 0 && ` · ${commentsOfChapter.length}`}
        </button>

        <button
          type="button"
          className="reader__bare-toggle"
          onClick={() => setBare((on) => !on)}
          aria-pressed={bare}
        >
          {bare ? 'Показать панели' : 'Скрыть виджеты'}
        </button>
      </header>

      <div
        className="reader__progress"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={Math.max(1, chapterCount)}
        aria-valuenow={chapter + 1}
        aria-label="Прогресс по главам"
      >
        <span
          className="reader__progress-fill"
          style={{
            transform: `scaleX(${chapterCount === 0 ? 0 : (chapter + 1) / chapterCount})`,
          }}
        />
      </div>

      <div className="reader__body">
        <nav
          className={`reader__toc${tocOpen ? ' is-open' : ''}`}
          aria-label="Оглавление"
          /*
            Панель убирается от скринридера только когда она действительно закрыта:
            на узком экране это закрытая выдвижная панель, а на широком то же самое
            оглавление всегда на виду. Без условия по ширине панель была бы
            «невидимой» и на десктопе, и человек на голосовом экранe получил бы
            книгу без оглавления.
          */
          aria-hidden={narrow && !tocOpen ? 'true' : undefined}
        >
          {chapters.length === 0 ? (
            <p className="reader__toc-empty label label-xs">Оглавление не разобрано</p>
          ) : (
            <ol className="reader__toc-list">
              {chapters.map((item) => (
                <li key={item.index}>
                  <button
                    type="button"
                    className={`reader__toc-item${item.index === chapter ? ' is-current' : ''}`}
                    aria-current={item.index === chapter ? 'true' : undefined}
                    onClick={() => jump(item.index)}
                  >
                    {item.title === '' ? `Глава ${item.index + 1}` : item.title}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </nav>

        <div className="reader__main" ref={attachScroller}>
          {index.status === 'loading' && (
            <div className="page__center">
              <Spinner size={20} label="Открываем оглавление" />
            </div>
          )}

          {index.status === 'error' && <ReaderNotice message={index.error} roomId={roomId} />}

          {index.status === 'ready' && !isParsed && (
            <ReaderNotice message="Книга не разобрана: загрузите её заново." roomId={roomId} />
          )}

          {index.status === 'ready' && isParsed && chapterCount === 0 && (
            <ReaderNotice message="В книге нет ни одной главы." roomId={roomId} />
          )}

          {chapterError !== null && <p className="formproblem">{chapterError}</p>}

          {blocks !== null && chapterError === null && (
            <>
              <h1 className="reader__title">{data.title}</h1>
              <p className="reader__author">{data.author}</p>
              <Rule />
              <ChapterView
                blocks={blocks}
                baseDir={current?.href}
                comments={commentsOfChapter}
                chapterIndex={chapter}
                onRendered={onRendered}
                flashId={markFlash}
              />

              <nav className="reader__nav" aria-label="Главы">
                <Button variant="ghost" onClick={() => go(-1)} disabled={chapter === 0}>
                  Предыдущая
                </Button>
                <Button variant="ghost" onClick={() => go(1)} disabled={chapter >= chapterCount - 1}>
                  Следующая
                </Button>
              </nav>
            </>
          )}
        </div>

        {/*
          Панель — третья колонка внутри `.reader__body`, а не рядом с ним:
          иначе её ширина не вошла бы в ту же строку и колонка текста не сдвинулась
          бы при её появлении.

          На узком экране та же разметка уезжает поверх текста по `translateX`,
          как оглавление: две выдвижные панели с одинаковым приёмом и одинаковым
          правилом закрытия — это меньше кода, чем лист снизу с новым жестом.
        */}
        <CommentsPanel
          roomId={roomId}
          bookId={bookId}
          comments={commentsOfChapter}
          meId={me?.id ?? ''}
          focusId={panelFocus}
          flashId={panelFlash}
          open={panelOpen}
          onToggle={() => setPanelOpen((on) => !on)}
          onAdd={addComment}
          onAddReply={addReply}
          onPick={onCardClick}
        />
      </div>

      {/*
        Комментарии к тексту живут вне прокручиваемого блока, но внутри каркаса
        читалки: их кнопка позиционируется от координат окна, а окно при
        `position: fixed` не зависит от прокрутки — поэтому при листании кнопка
        не уезжает вместе с абзацем.
      */}
      <CommentComposer
        host={chapterHost}
        chapterIndex={chapter}
        roomId={roomId}
        bookId={bookId}
        onCreated={addComment}
      />
    </div>
  );
}

/**
 * Заглушка для состояний без текста.
 *
 * Ссылка на комнату обязательна во всех случаях: человек, пришедший в читалку по
 * ссылке, должен иметь куда вернуться, даже когда читать нечего.
 */
function ReaderNotice({ message, roomId }: { message: string; roomId: string }) {
  return (
    <div className="page page--center">
      <Label size="xs" as="p">
        ЧИТАЛКА
      </Label>
      <h1 className="placeholder__title">Не читается</h1>
      <p className="placeholder__hint">{message}</p>
      <Link className="btn" to={`/rooms/${roomId}`}>
        В комнату
      </Link>
    </div>
  );
}

/** `localStorage` с безопасным доступом: в приватном режиме он бросает. */
function positionStorage(): PositionStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  };
}

/**
 * Узкий экран — тот же порог, что и в `reader.css`.
 *
 * Число дублировано, а не взято из CSS: правило медиазапроса недоступно из
 * JavaScript, и единственный способ узнать о нём — спросить `matchMedia`.
 * Проверка на ширину окна не годится: у неё нет сантимиллисекундного
 * обновления, и после поворота телефона панель осталась бы в прошлом состоянии.
 */
const NARROW_QUERY = '(max-width: 767px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);

  useEffect(() => {
    const media = window.matchMedia(NARROW_QUERY);
    const onChange = (): void => setNarrow(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return narrow;
}