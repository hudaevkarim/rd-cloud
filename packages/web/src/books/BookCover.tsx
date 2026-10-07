/**
 * Обложка книги.
 *
 * ─── Почему инициалы, а не пустое место ──────────────────────────────────────
 *
 * Список книг без картинок читается как пустой раздел: человек не понимает, грузит
 * ли страница обложки или их просто нет. Инициалы автора на приглушённом фоне
 * дают строку ту же высоту и тот же ритм, что и картинка, и сразу показывают,
 * что место занято.
 *
 * ─── Почему цвет от хеша имени ──────────────────────────────────────────────
 *
 * Случайный цвет менялся бы при каждом рендере: пришлось бы хранить его в
 * состоянии, и после перезагрузки страницы у одной книги был бы другой оттенок.
 * Хеш имени даёт то же самое всегда и без хранения: «Толстой» на всех страницах
 * одного цвета.
 */

/**
 * Приглушённые оттенки.
 *
 * Не яркие и не в акцентном тоне: обложки не должны спорить с акцентом, который
 * в этой системе означает действие. Восемь оттенков хватает, чтобы рядом из
 * двадцати книг не было двух одинаковых подряд.
 */
const PALETTE = [
  { bg: 'color-mix(in srgb, var(--accent) 12%, var(--paper-2))', ink: 'var(--accent)' },
  { bg: 'var(--paper-2)', ink: 'var(--ink-2)' },
  { bg: 'color-mix(in srgb, var(--ink) 8%, var(--paper-2))', ink: 'var(--ink-2)' },
  { bg: 'color-mix(in srgb, var(--accent) 6%, var(--paper))', ink: 'var(--accent)' },
] as const;

/**
 * Оттенок по строке.
 *
 * Хеш Фибоначчи по кодам символов: строки разной длины дают разные числа без
 * перебора. Отрицательные коды при обёртке в беззнаковое дали бы разброс, поэтому
 * берётся остаток от деления по модулю длины палитры.
 */
function toneOf(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % PALETTE.length;
}

/**
 * Инициалы из имени автора.
 *
 * Два знака: у «Александр Сергеевич Пушкин» это «АП», и по ним книга находится
 * глазами быстрее, чем по полному имени.
 */
export function initialsOf(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) return '?';
  const only = parts[0] as string;
  if (parts.length === 1) {
    // Одно слово: берём первые две буквы, иначе на «А» колонка была бы полосой
    // из одного знака.
    return only.slice(0, 2).toUpperCase();
  }
  const first = only.charAt(0);
  const last = (parts[parts.length - 1] as string).charAt(0);
  return `${first}${last}`.toUpperCase();
}

export function BookCover({
  coverUrl,
  author,
  title,
  size = 'md',
}: {
  coverUrl: string | null;
  author: string;
  title: string;
  /**
   * Размер. `lg` — только на странице книги, где обложка единственная и может
   * занять всю колонку: на странице с описанием она была бы пятном, а в строке
   * списка — квадратом размером с кнопку.
   */
  size?: 'sm' | 'md' | 'lg';
}) {
  /*
    Заглушка показывается, пока картинка грузится, и остаётся, если она не
    загрузилась. Иначе человек увидел бы пустой прямоугольник и решил бы, что
    обложки нет вовсе, хотя она есть.
  */
  if (coverUrl === null) {
    const tone = PALETTE[toneOf(author)] ?? PALETTE[0];
    return (
      <span
        className={`cover cover--empty cover--${size}`}
        style={{ background: tone.bg, color: tone.ink }}
        aria-hidden="true"
      >
        {initialsOf(author)}
      </span>
    );
  }

  return (
    <span className={`cover cover--${size}`}>
      {/*
        `alt` — название книги, а не описание картинки: для человека с программой
        чтения с экрана это единственное, что говорит, какая книга в списке. Если
        обложка не загрузится, `onError` уберёт `src`, и останется заставка.
      */}
      <img
        className="cover__img"
        src={coverUrl}
        alt={`Обложка: ${title}`}
        loading="lazy"
        decoding="async"
        onError={(event) => {
          event.currentTarget.remove();
        }}
      />
    </span>
  );
}