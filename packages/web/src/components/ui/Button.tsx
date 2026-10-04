import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Кнопка.
 *
 * ─── Три варианта, ни одного скругления ──────────────────────────────────────
 *
 * `default` — с рамкой 1px, единственный, у кого она есть. На референсах
 * кнопки плоские (`border: 0px none`), но там они всегда лежат на однотонном
 * поле и читаются как ссылки. Здесь появляются кнопки в списках и на тёмной
 * теме, где кнопка без рамки и без заливки перестаёт быть похожей на кнопку.
 *
 * `ghost` — без рамки, для действий второго ряда: «отмена», «выйти».
 * `danger` — рамка цветом акцента, для необратимого.
 *
 * Hover — инверсия фона и текста, а не смена оттенка. Смена оттенка на
 * `--accent` плохо читается в тёмной теме, где акцент светлый.
 */

export type ButtonVariant = 'default' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  /** Иконка или короткая метка слева от текста. */
  icon?: ReactNode;
  full?: boolean;
}

export function Button({
  variant = 'default',
  icon,
  full = false,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const className = [
    'btn',
    `btn--${variant}`,
    full ? 'btn--full' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <button type={type} className={className} {...rest}>
      {icon !== undefined && (
        <span className="btn__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="btn__text">{children}</span>
    </button>
  );
}
