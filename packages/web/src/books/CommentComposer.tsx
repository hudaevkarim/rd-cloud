import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, comments as commentsApi } from '../api/client.js';
import type { WireComment } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Dialog } from '../components/ui/Dialog.js';
import { TextArea } from '../components/ui/TextArea.js';
import { useToast } from '../components/ui/Toast.js';
import type { TextAnchor } from '@rd/library/anchor';
import { validateAnchor } from '@rd/shared/anchors';
import { anchorFromSelection, placeButton, type SelectionRefusal } from './selection.js';

/**
 * Создание комментария по выделенному фрагменту.
 *
 * ─── Три состояния, а не одно ─────────────────────────────────────────────────
 *
 * 1. Кнопка у выделения — появляется после того, как человек отпустил мышь, и
 *    живёт, пока выделение на месте.
 * 2. Окно — после нажатия кнопки. Якорь к этому моменту уже посчитан и лежит в
 *    состоянии: пересчитывать его из `getSelection()` при отправке нельзя, к
 *    этому моменту выделение могло уже рассыпаться.
 * 3. Отправка — состояние занятости, из-за которого окно нельзя закрыть.
 *
 * ─── Почему кнопка не на `mouseup` документа ──────────────────────────────────
 *
 * Обработчик висит на контейнере главы, а не на документе: выделение в панели
 * глав или в самом окне не должно вызывать кнопку. Всплытие до `document` было
 * бы проще, но означало бы, что выделил слово в оглавлении — получил кнопку
 * над абзацем, которого не касался.
 *
 * ─── Почему на тач-устройствах кнопки нет ─────────────────────────────────────
 *
 * Выделение пальцем заканчивается долгим нажатием, которое само по себе уже
 * показывает меню выделения браузера. Вторая кнопка поверх — два меню на одно
 * действие. Полноценное выделение с тач-устройства придёт вместе с панелью
 * комментариев, где отправка будет отдельным шагом.
 */

/** Сколько символов в цитате показываем в окне. */
const QUOTE_PREVIEW_LEN = 200;

/** Потолок текста комментария — такой же, как на сервере. */
const TEXT_LIMIT = 5_000;

/**
 * С какого числа символов показывается счётчик.
 *
 * Раньше: человек узнаёт о лимите, когда отправка уже отвергнута сервером,
 * то есть потеряв текст. Порог в 10% оставляет время поправить.
 */
const COUNTER_FROM = 4_500;

/** Сколько живёт кнопка после последнего события прокрутки. */
const SCROLL_HIDE_MS = 120;

/**
 * Размер кнопки для расчёта позиции.
 *
 * Задан константой, а не меряется: `getBoundingClientRect` кнопки до её
 * отрисовки даёт нули, а кнопка всегда одного размера — она с одной надписью.
 */
const BUTTON_SIZE = { width: 150, height: 32 };

