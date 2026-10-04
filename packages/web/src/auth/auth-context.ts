import { createContext, useContext } from 'react';
import type { CurrentUser } from '../api/types.js';

/**
 * Контекст аутентификации: объявление и хук.
 *
 * ─── Почему отдельно от провайдера ──────────────────────────────────────────
 *
 * Fast Refresh умеет обновлять модуль, только если все его экспорты —
 * компоненты. Модуль с провайдером и хуком в одном файле этому условию не
 * удовлетворяет, и редактор вместо горячей замены делает полную перезагрузку
 * страницы:
 *
 *   hmr invalidate  Could not Fast Refresh ("useAuth" export is incompatible)
 *   page reload      src/auth/AuthContext.tsx
 *
 * Цена — потеря состояния при каждой правке: в открытой книге прокрутка,
 * выделение и недописанный комментарий сбрасываются из-за строчки, которую
 * человек отлаживал. Поэтому контекст и хук живут здесь, без JSX, а
 * провайдер — в соседнем файле.
 *
 * Тип вынесен сюда же: он описывает контракт потребителей, а не устройство
 * провайдера.
 */

export interface AuthContextValue {
  user: CurrentUser | null;
  /** Пока идёт проверка сессии: редирект на `/login` был бы преждевременным. */
  ready: boolean;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * Объявление контекста.
 *
 * `null` означает «провайдера нет», а не «пользователя нет»: эти состояния
 * требуют разного поведения, и смешивать их в одном значении нельзя.
 */
export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  // Ошибка программиста, а не состояние интерфейса: молчание привело бы к
  // «сессия молча пропала» без внятной причины.
  if (value === null) throw new Error('useAuth вызван вне AuthProvider');
  return value;
}

/** Признак администратора. Удобнее, чем `user?.role === 'admin'` в разметке. */
export function useIsAdmin(): boolean {
  return useAuth().user?.role === 'admin';
}

/** Ключ токена в хранилище. Одно место — один источник правды. */
export const TOKEN_STORAGE_KEY = 'rd.token';
