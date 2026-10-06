import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Загрузка данных страницы.
 *
 * ─── Почему не react-query ───────────────────────────────────────────────────
 *
 * Зависимости на проект нет, а задачи у этих хуков узкие: один запрос, три
 * состояния — «грузится», «есть», «ошибка». Библиотека ради этого дала бы
 * кеширование между страницами, но кеш надо сбрасывать руками после создания
 * комнаты, и забытый сброс стоил бы дороже, чем перезапрос списка из трёх
 * строк.
 *
 * ─── Гонка на уходе со страницы ──────────────────────────────────────────────
 *
 * Результат запроса приходит уже после размонтирования — тогда `setState`
 * бросает предупреждение и, что хуже, результат может прийти не в том
 * порядке, в каком уходили запросы: человек напечатал «ан», затем «анна», и
 * медленный ответ на «ан» перезаписал бы точный на «анна». Отсчётчик запросов
 * решает обе задачи: устаревший ответ игнорируется, размонтированный —
 * тоже.
 */

/** Три состояния загрузки, а не флаги: `loading` и `data` вместе не нужны. */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: string };

/**
 * Состояние запроса вместе с `reload`.
 *
 * Отдельное имя нужно, чтобы в компонент можно было передать состояние чужого
 * запроса: вкладки «Заявки» и её счётчик читают один и тот же список. Когда у
 * каждой свой запрос, счётчик отставал от списка, и это стоило отдельной
 * правки.
 */
export type QueryState<T> = Loadable<T> & { reload: () => void };

/**
 * Один запрос на компонент, с перезапуском по `deps`.
 *
 * `reload` возвращает функцию, которой страница перезапрашивает данные сама —
 * после создания комнаты, принятия заявки, выхода. Ключ `nonce` внутри хука
 * меняется, и эффект срабатывает снова.
 */
export function useQuery<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): QueryState<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  // Счётчик активных запросов. Ответ применяется, только если он от текущего:
  // иначе медленный ответ на «ан» перезаписал бы точный на «анна».
  const ticket = useRef(0);

  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  // Функция в зависимостях не stably-равна, поэтому её актуальная версия
  // хранится в ref: иначе каждый рендер перезапускал бы запрос, а список
  // зависимостей рос бы вместе с числом рендеров.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    ticket.current += 1;
    const mine = ticket.current;

    setState({ status: 'loading' });

    loadRef
      .current(controller.signal)
      .then((data) => {
        if (mine !== ticket.current || controller.signal.aborted) return;
        setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (mine !== ticket.current || controller.signal.aborted) return;
        setState({ status: 'error', error: messageOf(err) });
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { ...state, reload };
}

/**
 * Сообщение об ошибке для показа человеку.
 *
 * Текст с сервера полезнее «что-то пошло не так»: он различает «нет доступа»
 * и «комната не найдена», и человек понимает, что делать.
 */
export function messageOf(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  return 'Что-то пошло не так';
}

/**
 * Debounce для поля поиска.
 *
 * 300 мс — время, за которое человек допечатывает слово. Меньше — запрос на
 * каждую букву, больше — ощущение «ничего не происходит».
 *
 * Значение отдаётся с задержкой, а таймер чистится на уходе: без этого
 * отложенный вызов `setState` после размонтирования бросил бы предупреждение,
 * а на `/search` их ещё и накапливалось.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}