export function CommentComposer({
  host,
  chapterIndex,
  roomId,
  bookId,
  onCreated,
}: {
  /** Контейнер главы. `null`, пока глава не отрисована. */
  host: HTMLElement | null;
  chapterIndex: number;
  roomId: string;
  bookId: string;
  onCreated: (comment: WireComment) => void;
}) {
  const toast = useToast();

  /** Якорь, по которому кнопка уже показана и ждёт нажатия. */
  const [pending, setPending] = useState<{ anchor: TextAnchor; top: number; left: number } | null>(null);
  const [refusal, setRefusal] = useState<SelectionRefusal | null>(null);

  const [draft, setDraft] = useState<{ anchor: TextAnchor; quote: string } | null>(null);
  const [text, setText] = useState('');
  const [spoiler, setSpoiler] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hide = useCallback(() => {
    setPending(null);
  }, []);

  /*
    Кнопка живёт, пока выделение живо.

    `selectionchange` ловит не только явное снятие выделения кликом, но и
    схлопывание: человек ткнул в текст мышью, intending нажать кнопку, а
    выделение рассыпалось — и без этой проверки кнопка висела бы над местом,
    где уже ничего не выделено. Клик по кнопке сам по себе выделение не
    снимает, поэтому нажатие успевает обработаться раньше.
  */
  useEffect(() => {
    if (pending === null) return;

    const onChange = (): void => {
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed) {
        hide();
        return;
      }
      // Выделение уехало в другое место страницы — кнопка над старым текстом.
      if (selection.anchorNode === null || !host?.contains(selection.anchorNode)) hide();
    };

    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [pending, host, hide]);

  /*
    Прокрутка снимает кнопку с задержкой, а не сразу.

    Задержка короткая и одна: она нужна, чтобы колесо мыши, которое приходит
    десятками событий в секунду, не гасило кнопку на первом же пикселе, и
    чтобы кнопка успела исчезнуть один раз, а не на каждое событие.
  */
  useEffect(() => {
    if (pending === null) return;
    let timer: number | null = null;
    const onScroll = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        hide();
      }, SCROLL_HIDE_MS);
    };
    // Фаза захвата, а не всплытие: событие `scroll` не всплывает, и слушатель
    // на окне иначе не увидел бы прокрутку внутреннего блока читалки.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pending, hide]);

  /*
    Появление кнопки — после отпускания мыши над контейнером главы.

    `pointerup`, а не `mouseup`: событие одно на оба устройства, а решение о
    показе принимается отдельно — на тач-устройствах кнопки нет вовсе.
  */
  useEffect(() => {
    if (host === null) return;

    const onPointerUp = (): void => {
      if (coarsePointer()) {
        hide();
        return;
      }

      const picked = anchorFromSelection(host, chapterIndex, window.getSelection());
      if (!picked.ok) {
        // Отказ по границе блоков объясняем, остальные случаи молчаливые:
        // пустое выделение и выделение вне текста — это «ещё не выделил»,
        // и сообщение о них только мешало бы.
        setRefusal(picked.refusal === 'across-blocks' ? 'across-blocks' : null);
        hide();
        return;
      }

      setRefusal(null);
      const range = window.getSelection()?.getRangeAt(0);
      if (range === null || range === undefined) {
        hide();
        return;
      }

      const spot = placeButton(
        range.getBoundingClientRect(),
        host.getBoundingClientRect(),
        BUTTON_SIZE,
      );
      setPending({ anchor: picked.anchor, top: spot.top, left: spot.left });
    };

    host.addEventListener('pointerup', onPointerUp);
    return () => host.removeEventListener('pointerup', onPointerUp);
  }, [host, chapterIndex, hide]);

  // Смена главы гасит кнопку и окно: якорь относится к другой главе, и оставить
  // его значило бы отправить комментарий не туда.
  useEffect(() => {
    hide();
    setDraft(null);
  }, [chapterIndex, hide]);

  const open = useCallback(() => {
    if (pending === null) return;
    setDraft({ anchor: pending.anchor, quote: pending.anchor.quote });
    setText('');
    setSpoiler(false);
    setFailure(null);
    hide();
  }, [pending, hide]);

  const cancel = useCallback(() => {
    if (busy) return;
    setDraft(null);
    setFailure(null);
  }, [busy]);

  const send = useCallback(async (): Promise<void> => {
    if (draft === null || busy) return;

    const trimmed = text.trim();
    if (trimmed === '') return;

    /*
      Проверка якоря на клиенте, до запроса.

      Сервер отверг бы неверный якоря тем же текстом, но ответ пришёл бы с
      задержкой и выглядел бы как «что-то сломалось». Здесь человек узнаёт сразу
      и может выделить другое. Функция та же, что на сервере, — иначе клиент
      проверял бы по своим правилам и ошибался там, где сервер прав.
    */
    const checked = validateAnchor(draft.anchor, 'text');
    if (!checked.ok) {
      setFailure('Не удалось привязать комментарий к этому фрагменту. Попробуйте выделить другой участок.');
      return;
    }

    setBusy(true);
    setFailure(null);
    try {
      /*
        `anchorType` здесь нет и не должен появиться: сервер вычисляет его из
        якоря и отвергает запрос, если поле прислали. Дублировать вычисленное
        значение — значит создать второе место, где оно может разойтись с якорем.
      */
      const created = await commentsApi.create(roomId, bookId, {
        text: trimmed,
        bookFileKind: 'text',
        anchor: checked.anchor,
        isSpoiler: spoiler,
      });
      onCreated(created);
      setDraft(null);
      setText('');
      setSpoiler(false);
      toast.info('Комментарий добавлен');
      // Выделение снимаем явно: иначе у человека остаётся подсветка фрагмента,
      // к которому комментарий уже есть, и следующий клик открывает старую кнопку.
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      setFailure(messageFor(error));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, text, spoiler, roomId, bookId, onCreated, toast]);

  const quote = draft === null ? '' : draft.quote;
  const remaining = TEXT_LIMIT - text.length;
  const tooLong = remaining < 0;

  return (
    <>
      {pending !== null && (
        <button
          type="button"
          className="reader__comment-btn"
          style={{ top: `${pending.top}px`, left: `${pending.left}px` }}
          onClick={open}
        >
          Комментировать
        </button>
      )}

      {/*
        Объяснение про два абзаца живёт под текстом, а не в тосте: тост
        исчезает через несколько секунд, а человек может не заметить его вовсе
        и решить, что кнопка не работает.
      */}
      {refusal === 'across-blocks' && (
        <p className="reader__selection-note" role="status">
          Выделите фрагмент внутри одного абзаца
        </p>
      )}

      <Dialog
        open={draft !== null}
        onClose={cancel}
        /*
          Заголовок не «Комментарий», а «Новый комментарий».

          Причина формальная, но настоящая: «Комментарий» стоял и на поле, и в
          заголовке окна, и два элемента с одинаковым доступным именем означали
          бы, что голосовой программе и скринридеру «Комментарий» не отличить
          поле от окна. Разные имена решают это без правок в разметке.
        */
        title="Новый комментарий"
        footer={
          <>
            <Button variant="ghost" onClick={cancel} disabled={busy}>
              Отмена
            </Button>
            <Button onClick={() => void send()} disabled={busy || text.trim() === '' || tooLong}>
              {busy ? 'Отправляем…' : 'Отправить'}
            </Button>
          </>
        }
      >
        <blockquote className="comment__quote">{shorten(quote)}</blockquote>

        <TextArea
          label="Комментарий"
          value={text}
          onChange={(event) => setText(event.target.value)}
          /*
            `Ctrl+Enter` отправляет, а `Enter` переносит строку: в комментарии
            люди пишут абзацами, а переназначение `Enter` сломало бы это
            молча. Обработчик на поле, а не на окне, — иначе `Ctrl+Enter` сработал
            бы и при фокусе на кнопке.
          */
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void send();
            }
          }}
          disabled={busy}
          rows={4}
          autoFocus
          hint={
            text.length >= COUNTER_FROM ? (
              <span className={tooLong ? 'formproblem' : undefined}>
                {remaining < 0 ? `На ${-remaining} длиннее лимита` : `Осталось ${remaining}`}
              </span>
            ) : (
              'Ctrl+Enter — отправить'
            )
          }
        />

        <label className="checkline">
          <input
            type="checkbox"
            checked={spoiler}
            onChange={(event) => setSpoiler(event.target.checked)}
            disabled={busy}
          />
          <span>Спойлер</span>
        </label>

        {failure !== null && (
          <p className="formproblem" role="alert">
            {failure}
          </p>
        )}
      </Dialog>
    </>
  );
}

