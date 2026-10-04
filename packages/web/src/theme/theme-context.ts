import { createContext, useContext } from 'react';

/**
 * Контекст темы: объявление и хук.
 *
 * Отдельно от провайдера по той же причине, что и в `auth-context.ts`: модуль,
 * экспортирующий и компонент, и хук, ломает Fast Refresh, и редактор вместо
 * горячей замены перезагружает страницу целиком. Подробности — там.
 */

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeContextValue {
  /** Что выбрал человек, включая `system`. */
  theme: Theme;
  /** Что получилось на самом деле, после учёта системной настройки. */
  resolved: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  /** Переключение светлая↔тёмная. Из `system` ведёт в противоположную текущей. */
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) throw new Error('useTheme вызван вне ThemeProvider');
  return value;
}

/** Ключ настройки темы в хранилище. */
export const THEME_STORAGE_KEY = 'rd.theme';

/**
 * Значение из хранилища. Битое значение — то же, что отсутствие.
 *
 * Отдельная чистая функция, а не чтение прямо в компоненте: правило «мусор в
 * хранилище не ломает страницу» должно быть проверяемым, и внутри рендера оно
 * не проверяемо.
 */
export function readStoredTheme(storage: Storage | undefined): Theme {
  if (storage === undefined) return 'system';
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

export function writeStoredTheme(storage: Storage | undefined, theme: Theme): void {
  if (storage === undefined) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Приватный режим браузера и переполненное хранилище запрещают запись.
    // Тема тогда не переживёт перезагрузку — это не повод ломать переключение
    // прямо сейчас.
  }
}

/** Разрешение `system` в конкретную тему. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}
