import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

/**
 * Поле ввода с подписью.
 *
 * ─── Только нижняя граница ───────────────────────────────────────────────────
 *
 * Не по вкусу: рамка со всех четырёх сторон превращает поле в коробку, а на
 * mobile в коробку, которую пальцем не попасть. Нижняя линия оставляет
 * вертикальную линию текста открытой, и взгляд идёт по полю слева направо.
 *
 * Подпись микро-лейблом: на форме входа это же слово («токен») стоит над
 * полем, и дублировать его внутри не нужно.
 */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  /** Подпись под полем. Для ошибки — отдельный пропуск, чтобы тон был один. */
  hint?: ReactNode;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, id, ...rest },
  ref,
) {
  // Идентификатор нужен для связи `label` и поля. Без него подпись не
  // работает как подпись: клик по ней не фокусирует поле, а скринридер
  // прочитает поле без названия.
  const fieldId = id ?? `in-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  // Ошибка и подсказка не занимают оба места: `aria-describedby` перечисляет
  // существующие, и ссылка на отсутствующий узел ломает озвучку.
  const describedBy = error !== undefined ? errorId : hint !== undefined ? hintId : undefined;

  return (
    <div className="field">
      <label className="label field__label" htmlFor={fieldId}>
        {label}
      </label>

      <input
        ref={ref}
        id={fieldId}
        className="field__input"
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        {...rest}
      />

      {error !== undefined ? (
        <p className="field__error label label-xs" id={errorId} role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="field__hint label label-xs" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
});
