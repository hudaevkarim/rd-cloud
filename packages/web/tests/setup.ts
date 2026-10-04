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