/** Обрезает цитату для показа в окне. */
function shorten(quote: string): string {
  return quote.length <= QUOTE_PREVIEW_LEN ? quote : `${quote.slice(0, QUOTE_PREVIEW_LEN)}…`;
}

/**
 * Текст ошибки для человека.
 *
 * 403 разбирается отдельно: он не про текст комментария и не исправляется
 * повтором — человек не участник комнаты, и сообщение должно говорить об этом
 * прямо, а не «попробуйте ещё раз».
 *
 * Отдельно и ответ без тела ошибки (`code === 'unknown'`). Наблюдалось вживую:
 * при упавшем бэкенде прокси Vite отвечает `502` с текстом прокси, а не JSON
 * ошибки приложения, и человек читал «Запрос не удался: 502». Это правда о
 * прокси и бесполезно о человеке: ничего он не исправит и не поймёт.
 */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'Вы не участник комнаты.';
    if (error.status === 400) {
      return 'Не удалось привязать комментарий к этому фрагменту. Попробуйте выделить другой участок.';
    }
    // Тела с `error` нет: ответил не сервер приложения — прокси, шлюз или CDN.
    if (error.code === 'unknown') return 'Комментарий не отправлен. Проверьте соединение и попробуйте ещё раз.';
    return error.message;
  }
  return 'Комментарий не отправлен. Проверьте соединение и попробуйте ещё раз.';
}

/**
 * Тач-устройство ли.
 *
 * Через `matchMedia`, а не через `navigator.maxTouchPoints`: значение второго
 * бывает и у ноутбуков с сенсорным экраном, а `pointer: coarse` отвечает на
 * вопрос «каким устройством человек выделяет» напрямую.
 */
function coarsePointer(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}