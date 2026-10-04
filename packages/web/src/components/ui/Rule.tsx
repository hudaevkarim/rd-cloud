import type { ReactNode } from 'react';

/**
 * Горизонтальная линия.
 *
 * Отдельным компонентом, а не `border-top` в разметке: линия в этом интерфейсе
 * несёт смысл (граница раздела, основание списка), и на неё ссылаются
 * описания в разметке. Борделью такой линии можно случайно сдвинуть на пару
 * пикселей, и раздел «поедет» на соседнем экране.
 */
export function Rule({ label }: { label?: ReactNode }) {
  if (label === undefined) return <hr className="rule" />;

  return (
    <div className="rule rule--labelled" role="separator" aria-label={String(label)}>
      <span className="rule__line" />
      <span className="rule__label label label-xs">{label}</span>
      <span className="rule__line" />
    </div>
  );
}
