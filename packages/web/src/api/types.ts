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

export interface RoomSearchHit {
  id: string;
  name: string;
  description: string | null;
  _count: { members: number };
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
  coverUrl: string | null;
  isCatalog: boolean;
  language: string | null;
  year: number | null;
  createdAt: string;
  files: BookFileSummary[];
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
