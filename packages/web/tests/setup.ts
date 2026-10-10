import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Подготовка jsdom.
 *
 * ─── Чего в jsdom нет, а нужно ────────────────────────────────────────────────
 *
 * 1. `matchMedia`. Без него `ThemeProvider` упал бы на `window.matchMedia is
 *    not a function`. Заглушка отдаёт `false`, то есть светлую тему: проверки
 *    темы в этом файле управляют темой вручную, а не системной настройкой.
 *
 * 2. `fetch`. Подменяется целиком на уровне `globalThis`, потому что каждый
 *    тест задаёт своё поведение, а не один общий ответ на все запросы.
 *
 * 3. `scrollTo`. Вызывается при переходах роутера в jsdom, которого метода нет.
 *
 * 4. `ResizeObserver`. Витрина компонентов измеряет образцы типографики через
 *    него: подписи должны показывать фактический размер шрифта, а на 767px он
 *    меняется, и без перечитывания подпись врала бы. В jsdom метода нет, и без
 *    заглушки падал бы рендер, а не проверка.
 */

afterEach(() => {
  cleanup();

  /*
    Уборка `body` — общая, а не в каждом файле.

    `cleanup()` из testing-library снимает только свои контейнеры. Узлы,
    добавленные в `body` руками (фикстуры главы, поля ввода для проверки
    горячих клавиш), остаются жить и переходят в следующий файл: `singleFork`
    в конфиге означает один процесс на весь прогон, а значит один `document`.

    Наблюдалось так: `comment-markers.test.ts` оставил абзац «текст про лова…»,
    и `book-upload.test.tsx` после него упал на `getByText(/текст/)` — на
    элементе из чужого файла. По отдельности оба файла проходят.

    Общее правило вместо ручной уборки в каждом тесте: тест, который что-то
    добавил в `body`, не обязан это убирать, иначе про любую новую фикстуру
    придётся помнить дважды — здесь и в своём файле.
  */
  document.body.replaceChildren();
  resetScrollCalls();

  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

Object.defineProperty(window, 'scrollTo', { writable: true, value: () => undefined });

/**
 * `Range.getBoundingClientRect` и `getClientRects` в jsdom отсутствуют.
 *
 * Нужны кнопке «Комментировать»: она встаёт над выделенным фрагментом и без
 * геометрии выделения позиционировать её нечем. В браузере метод есть всегда,
 * то есть это пробел jsdom, а не проверки.
 *
 * Значение нулевое намеренно: выделение в jsdom нигде не нарисовано, и любое
 * ненулевое значение было бы выдумкой, от которой зависят тесты позиции.
 * Проверки, которым положение важно, задают прямоугольник сами — см. тесты
 * `CommentComposer`.
 */
/**
 * `scrollIntoView` в jsdom отсутствует.
 *
 * Прокрутка к маркеру и к комментарию идёт через него: браузер сам знает, как
 * доехать до элемента внутри прокручиваемого блока, и это единственный способ не
 * пересчитывать координаты вручную.
 *
 * Заглушка записывает вызовы: проверки двусторонней связи (маркер ↔ панель)
 * именно на это и смотрят — в jsdom прокрутки нет, и результата у метода нет,
 * остаётся только факт, что его позвали, с правильными параметрами.
 */
const scrollCalls: Array<{
  target: Element;
  options: ScrollIntoViewOptions | boolean | undefined;
}> = [];

export function scrollIntoViewCalls(): ReadonlyArray<{
  target: Element;
  options: ScrollIntoViewOptions | boolean | undefined;
}> {
  return scrollCalls;
}

export function resetScrollCalls(): void {
  scrollCalls.length = 0;
}

Element.prototype.scrollIntoView = function scrollIntoView(
  this: Element,
  options?: ScrollIntoViewOptions | boolean,
): void {
  scrollCalls.push({ target: this, options });
};

function zeroRect(): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

for (const method of ['getBoundingClientRect', 'getClientRects'] as const) {
  Object.defineProperty(Range.prototype, method, {
    writable: true,
    configurable: true,
    value: function rangeGeometry(this: Range) {
      return method === 'getBoundingClientRect' ? zeroRect() : Object.assign([], { item: () => null });
    },
  });
}

/**
 * Заглушка `ResizeObserver`.
 *
 * Обратный вызов не вызывается: в jsdom размеры не меняются, а вызывать его
 * наугад значило бы запускать перерисовку без причины. Проверки, которым нужно
 * изменение размера, вызывают его сами — см. тесты витрины.
 */
Object.defineProperty(window, 'ResizeObserver', {
  writable: true,
  value: class {
    observe(): void {
      /* размеры в jsdom не меняются сами */
    }
    unobserve(): void {
      /* нечего отменять */
    }
    disconnect(): void {
      /* нечего разрывать */
    }
  },
});

/**
 * Ответ `fetch` нужного вида.
 *
 * Собирается вручную, а не через `Response`: конструктор `Response` в jsdom
 * доступен не во всех версиях, а тесту нужен только `ok`, `status` и `text()`.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}
