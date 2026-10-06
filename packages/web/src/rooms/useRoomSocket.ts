import { useEffect, useRef } from 'react';
import {
  connectSocket,
  getSocket,
  on,
  type PresenceEntry,
  type TypedSocket,
} from '../ws/client.js';
import { useAuth } from '../auth/auth-context.js';
import { getToken } from '../api/client.js';
import type { WireNotification } from '../api/types.js';

/**
 * Подписка на сокет приложения.
 *
 * ─── Один сокет на вкладку ───────────────────────────────────────────────────
 *
 * Поднимается здесь, а не на каждой странице: два сокета от одной вкладки
 * означали бы две подписки на присутствие, и человек появился бы в списке
 * читателей дважды.
 *
 * ─── Почему в зависимостях `user.id`, а не объект ────────────────────────────
 *
 * Объект пользователя пересоздаётся на каждой проверке сессии. Зависимость от
 * него переподключала бы сокет после каждого `me()` — то есть на каждом
 * обновлении страницы, и человек терял бы комнату в сокете на ровном месте.
 *
 * ─── Обработчики вне зависимостей ────────────────────────────────────────────
 *
 * Страницы передают новые замыкания на каждом рендере. Если бы они были в
 * зависимостях, эффект переподключал бы сокет на каждом рендере. Поэтому они
 * лежат в ref и читаются из обработчиков по актуальному значению.
 */
export interface SocketHandlers {
  onNotification?: (note: WireNotification) => void;
  onPresenceChanged?: (entry: PresenceEntry) => void;
  onPresenceLeft?: (payload: { userId: string; roomId: string }) => void;
  /** Сокет недоступен: токен отвергнут или сеть легла. */
  onUnreachable?: (state: 'unauthorized' | 'error', message: string) => void;
}

/**
 * Подключает сокет, если есть сессия, и вешает обработчики.
 *
 * Возвращает сокет или `null`: «соединения ещё нет» — нормальное состояние на
 * первом кадре, и страница обязана это учитывать, а не падать.
 */
export function useRoomSocket(handlers: SocketHandlers = {}): TypedSocket | null {
  const { user, ready } = useAuth();

  /** Актуальные обработчики для обработчиков сокета. */
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (ready === false || user === null) return;

    /*
      Токен берётся из клиента API, а не из `localStorage` напрямую.

      Раньше знание о хранилище было продублировано в трёх местах: `main.tsx`,
      `AuthContext` и здесь. Пока все три читали один и тот же ключ, это
      работало — но стоило подставить хранилище в `AuthProvider` (что делают
      тесты), и сокет молча не подключался: обработчики не вешались, уведомления
      не приходили, а страница показывала себя исправной.

      Теперь токен один — в памяти клиента API, куда его кладёт и вход, и
      восстановление сессии.
    */
    const token = getToken();
    if (token === null) return;

    const socket = connectSocket(token);

    const offs = [
      on(socket, 'notification:new', (note) => ref.current.onNotification?.(note)),
      on(socket, 'presence:changed', (entry) => ref.current.onPresenceChanged?.(entry)),
      on(socket, 'presence:left', (payload) => ref.current.onPresenceLeft?.(payload)),
    ];

    const onError = (error: Error & { message?: string }): void => {
      const message = error.message ?? 'неизвестная ошибка';
      ref.current.onUnreachable?.(message === 'unauthorized' ? 'unauthorized' : 'error', message);
    };
    socket.on('connect_error', onError);

    return () => {
      for (const off of offs) off();
      socket.off('connect_error', onError);
    };
    // Обработчики намеренно не в зависимостях: см. комментарий в шапке файла.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, user?.id]);

  return getSocket();
}