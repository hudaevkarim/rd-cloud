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

/**
 * Книга в том виде, в каком она уходит в событии.
 *
 * Отдельный тип, а не `BookSummary` из маршрутов: маршруты отдают ещё `files` с
 * адресами и флагами разбора, а в списке комнаты для показа достаточно обложки,
 * названия и пары «есть текст / есть аудио». Лишние поля в каждом событии — это
 * лишние байты на каждого подписчика.
 */
export interface BookEventPayload {
  id: string;
  title: string;
  author: string;
  /** Адрес обложки или `null`, если её нет. */
  coverUrl: string | null;
  hasText: boolean;
  hasAudio: boolean;
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
   * Книга в комнате: загружена файлом или добавлена из каталога.
   *
   * Одно событие на оба пути — с точки зрения читателя это одно и то же, и
   * различать их в обработчике незачем. `source` нужен только тосту: «Борис
   * загрузил книгу» и «Борис добавил книгу из каталога» — разные фразы.
   *
   * Нагрузки хватает, чтобы вставить книгу в список без запроса. Пропущенное
   * событие приведёт к «недостающей» книге до перезагрузки, а не к
   * рассинхрону: REST остаётся источником правды, и по F5 всё сойдётся.
   */
  'book:added': (payload: {
    roomId: string;
    book: BookEventPayload;
    addedBy: { id: string; displayName: string };
    source: 'upload' | 'catalog';
  }) => void;
  'book:removed': (payload: { roomId: string; bookId: string }) => void;

  /** Книга добавлена в общий каталог. Всем подключённым, не в комнату. */
  'catalog:book:added': (payload: {
    book: BookEventPayload;
    addedBy: { id: string; displayName: string };
  }) => void;

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
