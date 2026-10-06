import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTheme } from '../theme/theme-context.js';
import { useToast } from '../components/ui/Toast.js';
import { Dialog } from '../components/ui/Dialog.js';
import { Label } from '../components/ui/Label.js';

/*
  Стили витрины подключаются здесь, а не в `main.tsx`.

  Подключение в точке входа отражалось бы в общем CSS-бандле при любом режиме
  сборки, и витрина оставалась бы в продакшене даже при вырезанном коде. Здесь
  файл попадает в кусок самой витрины и уходит вместе с ним.
*/
import '../styles/showcase.css';

/**
 * Витрина компонентов и токенов.
 *
 * Существует для одной задачи: увидеть дизайн-систему целиком, в разных
 * состояниях и на разных ширинах, **до** того как на ней построят пять
 * страниц. Переделка после дороже, чем проверка сейчас.
 *
 * Обособлена файлом в папке `dev/` и не импортируется ни одним продуктовым
 * маршрутом: если её забыть удалить, в разработке она останется доступной, а
 * в сборку приложения не попадёт.
 */

/* ─── Обвязка ──────────────────────────────────────────────────────────────── */

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="showcase__group">
      <h2 className="showcase__group-title">{title}</h2>
      {note !== undefined && <p className="showcase__note">{note}</p>}
      {children}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="showcase__row">
      {label !== undefined && <span className="showcase__row-label label label-xs">{label}</span>}
      <div className="showcase__row-body">{children}</div>
    </div>
  );
}

/* ─── Чтение токенов ───────────────────────────────────────────────────────── */

/**
 * Фактические значения токенов.
 *
 * Читаются из `getComputedStyle`, а не зашиты в разметку: страница обязана
 * показывать то, что действительно применяется в текущей теме, включая
 * `--ink`, который в тёмной становится светлым.
 *
 * ─── Почему не по `resolved` в зависимостях ─────────────────────────────────
 *
 * Сначала так и было, и витрина показывала неверные числа: тёмные образцы и
 * **светлые** значения токенов рядом с ними.
 *
 * Причина в порядке эффектов. React выполняет эффекты потомков раньше
 * родительских, а `data-theme` на `<html>` ставит именно `ThemeProvider` —
 * родитель всего остального. Значит чтение из эффекта витрины происходит
 * **до** записи новой темы: значения снимаются со старой, а страница
 * перерисовывается уже с новой. Custom properties не переходятся, поэтому
 * стили применялись верно, а захваченный текст оставался прежним.
 *
 * Наблюдатель за атрибутом `data-theme` снимает эту гонку: он срабатывает
 * после того, как атрибут записан, и перечитывает значения. Заодно он ловит
 * смену темы, сделанную извне — например родительским окном страницы, минуя
 * провайдер, — а на такой случай подписки на React-состояние не хватает.
 *
 * ─── Почему список имён на модульном уровне ─────────────────────────────────
 *
 * `names` обязан иметь постоянную идентичность. Список, вычисляемый внутри
 * компонента, даёт новый массив при каждом рендере, и если он попадёт в
 * зависимость, получится цикл: рендер → новый массив → эффект → `setState` →
 * рендер. Он синхронный, поэтому не даёт событийному циклу оправиться: страница
 * замирает намертво, и даже таймаут теста не наступает, а падать нечему.
 */
function useTokenValues(names: readonly string[]): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({});

  /**
   * Список имён в ref: `read` читает актуальный, но не пересоздаётся из-за него.
   *
   * `names` намеренно не в зависимостях: список неизменен, а включение его
   * означало бы перечитывание на каждый новый массив — то есть на каждый
   * рендер. Наблюдатель ниже всё равно перечитывает при смене темы.
   */
  const namesRef = useRef(names);
  namesRef.current = names;

  const read = useCallback((): void => {
    const style = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const name of namesRef.current) {
      const value = style.getPropertyValue(name).trim();
      // Пустое значение не записывается. Проверка `?? '—'` его бы не поймала:
      // пустая строка не nullish, и в таблице появилась бы белая клетка вместо
      // прочерка. Выглядело бы как «данных нет», а на деле означало бы, что
      // токен не применён, — и это разные вещи.
      if (value !== '') next[name] = value;
    }
    setValues(next);
  }, []);

  useEffect(() => {
    read();
    const root = document.documentElement;
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [read]);

  return values;
}

