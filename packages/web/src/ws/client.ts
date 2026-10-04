import { io, type Socket } from 'socket.io-client';
import type { WireComment } from '../api/types.js';

/**
 * Клиент сокетов.
 *
 * ─── Почему относительный адрес ──────────────────────────────────────────────
 *
 * Подключение идёт на тот же origin, что и страница. В разработке это `:5173`,
 * и Vite проксирует `/socket.io` на `:3000`; в продакшене оба хоста за одним
 * доменом. Абсолютный адрес означал бы два разных значения в двух режимах, а
 * здесь работает один и тот же путь в обоих.
 *
 * Токен уходит в `auth`, а не в cookie: `auth` переживает любые изменения
 * политики same-site, а cookie на `<cross-origin>` вообще не отправляется.
 * Сервер принимает оба способа — cookie нужен браузеру, который положил токен
 * при входе, и `auth` для скриптов.
 *
 * ─── Переподключение ─────────────────────────────────────────────────────────
 *
 * Комната после разрыва не восстанавливается сама: `connectionStateRecovery` на
 * сервере выключен намеренно, и состояние восстанавливает вызов `room:join`.
 * Автоматическое восстановление выглядело бы лучше, но означало бы, что сервер
 * держит состояние сокета между переподключениями, а оно включает права,
 * проверенные при входе в комнату. Человек мог быть исключён, пока сокет был
 * мёртв.
 */

/** Полезная нагрузка `room:join`. */
export interface JoinResult {
  ok: boolean;
  members?: PresenceEntry[];
  error?: string;
}

export interface PresenceEntry {
  userId: string;
  displayName: string;
  avatar: string | null;
  roomId: string;
  positionType: 'text' | 'timestamp';
  positionData: Record<string, unknown>;
  updatedAt: string;
}

export interface PresencePayload {
  roomId: string;
  positionType: 'text' | 'timestamp';
  positionData: Record<string, unknown>;
}

/**
 * События клиента.
 *
 * Объявлены типами, чтобы опечатка в имени была ошибкой компиляции, а не
 * сообщением «уведомления не приходят» в продакшене.
 */
export interface ClientToServer {
  'room:join': (payload: { roomId: string }, ack: (result: JoinResult) => void) => void;
  'room:leave': (payload: { roomId: string }) => void;
  'presence:update': (payload: PresencePayload) => void;
}

export interface ServerToClient {
  'server:ready': (payload: { userId: string }) => void;
  'room:left': (payload: { roomId: string }) => void;
  'presence:changed': (payload: PresenceEntry) => void;
  'presence:left': (payload: { userId: string; roomId: string }) => void;
  'comment:new': (payload: { roomId: string; bookId: string; comment: WireComment }) => void;
  'comment:updated': (payload: { roomId: string; comment: WireComment }) => void;
  'comment:deleted': (payload: { roomId: string; commentId: string }) => void;
  'reaction:changed': (payload: {
    roomId: string;
    comment: WireComment;
    active: boolean;
    userId: string;
  }) => void;
  'notification:new': (payload: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }) => void;
}

export type TypedSocket = Socket<ServerToClient, ClientToServer>;

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'unauthorized' | 'error';

/**
 * Один сокет на всё приложение.
 *
 * Не создаётся на компонент: два сокета от одной вкладки означают две
 * подписки на присутствие, и в списке читателей человек появился бы дважды.
 */
let socket: TypedSocket | null = null;
let currentToken: string | null = null;

export function connectSocket(token: string): TypedSocket {
  if (socket !== null && currentToken === token) return socket;
  disconnectSocket();

  currentToken = token;
  socket = io({
    // Токен в `auth`, а не в cookie: см. шапку файла.
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    // 1 секунда для первой попытки, дальше экспонента с потолком в 10 секунд:
    // при упавшем сервере не нужно 60 попыток, а после восстановления
    // подключение должно произойти быстро.
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 10_000,
    timeout: 10_000,
  }) as TypedSocket;

  return socket;
}

export function disconnectSocket(): void {
  if (socket === null) return;
  socket.removeAllListeners();
  socket.disconnect();
  socket = null;
  currentToken = null;
}

export function getSocket(): TypedSocket | null {
  return socket;
}

/** Состояние соединения — для индикатора в интерфейсе. */
export function connectionStateOf(target: TypedSocket): ConnectionState {
  if (target.connected) return 'connected';
  if (target.io.engine.readyState === 'closed') return 'idle';
  return 'connecting';
}

/**
 * Подписка на событие с автоснятием.
 *
 * `useEffect` возвращает функцию очистки, а её возвращать обязан любой
 * эффект: иначе при размонтировании слушатель остаётся, и компонент, смонтированный
 * второй раз, получает по два события на одно действие.
 */
export function on<E extends keyof ServerToClient>(
  target: TypedSocket,
  event: E,
  handler: ServerToClient[E],
): () => void {
  target.on(event, handler as never);
  return () => {
    target.off(event, handler as never);
  };
}

/**
 * Обработка отказа в рукопожатии.
 *
 * Отказ по токену отличается от отказа по сети: в первом случае повторные
 * попытки бесполезны и только съедают батарею, во втором — обязательны.
 */
export function onConnectError(
  target: TypedSocket,
  handler: (state: ConnectionState, message: string) => void,
): () => void {
  const wrapped = (error: Error & { message?: string }): void => {
    const message = error.message ?? 'неизвестная ошибка';
    handler(message === 'unauthorized' ? 'unauthorized' : 'error', message);
  };
  target.on('connect_error', wrapped);
  return () => {
    target.off('connect_error', wrapped);
  };
}
