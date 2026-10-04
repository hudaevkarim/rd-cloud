import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Всплывающие уведомления.
 *
 * Всплывают снизу: сверху мешает шапке, а снизу на мобильном — нижняя
 * навигация, поэтому на телефоне поднимаются на её высоту.
 *
 * Время жизни разное: ошибку 4 секунды читать мало, «Файл больше лимита в
 * 50 МБ» не успевают прочитать. Ошибка живёт 6.
 */

export type ToastTone = 'info' | 'error';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
}

/** Показать сообщение. Возвращает функцию, убирающую его досрочно. */
export type Notify = (tone: ToastTone, text: string) => () => void;

export interface ToastApi extends Notify {
  info: (text: string) => () => void;
  error: (text: string) => () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Заглушка вместо провайдера.
 *
 * Бросать исключение здесь нельзя: `notify` зовут из обработчиков ошибок и из
 * перехватчиков сокета, то есть иногда раньше, чем дерево отрисовано. Вместо
 * исходной ошибки человек получил бы «нет ToastProvider».
 */
const NOOP: ToastApi = Object.assign(() => () => undefined, {
  info: () => () => undefined,
  error: () => () => undefined,
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  // Таймеры хранятся по идентификатору сообщения, а не просто набором: без
  // связи «сообщение → таймер» нельзя отменить конкретный таймер, а убрать
  // сообщение досрочно нужно — иначе уведомление живёт дольше, чем показано.
  //
  // Тип именно Map, а не Set: у Set нет `get`, и поиск таймера сообщения
  // пришлось бы делать перебором.
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback<Notify>(
    (tone, text) => {
      const id = nextId.current++;
      setItems((current) => [...current, { id, tone, text }]);

      const timer = window.setTimeout(() => {
        dismiss(id);
      }, tone === 'error' ? 6_000 : 4_000);
      timers.current.set(id, timer);

      return () => {
        dismiss(id);
      };
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => Object.assign(notify, { info: (t: string) => notify('info', t), error: (t: string) => notify('error', t) }),
    [notify],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        `aria-live="polite"`: сообщение читается скринридером, но не прерывает
        то, что он читает сейчас. `assertive` здесь был бы неверным — уведомление
        о фоновой ошибке не должно перебивать чтение текста.
      */}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone}`}>
            <span className="toast__text">{item.text}</span>
            <button
              type="button"
              className="toast__close"
              aria-label="Скрыть"
              onClick={() => dismiss(item.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
