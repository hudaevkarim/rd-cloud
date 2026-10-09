import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
 * Читалка загружает комментарии и показывает маркеры.
 *
 * ─── Почему проверяется страница, а не `ChapterView` ───────────────────────────
 *
 * Между страницей и компонентом есть работа, которую не видит ни один из них
 * по отдельности: **фильтр по главе**. `ChapterView` получает только маркеры
 * текущей главы, а решает это страница. Ошибка здесь тихая и неприятная: маркер
 * из второй главы подсветил бы первый абзац первой — координаты сошлись бы,
 * цитата нашлась бы, и человек увидел бы чужое обсуждение на своей странице.
 *
 * Второе, что проверяется здесь, — что сломанный ответ обсуждения не уносит
 * текст книги. Человек открыл книгу, чтобы её прочитать: отсутствие чужих
 * пометок должно выглядеть как обычная страница, а не как пустой экран.
 */

const USER: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' };

let book: BookSummary;
let index: BookIndex;
let chapters: Record<number, ChapterBlock[]>;
let requestedChapters: number[] = [];
/** Что сервер отдаёт на запрос комментариев. */
let commentsReply: unknown;
/**
 * Ворота ответа обсуждения.
 *
 * ─── Зачем они нужны ──────────────────────────────────────────────────────────
 *
 * Проверки «маркера нет» иначе проходят до ответа сервера: страница успевает
 * отрисовать главу раньше, чем придёт обсуждение, и `expect(marks()).toHaveLength(0)`
 * оказывается верным не по той причине, ради которой написан. Утверждение о
 * положительном результате с честным `waitFor` такой поломки не ловит, а
 * отрицательное — самое важное здесь.
 *
 * Поэтому запрос комментариев висит на промиссе, который открывает тест: с
 * момента `resolveComments()` страница получила данные, и любое «маркера нет»
 * после этого означает «фильтр отсеял», а не «ещё не пришло».
 */
let commentsGate: Promise<void>;
let openCommentsGate: () => void;

function textNode(text: string): XmlText {
  return { name: '#text', text, attrs: {}, children: [] };
}

function block(index: number, kind: BlockKind, text: string): ChapterBlock {
  return { index, kind, node: { name: kind, attrs: {}, children: [textNode(text)] }, text };
}

function chapterOf(n: number): ChapterBlock[] {
  return [
    block(0, 'h1', `Глава номер ${n}`),
    block(1, 'p', `Абзац главы ${n}. Он достаточно длинный, чтобы строка заняла место.`),
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
    totalBlocks: count * 2,
    chapters: Array.from({ length: count }, (_, i) => ({
      index: i,
      id: `c${i}`,
      href: `ch${i}.xhtml`,
      title: `Глава номер ${i}`,
      blockCount: 2,
    })),
    toc: [],
    coverHref: null,
  };
}

/**
 * Комментарий с текстовым якорем.
 *
 * Номер главы задаётся отдельно от `over`: подменить его через `Partial`
 * нельзя, `anchor` — вложенный объект, и `{ ...anchor, chapterIndex }` в
 * тесте читался бы как «объект целиком переопределён», а не «поменялось одно
 * поле».
 */
function textComment(chapterIndex: number, over: Partial<WireComment> = {}): WireComment {
  return {
    id: `c${chapterIndex}`,
    bookFileKind: 'text',
    text: 'Комментарий',
    anchor: {
      kind: 'text',
      chapterIndex,
      blockIndex: 1,
      start: 0,
      end: 7,
      quote: 'Абзац ',
      prefix: '',
      suffix: 'главы',
    },
    anchorType: 'text',
    isSpoiler: false,
    isResolved: false,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    author: { id: 'u2', username: 'boris', displayName: 'Борис', avatar: null },
    reactions: [],
    ...over,
  };
}