const SWATCHES = [
  { name: '--paper', desc: 'фон страницы' },
  { name: '--paper-2', desc: 'подложка' },
  { name: '--ink', desc: 'текст' },
  { name: '--ink-2', desc: 'вторичный текст' },
  { name: '--rule', desc: 'линии' },
  { name: '--accent', desc: 'акцент' },
  { name: '--on-accent', desc: 'текст на акценте' },
] as const;

/** Имена токенов для `useTokenValues` — отдельная константа, чтобы список имел
 *  постоянную идентичность. См. замечание в `useTokenValues`. */
const COLOR_TOKEN_NAMES = SWATCHES.map((s) => s.name);

function Colors() {
  const swatches = SWATCHES;
  const values = useTokenValues(COLOR_TOKEN_NAMES);

  return (
    <div className="swatches">
      {swatches.map((s) => (
        <div className="swatch" key={s.name}>
          <div className="swatch__chip" style={{ background: `var(${s.name})` }} />
          <div className="swatch__text">
            <code className="swatch__name">{s.name}</code>
            <code className="swatch__value">{values[s.name] ?? '—'}</code>
            <span className="swatch__desc label label-xs">{s.desc}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Шаги шкалы отступов, которые показываются. */
const SPACE_STEPS = [1, 2, 3, 4, 6, 8, 12, 16] as const;

const SPACE_TOKEN_NAMES: readonly string[] = [
  ...SPACE_STEPS.map((n) => `--space-${n}`),
  '--gutter',
  '--measure',
];

/**
 * Токены формы.
 *
 * Значения показываются те же, что и у цветов, из CSSOM, а не зашиты текстом.
 * Зашитое «--transition: 180ms» разъехалось бы с токеном при первой же правке,
 * и витрина продолжала бы показывать старое значение — то есть показывала бы
 * неправду о самой себе.
 */
const FORM_TOKENS = [
  { name: '--radius', desc: 'скругление' },
  { name: '--touch', desc: 'минимальная площадь нажатия' },
  { name: '--transition', desc: 'только opacity и transform' },
  { name: '--topbar-h', desc: 'высота шапки' },
  { name: '--bottomnav-h', desc: 'высота нижней навигации' },
] as const;

const FORM_TOKEN_NAMES: readonly string[] = FORM_TOKENS.map((t) => t.name);

function FormTokens() {
  const values = useTokenValues(FORM_TOKEN_NAMES);

  return (
    <>
      {FORM_TOKENS.map((t) => (
        <Row key={t.name} label="токен">
          <code>{`${t.name}: ${values[t.name] ?? '—'}`}</code>
          <span className="label label-xs">{t.desc}</span>
        </Row>
      ))}
    </>
  );
}

function Spacing() {
  const steps = SPACE_STEPS;
  const values = useTokenValues(SPACE_TOKEN_NAMES);

  return (
    <div className="spacing">
      {steps.map((n) => (
        <div className="spacing__row" key={n}>
          <code className="spacing__name">--space-{n}</code>
          <div className="spacing__bar" style={{ width: `var(--space-${n})` }} />
          <code className="spacing__value">{values[`--space-${n}`] ?? '—'}</code>
        </div>
      ))}
      <div className="spacing__row">
        <code className="spacing__name">--gutter</code>
        <div className="spacing__bar" style={{ width: 'var(--gutter)' }} />
        <code className="spacing__value">{values['--gutter'] ?? '—'}</code>
      </div>
      <div className="spacing__row">
        <code className="spacing__name">--measure</code>
        <div className="spacing__bar spacing__bar--measure" style={{ width: 'min(var(--measure), 100%)' }} />
        <code className="spacing__value">{values['--measure'] ?? '—'}</code>
      </div>
    </div>
  );
}

/**
 * Образец строки с измеренными параметрами.
 *
 * ─── Почему подписи измеряются, а не написаны ───────────────────────────────
 *
 * Написать «интерфейс · 16px · 1.5» проще, и сначала так и было сделано. Но
 * подпись — это утверждение о коде, а код меняется: на 766px книжный текст
 * становится 18px, на `h1` трекание −0.2px, и витрина продолжала показывать
 * прежние числа. Хуже того, образцы лежали в `<code>`, а `code` в браузере
 * моноширинный: подпись обещала Space Grotesk, а на экране стоял `monospace`.
 *
 * Теперь подпись собирается из `getComputedStyle` того же элемента, который
 * показан, и напечатать неправду о себе витрина не может: числа на экране
 * сняты с самого образца.
 *
 * ─── Почему шрифт указывается явно ───────────────────────────────────────────
 *
 * Ради этого образцы перестали быть `<code>`. Если образец лежит в `<code>`,
 * поверх `--font-ui` ложится браузерный моноширинный, и в стилях не видно,
 * какой шрифт применится на самом деле: `font-family` из токена есть, а
 * результат — нет. Образец не должен быть объектом, который мешает увидеть
 * шрифт.
 */
function Sample({
  as: Tag = 'span',
  className,
  note,
  showFont = false,
  children,
}: {
  /** Тег образца. Книжный текст — абзац, остальное — строка. */
  as?: 'span' | 'p';
  className?: string;
  /** Пояснение слева от измеренных чисел. */
  note?: string;
  /** Имя первого шрифта из списка. */
  showFont?: boolean;
  children: ReactNode;
}) {
  // Тип узла выводится из тега: `HTMLElement` нельзя положить в `ref`
  // абзаца, а обобщённый параметр даёт нужный тип без `any`.
  const ref = useRef<HTMLSpanElement & HTMLParagraphElement | null>(null);
  const [facts, setFacts] = useState('');

  // Числа зависят от ширины: на 767px книжный текст уменьшается до 18px, и
  // подпись без перечитывания врала бы. Наблюдатель за размером образца ловит
  // и смену ширины кадра, и появление шрифта: `document.fonts` срабатывает
  // после подстановки, и до неё размеры шрифта не те.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    const read = (): void => {
      const s = getComputedStyle(el);
      const font = s.fontFamily.split(',')[0]?.replace(/["']/g, '') ?? '';
      const parts = [s.fontSize, `lh ${s.lineHeight}`, `w ${s.fontWeight}`, `ls ${s.letterSpacing}`];
      if (showFont) parts.push(font);
      setFacts(parts.join(' · '));
    };

    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showFont]);

  return (
    <div className="typo__row">
      <span className="typo__facts label label-xs">
        {note !== undefined && `${note} · `}
        {facts === '' ? '—' : facts}
      </span>
      <Tag className={className} ref={ref}>
        {children}
      </Tag>
    </div>
  );
}

function Typography() {
  return (
    <div className="typo">
      <Sample className="label" note="микро-лейбл">
        СОСТОЯНИЕ ЧТЕНИЯ
      </Sample>
      <Sample className="label label-xs" note="лейбл xs">
        МЕТАДАННЫЕ
      </Sample>
      <Sample note="интерфейс" showFont>
        Основной текст интерфейса, Space Grotesk
      </Sample>
      <Sample className="typo__ui-sm" note="интерфейс мелкий" showFont>
        Кнопки и навигация
      </Sample>
      <Sample className="typo__title" note="заголовок" showFont>
        Заголовок раздела
      </Sample>
      <Sample className="display typo__logo" note="логотип" showFont>
        ЧИТАЙ
      </Sample>
      <Sample as="p" className="book" note="книга" showFont>
        Ветер гулял по пустым улицам и не хотел останавливаться. Он умел ждать. Дождь
        начался к вечеру, и город стал тише. Пушкин написал об этом в одной из своих
        записных книжек.
      </Sample>
    </div>
  );
}

/* ─── Живые демонстрации ───────────────────────────────────────────────────── */

function ToastDemo() {
  const toast = useToast();
  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={() => toast.info('Комментарий сохранён')}>
        Показать уведомление
      </button>
      <button type="button" className="btn btn--danger" onClick={() => toast.error('Файл больше лимита в 50 МБ')}>
        Показать ошибку
      </button>
    </>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Открыть окно
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Покинуть комнату?">
        <p>После выхода комната останется, но вы перестанете видеть комментарии и присутствие.</p>
      </Dialog>
    </>
  );
}

/** Тема для переключателя на странице витрины. */
export function ThemeSwitch() {
  const { resolved, toggle } = useTheme();
  return (
    <button
      type="button"
      className="btn btn--ghost"
      onClick={toggle}
      aria-label={resolved === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
    >
      {resolved === 'dark' ? '○ Светлая' : '● Тёмная'}
    </button>
  );
}

/* ─── Витрина ──────────────────────────────────────────────────────────────── */

/**
 * Содержимое витрины.
 *
 * Живые демонстрации — окно и уведомления — работают и внутри кадра на странице
 * ширины: кадр того же происхождения, и человек нажимает прямо в нём. Раньше
 * они там выключались из опасения, что программа не достанется до содержимого
 * кадра, но это ограничение инструмента, а не человека, и пользы оно не
 * приносило: на 320px нажатия всё равно попадают мимо кнопок не чаще.
 */
export function Showcase() {
  return (
    <div className="showcase">
      <Group
        title="Кнопка"
        note="Рамка только у default. Наведение — инверсия фона и текста, а не смена оттенка: на тёмной теме акцент светлый, и подсветка им дала бы текст темнее фона."
      >
        <Row label="варианты">
          <button type="button" className="btn">
            Обычная
          </button>
          <button type="button" className="btn btn--ghost">
            Призрачная
          </button>
          <button type="button" className="btn btn--danger">
            Опасное
          </button>
        </Row>
        <Row label="состояния">
          <button type="button" className="btn" disabled>
            Недоступно
          </button>
          <button type="button" className="btn btn--ghost" disabled>
            Недоступно
          </button>
        </Row>
        <Row label="наведение">
          {/* Наведение нельзя показать и одновременно навести мышь, поэтому рядом
              лежит статичная копия правила. Настоящее наведение проверяется мышью
              в браузере. */}
          <button type="button" className="btn btn--hover-preview">
            Обычная · hover
          </button>
          <button type="button" className="btn btn--ghost btn--hover-preview-ghost">
            Призрачная · hover
          </button>
          <button type="button" className="btn btn--danger btn--hover-preview-danger">
            Опасное · hover
          </button>
        </Row>
        <Row label="во всю ширину">
          <button type="button" className="btn btn--full">
            Широкое действие
          </button>
        </Row>
      </Group>

      <Group
        title="Поле ввода"
        note="Только нижняя граница: рамка со всех сторон превращает поле в коробку, а на телефоне — в коробку, которую пальцем не попасть."
      >
        <Row label="пустое">
          <div className="field">
            <label className="label field__label" htmlFor="sc-empty">
              Название комнаты
            </label>
            <input className="field__input" id="sc-empty" />
          </div>
        </Row>
        <Row label="с подсказкой">
          <div className="field">
            <label className="label field__label" htmlFor="sc-placeholder">
              Токен
            </label>
            <input
              className="field__input"
              id="sc-placeholder"
              placeholder="Токен, выданный администратором"
            />
          </div>
        </Row>
        <Row label="с ошибкой">
          <div className="field">
            <label className="label field__label" htmlFor="sc-error">
              Код приглашения
            </label>
            <input
              className="field__input"
              id="sc-error"
              defaultValue="ABCD0EFG"
              aria-invalid="true"
              aria-describedby="sc-error-msg"
            />
            <p className="field__error label label-xs" id="sc-error-msg" role="alert">
              Код приглашения выглядит неверно
            </p>
          </div>
        </Row>
        <Row label="недоступно">
          <div className="field">
            <label className="label field__label" htmlFor="sc-disabled">
              Читаемое поле
            </label>
            <input
              className="field__input"
              id="sc-disabled"
              defaultValue="заполняется сервером"
              readOnly
            />
          </div>
        </Row>
      </Group>

      <Group title="Лейбл и линия">
        <Row label="лейбл">
          <Label size="xs" as="p">
            обычный
          </Label>
          <Label size="xs" tone="accent" as="p">
            акцентом
          </Label>
        </Row>
        <Row label="линия">
          <hr className="rule" />
        </Row>
        <Row label="с подписью">
          <div className="rule rule--labelled">
            <span className="rule__line" />
            <span className="rule__label label label-xs">раздел</span>
            <span className="rule__line" />
          </div>
        </Row>
      </Group>

      <Group
        title="Спиннер"
        note="Вращается только обводка currentColor: анимируются transform и opacity — единственные свойства, которые браузер считает на композиторе, без пересчёта растра."
      >
        <Row label="размеры">
          <span className="spinner" style={{ width: 16, height: 16 }} role="status" />
          <span className="spinner" style={{ width: 24, height: 24 }} role="status" />
          <span className="spinner" style={{ width: 32, height: 32 }} role="status" />
        </Row>
      </Group>

      <Group
        title="Уведомления"
        note="Всплывают снизу: сверху мешает шапке, снизу на телефоне — нижняя навигация, поэтому на телефоне поднимаются на её высоту."
      >
        <Row label="виды">
          <div className="toasts showcase__toasts">
            <div className="toast">
              <span className="toast__text">Комментарий сохранён</span>
              <button type="button" className="toast__close" aria-label="Скрыть">
                ×
              </button>
            </div>
            <div className="toast toast--error">
              <span className="toast__text">Файл больше лимита в 50 МБ</span>
              <button type="button" className="toast__close" aria-label="Скрыть">
                ×
              </button>
            </div>
            <div className="toast">
              <span className="toast__text">Борис ответил на ваш комментарий</span>
              <button type="button" className="toast__close" aria-label="Скрыть">
                ×
              </button>
            </div>
          </div>
        </Row>
        <Row label="живые">
          <ToastDemo />
        </Row>
      </Group>

      <Group
        title="Модальное окно"
        note="Три вещи, которые обычно забывают: фокус уходит внутрь, Escape закрывает, фокус возвращается на элемент, который окно открыл."
      >
        <div className="showcase__dialog-frame">
          <div className="dialog-root showcase__inline-dialog">
            <div className="dialog-backdrop" aria-hidden="true" />
            <div
              className="dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Пример окна"
              tabIndex={-1}
            >
              <header className="dialog__head">
                <h2 className="dialog__title">Покинуть комнату?</h2>
                <button type="button" className="dialog__close" aria-label="Закрыть">
                  ×
                </button>
              </header>
              <div className="dialog__body">
                <p>
                  После выхода комната останется, но вы перестанете видеть комментарии и
                  присутствие.
                </p>
              </div>
              <footer className="dialog__foot">
                <button type="button" className="btn btn--ghost">
                  Отмена
                </button>
                <button type="button" className="btn btn--danger">
                  Выйти
                </button>
              </footer>
            </div>
          </div>
        </div>
        <Row label="живое">
          <DialogDemo />
        </Row>
      </Group>

      <Group title="Токены: цвета">
        <Colors />
      </Group>

      <Group
        title="Токены: отступы"
        note="--gutter добавлен сверх шкалы: на референсе он равен 40px из padding навигации, а такого значения в шкале нет."
      >
        <Spacing />
      </Group>

      <Group title="Токены: типографика">
        <Typography />
      </Group>

      <Group
        title="Форма"
        note="Значения читаются из токенов, а не написаны рядом с названием, — иначе витрина показывала бы то, чего в коде уже нет."
      >
        <FormTokens />
      </Group>
    </div>
  );
}
