import type { AnyAnchor, AnchorType } from '@rd/shared/anchors';

/**
 * Контракт сокета.
 *
 * ─── Зачем объявлять события типами ──────────────────────────────────────────
 *
 * Без `ClientToServerEvents` и `ServerToClientEvents` Socket.IO принимает любые
 * имена и любые данные, а опечатка в имени события или в поле полезной нагрузки
 * обнаруживалась бы в рантайме и выглядела бы как «уведомления не приходят».
 * С типами ошибка в имени видна компилятору.
 *
 * Имена событий и поля нагрузки — это публичный контракт с клиентом, поэтому
 * они описаны здесь, а не размазаны по обработчикам.
 */

/** Пользователь в `socket.data`: ровно то, что нужно сокету, и ничего лишнего. */
export interface SocketUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  role: string;
}

/**
 * Данные сокета.
 *
 * Заполняются один раз при handshake и дальше только читаются: сокет уже
 * аутентифицирован, и перечитывать пользователя на каждый `room:join` незачем.
 */
export interface SocketData {
  user: SocketUser;
}

/** Комментарий в том виде, в каком его отдаёт REST. */
export interface WireComment {
  id: string;
  bookFileKind: string;
  text: string;
  anchor: AnyAnchor;
  anchorType: AnchorType;
  isSpoiler: boolean;
  isResolved: boolean;
  parentId: string | null;
  createdAt: string;
  editedAt: string | null;
  author: { id: string; username: string; displayName: string; avatar: string | null };
  reactions: Array<{ emoji: string; count: number; userIds: string[] }>;
  replies?: WireComment[];
}

/** Где находится человек в книге. */
export type PositionType = 'text' | 'timestamp';

export interface PresencePayload {
  roomId: string;
  positionType: PositionType;
  /** Положение внутри главы или секунда. Форма свободный: это Json в базе. */
  positionData: Record<string, unknown>;
}

/** Присутствие в том виде, в каком оно уходит клиенту. */
export interface PresenceEntry {
  userId: string;
  displayName: string;
  avatar: string | null;
  roomId: string;
  positionType: PositionType;
  positionData: Record<string, unknown>;
  updatedAt: string;
}

/** Ответ на `room:join`. */
export interface JoinResult {
  ok: boolean;
  /** Кто сейчас в комнате. Ограничение по числу — защита от раздувания. */
  members?: PresenceEntry[];
  /** Человекочитаемая причина отказа. Машина её не различает. */
  error?: string;
}

export interface ClientToServerEvents {
  'room:join': (payload: { roomId: string }, ack: (result: JoinResult) => void) => void;
  'room:leave': (payload: { roomId: string }) => void;
  'presence:update': (payload: PresencePayload) => void;
}

export interface ServerToClientEvents {
  'room:left': (payload: { roomId: string }) => void;

  'presence:changed': (payload: PresenceEntry) => void;
  'presence:left': (payload: { userId: string; roomId: string }) => void;

  /**
   * Комментарии и реакции — сигнал, а не источник правды.
   *
   * Нагрузка достаточна, чтобы вставить объект в ленту без запроса, но
   * authoritative-версия всегда в REST: потерянное событие приводит к
   * «недостающему» комментарию до следующей перезагрузки ленты, а не к
   * рассинхрону с сервером.
   */
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

  /** Служебное: сервер подтвердил, что соединение живо. */
  'server:ready': (payload: { userId: string }) => void;
}

/** Максимум людей в одной комнате: защита от раздувания ответа `members`. */
export const MAX_PRESENCE_IN_ROOM = 200;

/**
 * Как часто присутствие сбрасывается в базу.
 *
 * Пятнадцать секунд — компромисс: чаще значит больше записи при чтении, реже
 * значит «где Борис» отстаёт на полминуты. Само присутствие держится в памяти и
 * обновляется мгновенно, медленная часть — только история.
 */
export const PRESENCE_FLUSH_MS = 15_000;
