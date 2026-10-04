import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Showcase, ThemeSwitch } from './Showcase.js';
import { useTheme, type ResolvedTheme } from '../theme/theme-context.js';

/**
 * Страница витрины компонентов.
 *
 * ─── Почему ширина переключается через iframe ────────────────────────────────
 *
 * Медиазапросы реагируют на **вьюпорт**, а не на контейнер. Контейнер шириной
 * 320px внутри широкого окна не включит `@media (max-width: 767px)` — браузер
 * ничего не знает про элемент и смотрит только на окно. Проверка адаптива
 * «сузь контейнер» на самом деле проверяла бы пустоту: нижняя навигация не
 * появилась бы, поля не сжались бы, ничего бы не произошло, и страница выглядела
 * бы исправной.
 *
 * У `iframe` собственный вьюпорт, и медиазапросы внутри него применяются
 * по-настоящему. Поэтому переключение ширины подменяет рамку, а не стиль
 * блока. Это единственный способ увидеть правильный адаптив, не трогая окно
 * браузера.
 *
 * ─── Тема в кадре ───────────────────────────────────────────────────────────
 *
 * Тема передаётся кадру **сообщением**, а не присваиванием атрибута его
 * `documentElement`.
 *
 * Присваивание атрибута работало наполовину: правила CSS применялись, фон
 * становился тёмным, а `ThemeProvider` внутри кадра продолжал считать, что
 * тема светлая. Из-за этого витрина показывала тёмные чипы и **светлые**
 * значения токенов рядом с ними — а именно значения токенов и есть главное,
 * ради чего страница сделана. Витрина, которая показывает неверные числа, хуже,
 * чем её отсутствие.
 *
 * Через сообщение кадр применяет тему своим же провайдером: состояние React,
 * атрибут и числа совпадают по построению, а не по совпадению таймингов.
 *
 * Сообщение отправляется и сразу после загрузки кадра, и на каждое изменение:
 * переключение темы в родительском окне без перезагрузки кадра тоже должно
 * доезжать.
 */

/** Канал связи родителя и кадра. Односторонний: кадр тему не меняет. */
const THEME_CHANNEL = 'rd:showcase-theme';

interface ThemeMessage {
  [THEME_CHANNEL]: ResolvedTheme;
}

/** Пометка «не индексировать» на время, пока витрина открыта. */
const NOINDEX_ID = 'dev-noindex';

/**
 * Внутри кадра показывается только содержимое, без рамки и переключателей.
 *
 * Отдельный компонент, а не условие в разметке: иначе пришлось бы дублировать
 * `useSearchParams` и всю обвязку страницы в двух ветках, и они разошлись бы
 * при первой же правке.
 */
function ShowcaseInFrame() {
  useNoIndex();

  const { setTheme } = useTheme();

  // Кадр применяет присланную тему своим провайдером — см. замечание о теме
  // в шапке файла. Сообщение проверяется по полю и по источнику: `message`
  // приходит из любого окна, а доверять следует только родительскому.
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== window.location.origin) return;

      const data = event.data as Partial<ThemeMessage> | null;
      const theme = data === null ? undefined : data[THEME_CHANNEL];
      if (theme === 'light' || theme === 'dark') setTheme(theme);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [setTheme]);

  const style = { background: 'var(--paper)', color: 'var(--ink)' } as const;

  return (
    <div className="showcase-frame" style={style}>
      <Showcase />
    </div>
  );
}

const WIDTHS = [320, 768, 1280] as const;

export function ShowcasePage() {
  const [params] = useSearchParams();

  /** Внутри кадра — только содержимое. */
  if (params.get('frame') === '1') return <ShowcaseInFrame />;

  return (
    <div className="devpage">
      <ShowcaseToolbar />
    </div>
  );
}

/** Панель: заголовок, выбор ширины, переключатель темы. */
function ShowcaseToolbar() {
  useNoIndex();

  const [width, setWidth] = useState<number>(768);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const { resolved } = useTheme();

  const postTheme = (target: Window | null): void => {
    if (target === null) return;
    const message: ThemeMessage = { [THEME_CHANNEL]: resolved };
    target.postMessage(message, window.location.origin);
  };

  // Тема уходит в кадр и при смене темы, и при смене ширины: во втором случае
  // кадр перезагружается и его провайдер снова читает своё хранилище, где
  // темы ещё нет.
  useEffect(() => {
    postTheme(frame.current?.contentWindow ?? null);
  }, [resolved, width]);

  return (
    <>
      <header className="devpage__bar">
        <div className="devpage__titles">
          <h1 className="devpage__title">Компоненты</h1>
          <p className="devpage__hint label label-xs">
            Страница только для разработки. Не индексируется.
          </p>
        </div>

        <div className="devpage__controls">
          <div className="devpage__group" role="group" aria-label="Ширина">
            <span className="label label-xs">ширина</span>
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={`btn btn--ghost devpage__width${width === w ? ' is-active' : ''}`}
                onClick={() => setWidth(w)}
                aria-pressed={width === w}
              >
                {w}
              </button>
            ))}
          </div>

          <ThemeSwitch />
        </div>
      </header>

      {/*
        Кадр ограничен по высоте и прокручивается внутри себя: иначе витрина в
        несколько экранов растянула бы страницу, и переключение ширины выглядело
        бы как «страница стала длиннее» вместо «стала уже».
      */}
      <div className="devpage__frame" style={{ width }}>
        <iframe
          ref={frame}
          title="Витрина компонентов"
          src="/dev/components?frame=1"
          width={width}
          className="devpage__iframe"
          onLoad={() => postTheme(frame.current?.contentWindow ?? null)}
        />
      </div>
    </>
  );
}

/**
 * Запрет индексации.
 *
 * Тег ставится на время жизни страницы и снимается при уходе: оставленный
 * `noindex` пометил бы адрес, который человек открыл следом, — то есть сделал
 * бы ровно то, чего страница не должна делать.
 */
function useNoIndex(): void {
  useEffect(() => {
    let meta = document.getElementById(NOINDEX_ID) as HTMLMetaElement | null;
    if (meta === null) {
      meta = document.createElement('meta');
      meta.id = NOINDEX_ID;
      meta.name = 'robots';
      document.head.appendChild(meta);
    }
    meta.content = 'noindex, nofollow';

    return () => {
      meta?.remove();
    };
  }, []);
}
