import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ThemeContext,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
  type ResolvedTheme,
  type Theme,
  type ThemeContextValue,
} from './theme-context.js';

/**
 * Провайдер темы.
 *
 * ─── Три состояния, а не два ────────────────────────────────────────────────
 *
 * `light`, `dark` и `system`.
 *
 * `system` нужен по практической причине: человек, который не открывал
 * приложение месяц, не должен получать светлую тему ночью только потому, что
 * так было в момент его последнего визита. Значение по умолчанию — именно
 * `system`, а не запомненное: отсутствие настройки это тоже настройка.
 *
 * Решение оформляется на `<html>` через `data-theme`, а не классом на `<body>`:
 * так его видно и `document.documentElement`, и `color-scheme`, и любым
 * правилам, применяемым к корню.
 */

export function ThemeProvider({
  children,
  storage,
  prefersDark,
}: {
  children: ReactNode;
  /** Внедряется в тестах: jsdom не даёт доступа к реальному `localStorage`. */
  storage?: Storage;
  prefersDark?: boolean;
}) {
  const store = storage ?? safeLocalStorage();

  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(store));
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDark ?? prefersDarkFromMedia());

  // Системная настройка меняется на лету: человек переключил тему в системе,
  // и наше окно обязано последовать, пока он не выбрал тему вручную.
  useEffect(() => {
    if (prefersDark !== undefined) return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    query.addEventListener('change', listener);
    setSystemDark(query.matches);
    return () => {
      query.removeEventListener('change', listener);
    };
  }, [prefersDark]);

  const resolved: ResolvedTheme = resolveTheme(theme, systemDark);

  // Атрибут ставится здесь, а не в разметке: тема меняется после первого кадра,
  // и в разметке остался бы светлый фон на тёмном экране.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);
    // Цвет панели браузера совпадает с фоном: иначе на android строка
    // состояния остаётся белой над тёмной страницей.
    root.style.colorScheme = resolved;
  }, [resolved]);

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      writeStoredTheme(store, next);
    },
    [store],
  );

  const toggle = useCallback(() => {
    setTheme(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolved, setTheme, toggle }),
    [theme, resolved, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** `localStorage` есть не везде: в приватном режиме и в некоторых песочницах. */
function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function prefersDarkFromMedia(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}
