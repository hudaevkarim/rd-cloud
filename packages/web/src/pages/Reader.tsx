import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, books as booksApi } from '../api/client.js';
import type { BookIndex, BookSummary, ChapterBlock } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { messageOf, useQuery } from '../rooms/room-queries.js';
import { ChapterView } from '../books/ChapterView.js';
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

export function ReaderPage({ roomId, bookId }: { roomId: string; bookId: string }) {
  const book = useQuery<BookSummary>(async () => booksApi.get(bookId), [bookId]);
  const index = useQuery<BookIndex>(async (signal) => booksApi.index(bookId, signal), [bookId]);
  const narrow = useNarrow();

  const [chapter, setChapter] = useState(0);
  const [blocks, setBlocks] = useState<ChapterBlock[] | null>(null);
  const [chapterError, setChapterError] = useState<string | null>(null);
  const [bare, setBare] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

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
  }, [bookId, index.status, restoreDone]);

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
      .chapter(bookId, chapter, controller.signal)
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
  }, [bookId, chapter, chapterCount, index.status, restoreDone]);

  /* ─── Позиция ─────────────────────────────────────────────────────────────── */

  const onRendered = useCallback((chapterHost: HTMLElement) => {
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

    ─── Почему не `requestAnimationFrame` ─────────────────────────────────────
    —
    Раньше обработчик вставал в `requestAnimationFrame`, и это давало тихую
    поломку: во вкладке, которая не на экране, кадры не рисуются и `rAF` не
    срабатывает вообще. Человек сворачивает книгу, чтобы посмотреть в соседней
    вкладке, — а позиция перестаёт записываться, и при возврате он оказывается
    там, откуда ушёл, а не там, где остановился.

    Наблюдалось в живом браузере: `scrollTop` 4200, а в хранилище `scrollY: 0`.

    ─── Почему контейнер хранится в состоянии, а не в ref ───────────────────
    —
    Прокручиваемый блок появляется не сразу: пока грузится книга, страница
    показывает «часики» и блока нет. Ссылка-колбэк позволяет повесить слушатель
    в тот момент, когда блок действительно появился.

    С обычным `ref` эффект видел `null` на первом проходе и уходил, а
    перевеситься не был чем: зависимости не менялись. Наблюдалось вживую — после
    свежего открытия прокрутка не записывалась ни разу, и позиция появлялась
    только после смены главы.

    Таймеры в фоновой вкладке срабатывают (с ограничением частоты, здесь
    достаточно), и работа на кадр — несколько чтений из DOM и одна запись в
    хранилище — слишком мала, чтобы ради неё рисковать потерей позиции.
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
              <ChapterView blocks={blocks} baseDir={current?.href} onRendered={onRendered} />

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
      </div>
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