beforeEach(() => {
  requestedChapters = [];
  book = makeBook();
  index = makeIndex(3);
  chapters = { 0: chapterOf(0), 1: chapterOf(1), 2: chapterOf(2) };
  commentsReply = { comments: [], hasMore: false, nextCursor: null };
  commentsGate = new Promise<void>((resolve) => {
    openCommentsGate = resolve;
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/rooms/r1/books/b1') return jsonResponse({ book });
      if (url === '/api/rooms/r1/books/b1/index.json') return jsonResponse(index);
      if (url.includes('/comments')) {
        await commentsGate;
        return jsonResponse(commentsReply);
      }
      const m = /\/api\/rooms\/r1\/books\/b1\/ch\/(\d+)\.json/.exec(url);
      if (m !== null) {
        const n = Number(m[1]);
        requestedChapters.push(n);
        const data = chapters[n];
        if (data === undefined) return jsonResponse({ error: { code: 'not_found', message: 'Глава' } }, 404);
        return jsonResponse(data);
      }
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  setToken(null);
});

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

function renderReader() {
  return render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/rooms/r1/books/b1']}>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
            <Routes>
              <Route path="/rooms/:roomId/books/:bookId" element={<ReaderPage roomId="r1" bookId="b1" />} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

async function waitChapter(): Promise<void> {
  await waitForElementToBeRemoved(() => screen.queryByText('Открываем книгу'));
  await waitFor(() => {
    expect(document.querySelector('[data-block="1"]')).not.toBeNull();
  });
}

function marks(): NodeListOf<Element> {
  return document.querySelectorAll('mark.rd-comment-marker');
}

/** Ждёт, пока запрос комментариев уйдёт, и открывает ворота ответа. */
async function loadComments(): Promise<void> {
  await waitFor(() => {
    expect(
      (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
        String(c[0]).includes('/comments'),
      ),
    ).toBe(true);
  });
  openCommentsGate();
}

describe('загрузка комментариев читалкой', () => {
  it('запрашивает комментарии книги при открытии', async () => {
    commentsReply = { comments: [textComment(0)], hasMore: false, nextCursor: null };

    renderReader();
    await waitChapter();
    await loadComments();

    await waitFor(() => {
      expect(marks()).toHaveLength(1);
    });
    expect(marks()[0]?.textContent).toBe('Абзац ');
  });

  it('маркер из другой главы не попадает на текущую страницу', async () => {
    commentsReply = { comments: [textComment(2)], hasMore: false, nextCursor: null };

    renderReader();
    await waitChapter();
    await loadComments();

    // Ответ пришёл и отфильтрован: отсутствие маркера означает «не та глава».
    expect(marks()).toHaveLength(0);
  });

  it('при переходе на главу маркер из неё появляется', async () => {
    commentsReply = { comments: [textComment(1)], hasMore: false, nextCursor: null };

    renderReader();
    await waitChapter();
    await loadComments();
    expect(marks()).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Оглавление' }));
    await userEvent.click(screen.getByRole('button', { name: 'Глава номер 1' }));

    await waitFor(() => {
      expect(marks()).toHaveLength(1);
    });
    // Маркер в блоке первой главы, а не в заголовке.
    expect(marks()[0]?.closest('[data-block="1"]')).not.toBeNull();
    expect(requestedChapters).toContain(1);
  });

  it('аудиокомментарий не превращается в маркер', async () => {
    /*
      У аудио-якоря нет `chapterIndex`. Без проверки типа он отсеивался бы
      правильно — `undefined !== chapter` — но по неверной причине, и поломка
      этой причины осталась бы незамеченной, пока не появилась бы подсветка
      аудиокомментария в тексте.
    */
    const audio = textComment(0, { id: 'a1', bookFileKind: 'audio', anchorType: 'timestamp' });
    commentsReply = { comments: [audio], hasMore: false, nextCursor: null };

    renderReader();
    await waitChapter();
    await loadComments();

    expect(marks()).toHaveLength(0);
  });

  it('сломанный ответ обсуждения не уносит текст книги', async () => {
    /*
      Сервер может отдать поле `comments` не массивом. Человек открыл книгу,
      чтобы её прочитать, и текст главы тут важнее обсуждения: страница
      обязана остаться книгой, а не упасть на `filter is not a function`.
    */
    commentsReply = { comments: null, hasMore: false, nextCursor: null };

    renderReader();
    await waitChapter();
    await loadComments();

    expect(document.querySelector('[data-block="1"]')?.textContent).toContain('Абзац главы 0');
    expect(marks()).toHaveLength(0);
  });

  it('неудача запроса комментариев не мешает чтению', async () => {
    /*
      Обсуждение — часть книги, а не условие её открытия. Отказ сети по нему
      даёт обычную главу без пометок, а не «нечитается».
    */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/comments')) {
          return jsonResponse({ error: { code: 'x', message: 'Отказ' } }, 500);
        }
        if (url === '/api/rooms/r1/books/b1') return jsonResponse({ book });
        if (url === '/api/rooms/r1/books/b1/index.json') return jsonResponse(index);
        const m = /\/api\/rooms\/r1\/books\/b1\/ch\/(\d+)\.json/.exec(url);
        if (m !== null) return jsonResponse(chapters[Number(m[1])] ?? []);
        return jsonResponse({});
      }),
    );

    renderReader();
    await waitChapter();

    await waitFor(() => {
      expect(document.querySelector('[data-block="1"]')?.textContent).toContain('Абзац главы 0');
    });
    expect(marks()).toHaveLength(0);
  });

  it('два комментария в разных местах блока дают два маркера', async () => {
    const second = textComment(0, {
      id: 'c2',
      anchor: {
        kind: 'text',
        chapterIndex: 0,
        blockIndex: 1,
        start: 8,
        end: 14,
        quote: 'главы ',
        prefix: 'Абзац ',
        suffix: '0.',
      },
    });
    commentsReply = { comments: [textComment(0), second], hasMore: false, nextCursor: null };

    renderReader();
    await waitChapter();
    await loadComments();

    await waitFor(() => {
      expect(marks()).toHaveLength(2);
    });
    // Обе цитаты подчёркнуты отдельно: соседние маркеры не сливаются в одну линию.
    expect(marks()[0]?.textContent).toBe('Абзац ');
    expect(marks()[1]?.textContent).toBe('главы ');
  });
});