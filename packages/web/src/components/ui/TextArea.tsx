import { type ReactNode, type TextareaHTMLAttributes } from 'react';

/**
 * Многострочное поле ввода.
 *
 * ─── Отдельный компонент, а не пропу в `Input` ───────────────────────────────
 *
 * `Input` — это `<input>`, и его подпись, отступы и состояния живут в одном
 * месте. Добавлять пропу `multiline` значило бы усложнять `forwardRef` до
 * двух разных элементов под одним именем, а выигрыш — три строки разметки.
 *
 * Оформление то же, что у `Input`: только нижняя граница, подпись микро-лейблом.
 * Иначе длинное описание в коробке, а короткое название без коробки выглядели бы
 * двумя разными формами в одном окне.
 */
export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> {
  label: string;
  hint?: ReactNode;
  error?: string;
}

export function TextArea({ label, hint, error, id, rows = 3, ...rest }: TextAreaProps) {
  // Идентификатор связывает подпись с полем: без него клик по подписи не
  // фокусирует поле, и скринридер читает поле без названия.
  const fieldId = id ?? `ta-${label.replace(/\s+/g, '-').toLowerCase()}`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;

  // Ошибка и подсказка не занимают оба места: `aria-describedby` перечисляет
  // существующие, а ссылка на отсутствующий узел ломает озвучку.
  const describedBy = error !== undefined ? errorId : hint !== undefined ? hintId : undefined;

  return (
    <div className="field">
      <label className="label field__label" htmlFor={fieldId}>
        {label}
      </label>

      <textarea
        id={fieldId}
        className="field__input field__input--area"
        rows={rows}
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
}