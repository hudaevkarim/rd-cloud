import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Модальное окно.
 *
 * ─── Три вещи, которые обычно забывают ───────────────────────────────────────
 *
 * 1. **Фокус.** При открытии фокус уходит внутрь окна. Иначе он остаётся на
 *    элементе под подложкой, и следующий Tab уводит фокус в невидимую часть
 *    страницы — человек «потерял» окно.
 *
 * 2. **Escape.** Закрытие по Escape ожидаемо настолько, что его отсутствие
 *    читается как поломка, особенно на ноутбуке без мыши.
 *
 * 3. **Возврат фокуса.** При закрытии фокус возвращается на элемент, который
 *    его открыл. Без этого пришлось бы возвращаться мышью.
 *
 * Блокировка прокрутки сделана через `overflow: hidden` на `<body>` с
 * сохранением прежнего значения: если где-то к тесту пришёл свой `overflow`,
 * сброс в `hidden` стёр бы его, и после закрытия страница осталась бы
 * непроницаемой.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  /*
    Элемент, который был активен до открытия.

    Берётся в момент рендера с открытым окном, а не в обработчике нажатия: в
    React 18 со строгим режимом обработчик отработал бы дважды и ссылка
    успела бы превратиться в элемент внутри окна. В момент рендера активным
    ещё элемент снаружи — `autoFocus` ставится позже, при фиксации дерева.
  */
  const opener = useRef<HTMLElement | null>(null);
  if (open && opener.current === null) {
    opener.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    if (!open) return;

    /*
      Фокус на само окно — но только если внутри него ещё ничего не оказалось.

      Так полагается `autoFocus` поля: он срабатывает при фиксации дерева, а этот
      эффект выполняется после. Без проверки окно забирало бы фокус обратно на
      себя, и человек увидел бы пустое поле вместо того, в которое он уже
      начал печатать.

      */
    const active = document.activeElement;
    if (active === null || active === document.body || !panel.current?.contains(active)) {
      panel.current?.focus();
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-root">
      {/* Подложка кликабельна, но не фокусируется: `aria-hidden` убирает её
          из дерева доступности, иначе скринридер читал бы «диалог, кнопка,
          диалог». Закрытие подложки остаётся для мыши. */}
      <div className="dialog-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
      >
        <header className="dialog__head">
          <h2 className="dialog__title">{title}</h2>
          <button type="button" className="dialog__close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        <div className="dialog__body">{children}</div>

        {footer !== undefined && <footer className="dialog__foot">{footer}</footer>}
      </div>
    </div>
  );
}
