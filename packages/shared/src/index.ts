/**
 * Общие типы и схемы.
 *
 * Правило: то, что описывает контракт между сервером и клиентом, живёт здесь и
 * не дублируется. Тип, скопированный в две стороны, разъезжается на первом же
 * изменении — и разъезд обнаруживается в рантайме, а не компилятором.
 */

export * from './anchors.js';

/** Роль пользователя. */
export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Тип файла книги. */
export const BOOK_FILE_KINDS = ['text', 'audio'] as const;
export type BookFileKind = (typeof BOOK_FILE_KINDS)[number];

/** Форматы файлов. */
export const BOOK_FORMATS = ['epub', 'fb2', 'pdf', 'mp3', 'm4b'] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isBookFileKind(value: unknown): value is BookFileKind {
  return typeof value === 'string' && (BOOK_FILE_KINDS as readonly string[]).includes(value);
}