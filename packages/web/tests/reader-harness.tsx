import { expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReaderPage } from '../src/pages/Reader.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type { BlockKind, XmlText } from '@rd/library/parse';
import type { BookIndex, BookSummary, ChapterBlock, CurrentUser, WireComment } from '../src/api/types.js';

/**
 * Читалка с комментариями — общая оснастка для проверок двусторонней связи.
 *
 * ─── Почему не проверять панель и маркер по отдельности ───────────────────────
 *
 * Связь живёт в странице: маркер накладывает `ChapterView`, панель рисует
 * `CommentsPanel`, а прокручивает их между собой `Reader`. Ни одна из этих
 * частей не знает о другой, и проверка каждой отдельно была бы зелёной при
 * сломанной связи — то есть проверяла бы не то.
 *
 * Файл называется не `.test.tsx` и потому vitest его не запускает: это
 * приспособление, а не проверка.
 */

export const ME: CurrentUser = {
  id: 'u1',
  username: 'anya',
  displayName: 'Аня',
  avatar: null,
  role: 'user',
};

/** Абзацы главы 0. Слова уникальные — по ним проверки узнают свои маркеры. */
export const PARAGRAPHS = [
  'ветер ветер письмо улица дорога фонарь страница письмо ночь окно вода',
  'тишина фонарь дорога тишина город книга книга слово страница день рука',
];

function textNode(text: string): XmlText {
  return { name: '#text', text, attrs: {}, children: [] };
}

function block(n: number, kind: BlockKind, text: string): ChapterBlock {
  return { index: n, kind, node: { name: kind, attrs: {}, children: [textNode(text)] }, text };
}

/** Глава из заголовка и двух абзацев. */
export function chapterOf(): ChapterBlock[] {
  return [
    block(0, 'h1', 'Глава 1'),
    block(1, 'p', PARAGRAPHS[0]!),
    block(2, 'p', PARAGRAPHS[1]!),
  ];
}

function makeBook(): BookSummary {
  return {
    id: 'b1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    description: null,
    authorBio: null,
    coverUrl: null,
    isCatalog: false,
    language: 'ru',
    year: null,
    uploadedById: 'u2',
    createdAt: '2026-01-01T00:00:00.000Z',
    hasText: true,
    hasAudio: false,
    files: [
      {
        kind: 'text',
        format: 'epub',
        fileSize: 1024,
        mimeType: 'application/epub+zip',
        durationSec: null,
        parsed: true,
        url: '/api/books/b1/file?kind=text',
      },
    ],
  };
}

function makeIndex(count: number): BookIndex {
  return {
    version: 1,
    parserVersion: '1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    language: 'ru',
    totalBlocks: count * 3,
    chapters: Array.from({ length: count }, (_, i) => ({
      index: i,
      id: `c${i}`,
      href: `ch${i}.xhtml`,
      title: `Глава номер ${i}`,
      blockCount: 3,
    })),
    toc: [],
    coverHref: null,
  };
}

/** Комментарий с текстовым якорем. */
export function commentAt(id: string, blockIndex: number, start: number, end: number): WireComment {
  const quote = PARAGRAPHS[blockIndex - 1]!.slice(start, end);
  return {
    id,
    bookFileKind: 'text',
    text: `Комментарий ${id}`,
    anchor: {
      kind: 'text',
      chapterIndex: 0,
      blockIndex,
      start,
      end,
      quote,
      prefix: '',
      suffix: '',
    },
    anchorType: 'text',
    isSpoiler: false,
    isResolved: false,
    parentId: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    editedAt: null,
    author: { id: 'u2', username: 'boris', displayName: 'Борис', avatar: null },
    reactions: [],
  };
}

/**
 * Ставит сеть и рисует читалку.
 *
 * `comments` — то, что отдаст сервер на список. Значение по умолчанию — три
 * комментария в разных местах первой главы.
 */
export function renderReaderWithComments(comments: WireComment[] = defaultComments()): void {
  const book = makeBook();
  const index = makeIndex(2);
  const chapters: Record<number, ChapterBlock[]> = { 0: chapterOf(), 1: chapterOf() };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/comments')) return jsonResponse({ comments, hasMore: false, nextCursor: null });
      if (url === '/api/rooms/r1/books/b1') return jsonResponse({ book });
      if (url === '/api/rooms/r1/books/b1/index.json') return jsonResponse(index);
      const m = /\/api\/rooms\/r1\/books\/b1\/ch\/(\d+)\.json/.exec(url);
      if (m !== null) return jsonResponse(chapters[Number(m[1])] ?? []);
      return jsonResponse({});
    }),
  );

  const fake = {
    emit: vi.fn(),
    connected: true,
    on: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
  };
  vi.spyOn(wsModule, 'getSocket').mockReturnValue(fake as never);
  vi.spyOn(wsModule, 'connectSocket').mockReturnValue(fake as never);

  window.localStorage.clear();
  setToken('токен');

  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/rooms/r1/books/b1']}>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: ME })}>
            <Routes>
              <Route path="/rooms/:roomId/books/:bookId" element={<ReaderPage roomId="r1" bookId="b1" />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Три комментария: два в первом абзаце и один во втором. */
export function defaultComments(): WireComment[] {
  return [
    commentAt('a', 1, 0, 5),
    commentAt('b', 1, 25, 31),
    commentAt('c', 2, 0, 7),
  ];
}

function storage(): Storage {
  const map = new Map<string, string>([['rd.token', 'токен']]);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

/** Ждёт, пока глава отрисуется и комментарии приедут. */
export async function waitReaderReady(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-block="1"]')).not.toBeNull();
  });
  await waitFor(() => {
    expect(document.querySelectorAll('mark.rd-comment-marker').length).toBeGreaterThan(0);
  });
}

/** Маркер комментария по идентификатору. */
export function markOf(commentId: string): HTMLElement | null {
  return document.querySelector(`[data-comment-id="${commentId}"]`);
}