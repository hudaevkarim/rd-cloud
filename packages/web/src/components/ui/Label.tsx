import type { ReactNode } from 'react';

/**
 * Микро-лейбл.
 *
 * Тот же приём, что на референсах: 11px, вес 500, uppercase, трекинг 3.85px.
 * Им помечены метаданные, состояния и подписи — всё, что не является текстом
 * для чтения.
 *
 * Трекинг большой, поэтому у лейбла есть сдвиг: буквы, разведённые на 3.85px,
 * визуально начинаются правее, чем стоит их бокс, и без поправки текст
 * «поедут» относительно колонки.
 */
export function Label({
  children,
  size = 'default',
  tone = 'muted',
  as: Tag = 'span',
}: {
  children: ReactNode;
  size?: 'default' | 'xs';
  /** `muted` — вторичный, `accent` — акцентом. */
  tone?: 'muted' | 'accent';
  as?: 'span' | 'div' | 'p' | 'legend';
}) {
  const classes = [
    'label',
    size === 'xs' ? 'label-xs' : '',
    tone === 'accent' ? 'label--accent' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return <Tag className={classes}>{children}</Tag>;
}
