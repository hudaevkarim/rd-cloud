/**
 * Спиннер.
 *
 * Без цвета и без свечения: вращается только обводка `currentColor`, а в
 * приложении она наследует цвет текста и потому работает в обеих темах.
 *
 * Анимация — `transform` и `opacity`: это единственные свойства, которые
 * браузер анимирует на композиторе, без пересчёта растра. `width` и `margin`
 * в `@keyframes` дёргали бы layout на каждом кадре.
 *
 * Размер от `currentColor` не зависит — задан явно, потому что цвет меняется,
 * а размер нет.
 */
export function Spinner({ size = 16, label = 'Загрузка' }: { size?: number; label?: string }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} role="status" aria-live="polite">
      {/* Подпись для скринридера: вращающаяся картинка без текста читается
          как «изображение» и ничего не сообщает о том, что происходит. */}
      <span className="sr-only">{label}</span>
    </span>
  );
}
