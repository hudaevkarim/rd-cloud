/**
 * Типы ответов сервера.
 *
 * Выписаны здесь, а не берутся из `@rd/shared`: общий пакет описывает то, что
 * сервер и клиент обязаны понимать одинаково (якоря, роли), а формы ответов
 * принадлежат API и меняются вместе с ним. Дублировать их в общем пакете значило
 * бы разделить одно описание надвое и получить две версии правды.
 *
 * Что важно: `filePath` и `derivedPath` в ответах сервера нет, и здесь их тоже
 * нет. Клиенту пути на сервере не нужны, а знание структуры DATA_DIR ничего
 * полезного не даёт.
 */

/** Ошибка в формате сервера. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  role: 'user' | 'admin';
  createdAt?: string;
}

/** Кого и в каком статусе показывать в заявках. */
export type RoomTab = 'books' | 'members' | 'requests';

/** Что делает кнопка «Попроситься» в этот момент. */
export type JoinState =
  /** Человек не участник и заявки нет — можно проситься. */
  | 'can-request'
  /** Заявка висит: повторное нажатие вернуло бы 409. */
  | 'requested'
  /** Уже участник: кнопка ведёт в комнату. */
  | 'joined';

// ─── Комнаты ──────────────────────────────────────────────────────────────────

export interface RoomSummary {
  id: string;
  name: string;
  description: string | null;
  inviteCode: string;
  isPublic: boolean;
  createdAt: string;
  ownerId: string;
  _count: { members: number; books: number };
  myRole: 'owner' | 'member' | null;
}

/**
 * Комната в выдаче поиска.
 *
 * `myRole` и `myPendingRequest` обязательны и присутствуют всегда — включая
 * `null` и `false`. Клиент различает по ним «можно проситься», «уже в комнате»
 * и «заявка висит»; отсутствующий ключ означал бы «забыли отдать», и молчание
 * выглядело бы как «не участник».
 *
 * `memberCount` — плоское число, а не вложенный `_count`: вложенный объект
 * просит на клиенте разбираться в форме ответа там, где достаточно одного
 * числа для подписи «3 участника».
 */
export interface RoomSearchHit {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  owner: { id: string; displayName: string };
  myRole: 'owner' | 'member' | null;
  myPendingRequest: boolean;
}

export interface RoomMember {
  userId: string;
  role: 'owner' | 'member';
  joinedAt: string;
  user: { id: string; username: string; displayName: string; avatar: string | null };
}

export interface Room extends RoomSummary {
  owner: { id: string; username: string; displayName: string; avatar: string | null };
}

export interface JoinRequest {
  id: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  user: { id: string; username: string; displayName: string; avatar: string | null };
}

/**
 * Типы уведомлений, которые сервер шлёт через `notification:new`.
 *
 * Объявлены здесь, а не в сокетном контракте строкой: обработчик тоста должен
 * превращаться в ошибку компиляции при опечатке в имени, иначе уведомление
 * просто не покажется — тихо и навсегда.
 */
export type NotificationType =
  | 'join_request'
  | 'join_approved'
  | 'join_rejected'
  | 'kicked'
  | 'added'
  | 'new_book'
  | 'reaction'
  | 'reply';

/** Нагрузка `notification:new`. Содержимое `payload` зависит от типа. */
export interface WireNotification {
  id: string;
  type: NotificationType;
  payload: {
    roomId?: string;
    roomName?: string;
    userId?: string;
    userName?: string;
    commentId?: string;
    emoji?: string;
    bookId?: string;
  };
  createdAt: string;
}

// ─── Книги ───────────────────────────────────────────────────────────────────

export interface BookFileSummary {
  kind: 'text' | 'audio';
  format: string;
  fileSize: number;
  mimeType: string;
  durationSec: number | null;
  /** Есть ли разбор: по флагу клиент решает, запрашивать ли главы. */
  parsed: boolean;
  url: string;
}

export interface BookSummary {
  id: string;
  title: string;
  author: string;
  description: string | null;
  /** Биография автора. Заполняется для книг каталога. */
  authorBio: string | null;
  coverUrl: string | null;
  isCatalog: boolean;
  language: string | null;
  year: number | null;
  /** Кто загрузил: по нему решается, может ли участник убрать книгу из комнаты. */
  uploadedById: string | null;
  createdAt: string;
  /** Короткий ответ на вопрос «что открывать», без разбора списка файлов. */
  hasText: boolean;
  hasAudio: boolean;
  files: BookFileSummary[];
}

/**
 * Книга в том виде, в каком приходит в событии `book:added`.
 *
 * Уже и есть `BookSummary`, но событие летит каждому подписчику комнаты, и
 * тянуть в нём список файлов с адресами и флагами разбора значило бы отправлять
 * лишнее каждому. Поэтому событие несёт шесть полей, а не `files`.
 */
export interface BookEvent {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  hasText: boolean;
  hasAudio: boolean;
}

/** Найденная книга в одной из моих комнат. */
export interface BookHitInRoom extends BookEvent {
  /** Комната нужна для перехода: книга может лежать в нескольких сразу. */
  roomId: string;
  roomName: string;
}

/** Найденная книга в общем каталоге. */
export interface BookHitInCatalog extends BookEvent {
  isCatalog: true;
}

export interface BookSearchResult {
  inRooms: BookHitInRoom[];
  catalog: BookHitInCatalog[];
}

/** Оглавление, отдаваемое сервером как есть: `derived/<id>/index.json`. */
export interface BookIndex {
  version: 1;
  parserVersion: string;
  title: string;
  author: string;
  language: string;
  totalBlocks: number;
  chapters: Array<{
    index: number;
    id: string;
    href: string;
    title: string;
    blockCount: number;
  }>;
  toc: Array<{ label: string; chapterIndex: number; blockIndex: number }>;
  coverHref: string | null;
}

/** Блок главы. Форма та же, что на диске: массив объектов `ch/NNNN.json`. */
export interface ChapterBlock {
  type?: string;
  text: string;
  node?: unknown;
}

// ─── Комментарии ─────────────────────────────────────────────────────────────

export type AnchorType = 'text' | 'timestamp' | 'page';

export interface WireComment {
  id: string;
  bookFileKind: string;
  text: string;
  anchor: unknown;
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

export interface CommentPage {
  comments: WireComment[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CommentCounts {
  total: number;
  byChapter: Record<string, number>;
  byAnchorType: Record<string, number>;
}

/** Допустимые реакции — тот же белый список, что на сервере. */
export const REACTION_EMOJI = ['👍', '❤️', '😄', '🤔', '😢', '🎉'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

// ─── Админка и каталог ───────────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  role: 'user' | 'admin';
  createdAt: string;
  _count?: { rooms: number; comments: number };
}

export interface AdminStats {
  users: number;
  rooms: number;
  books: number;
  comments: number;
  [key: string]: number;
}
