import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
 * Полный цикл: выделение → кнопка → окно → отправка → маркер.
 *
 * ─── Почему именно сквозной тест ───────────────────────────────────────────────
 *
 * Каждое звено по отдельности проверено в других файлах, а вот связь между ними
 * — нет. Ошибка почти всегда здесь и тихая: якорь построен, отправлен, сервер
 * ответил, а маркер не появился, потому что комментарий не попал в тот массив,
 * который смотрит `ChapterView`. Список в панели (7.4.2.3) его бы показал, но
 * до той поры человек не увидел бы ничего.
 */

const USER: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' };

/** Абзац главы: длинный, чтобы контекст якоря был непустым. */
const PARAGRAPH = 'ветер ветер письмо улица дорога фонарь страница письмо';

let book: BookSummary;
let index: BookIndex;
let chapters: Record<number, ChapterBlock[]>;
/** Тело последнего запроса создания комментария. */
let created: Array<Record<string, unknown>>;
/** Ответ, который сервер вернёт на создание. */
let createReply: (id: string) => WireComment;
/** Якорь из последнего запроса — сервер возвращает его же, что и получил. */
let lastAnchor: Record<string, unknown>;

function textNode(text: string): XmlText {
  return { name: '#text', text, attrs: {}, children: [] };
}

function block(n: number, kind: BlockKind, text: string): ChapterBlock {
  return { index: n, kind, node: { name: kind, attrs: {}, children: [textNode(text)] }, text };
}

function chapterOf(): ChapterBlock[] {
  return [
    block(0, 'h1', 'Глава 1'),
    block(1, 'p', PARAGRAPH),
    block(2, 'p', 'Часть 0'),
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

beforeEach(() => {
  book = makeBook();
  index = makeIndex(2);
  chapters = { 0: chapterOf(), 1: chapterOf() };
  created = [];
  lastAnchor = {};

  /*
    Ответ повторяет присланный якорь, а не выдумывает свой.

    Так поступает настоящий сервер: он кладёт в базу проверенный `anchor` и
    возвращает его же. Подмена своим якорем со `kind` без координат была бы
    проверкой не ответа, а выдумки — и прокол нашёлся бы сразу и не по той
    причине, которую эта проверка защищает.
  */
  createReply = (id) => ({
    id,
    bookFileKind: 'text',
    text: 'Комментарий',
    anchor: lastAnchor,
    anchorType: 'text',
    isSpoiler: false,
    isResolved: false,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    author: { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null },
    reactions: [],
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/comments') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        created.push(body);
        lastAnchor = body['anchor'] as Record<string, unknown>;
        const id = `c${created.length}`;
        // Сервер дописывает вычисленный `anchorType`: клиент его не присылает.
        return jsonResponse({ comment: { ...createReply(id), text: String(body['text']) } }, 201);
      }
      if (url.includes('/comments')) {
        return jsonResponse({ comments: [], hasMore: false, nextCursor: null });
      }
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
  await waitFor(() => {
    expect(document.querySelector('[data-block="1"]')).not.toBeNull();
  });
}

/**
 * Выделяет диапазон символов внутри элемента.
 *
 * Обход текстовых узлов, а не `firstChild`: после первого комментария блок уже
 * разрезан обёртками маркера, и `firstChild` — это короткий кусок в начале.
 * Проверка, которая брала бы `firstChild`, падала бы «Offset out of bound» на
 * втором комментарии — то есть ложно обвиняла бы код там, где он прав.
 * Настоящий человек выделяет мышью и тоже видит разрезанный текст.
 */
function selectRange(el: HTMLElement, from: number, to: number): void {
  const walker = document.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let seen = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const len = text.data.length;
    if (startNode === null && from <= seen + len) {
      startNode = text;
      startOffset = from - seen;
    }
    if (endNode === null && to <= seen + len) {
      endNode = text;
      endOffset = to - seen;
    }
    seen += len;
  }

  const range = document.createRange();
  range.setStart(startNode ?? el, startOffset);
  range.setEnd(endNode ?? el, endOffset);

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Выделяет первые пять символов второго блока и нажимает кнопку. */
async function selectAndOpen(): Promise<void> {
  const el = document.querySelector('[data-block="1"]') as HTMLElement;
  selectRange(el, 0, 5);
  el.dispatchEvent(new Event('pointerup', { bubbles: true }));
  await userEvent.click(await screen.findByRole('button', { name: 'Комментировать' }));
}

describe('создание комментария целиком', () => {
  it('выделение, отправка и маркер в тексте', async () => {
    renderReader();
    await waitChapter();

    await selectAndOpen();
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Смотри сюда');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(document.querySelector('mark.rd-comment-marker')).not.toBeNull();
    });
    const mark = document.querySelector('mark.rd-comment-marker')!;
    expect(mark.textContent).toBe('ветер');
    expect(mark.closest('[data-block="1"]')).not.toBeNull();
  });

  it('окно закрывается, выделение снимается, показывается тост', async () => {
    renderReader();
    await waitChapter();
    await selectAndOpen();
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Готово');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('Комментарий добавлен')).toBeInTheDocument();
    // Подсветка фрагмента снята: иначе следующий клик открыл бы старую кнопку.
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);
  });

  it('тело запроса: без anchorType, с флагом спойлера', async () => {
    renderReader();
    await waitChapter();
    await selectAndOpen();
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Тайна');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Спойлер' }));
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    const body = created[0]!;
    expect(body['text']).toBe('Тайна');
    expect(body['bookFileKind']).toBe('text');
    expect(body['isSpoiler']).toBe(true);
    // Ключевое поле: сервер отвергает запрос с `anchorType`, а не «не обращает
    // внимания». Его отсутствие здесь — часть контракта, а не мелочь.
    expect('anchorType' in body).toBe(false);

    const anchor = body['anchor'] as Record<string, unknown>;
    expect(anchor).toMatchObject({
      kind: 'text',
      chapterIndex: 0,
      blockIndex: 1,
      start: 0,
      end: 5,
      quote: 'ветер',
      prefix: '',
    });
    expect(typeof anchor['suffix']).toBe('string');
  });

  it('два комментария подряд дают два маркера', async () => {
    renderReader();
    await waitChapter();

    await selectAndOpen();
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Первый');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => {
      expect(document.querySelectorAll('mark.rd-comment-marker')).toHaveLength(1);
    });

    // Второй: выделяем другое место того же абзаца.
    const el = document.querySelector('[data-block="1"]') as HTMLElement;
    selectRange(el, 25, 31);
    el.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Комментировать' }));
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Второй');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(document.querySelectorAll('mark.rd-comment-marker')).toHaveLength(2);
    });
    const texts = [...document.querySelectorAll('mark.rd-comment-marker')].map((m) => m.textContent);
    expect(texts).toEqual(['ветер', 'дорога']);
  });

  it('глава не перерисовывается: текст и разметка те же', async () => {
    const chapterCalls = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/comments') && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          created.push(body);
          lastAnchor = body['anchor'] as Record<string, unknown>;
          return jsonResponse({ comment: { ...createReply(`c${created.length}`), text: String(body['text']) } }, 201);
        }
        if (url.includes('/comments')) {
          return jsonResponse({ comments: [], hasMore: false, nextCursor: null });
        }
        if (url === '/api/rooms/r1/books/b1') return jsonResponse({ book });
        if (url === '/api/rooms/r1/books/b1/index.json') return jsonResponse(index);
        const m = /\/api\/rooms\/r1\/books\/b1\/ch\/(\d+)\.json/.exec(url);
        if (m !== null) {
          chapterCalls(url);
          return jsonResponse(chapters[Number(m[1])] ?? []);
        }
        return jsonResponse({});
      }),
    );

    renderReader();
    await waitChapter();
    const callsBefore = chapterCalls.mock.calls.length;

    await selectAndOpen();
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Без перерисовки');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(document.querySelector('mark.rd-comment-marker')).not.toBeNull();
    });
    // Маркер появился, а глава не запрашивалась заново: текст не трогали.
    expect(chapterCalls.mock.calls.length).toBe(callsBefore);
  });

  it('комментарий из другой главы на этой странице не появляется', async () => {
    /*
      Якорь строится из номера текущей главы, а не из чего-то общего: комментарий
      к главе 2 не должен подсветить первый абзац главы 1. Проверяется здесь, где
      глава известна точно, а не на уровне выделения.
    */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/comments')) {
          return jsonResponse({
            comments: [
              {
                id: 'x1',
                bookFileKind: 'text',
                text: 'Из другой главы',
                anchor: { kind: 'text', chapterIndex: 1, blockIndex: 1, start: 0, end: 5, quote: 'ветер' },
                anchorType: 'text',
                isSpoiler: false,
                isResolved: false,
                parentId: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                editedAt: null,
                author: { id: 'u2', username: 'boris', displayName: 'Борис', avatar: null },
                reactions: [],
              },
            ],
            hasMore: false,
            nextCursor: null,
          });
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
      expect(
        (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
          String(c[0]).includes('/comments'),
        ),
      ).toBe(true);
    });

    expect(document.querySelector('mark.rd-comment-marker')).toBeNull();

    // А на своей главе маркер появляется.
    await userEvent.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitFor(() => {
      expect(document.querySelector('mark.rd-comment-marker')).not.toBeNull();
    });
  });

  it('Ctrl+Enter отправляет комментарий', async () => {
    renderReader();
    await waitChapter();
    await selectAndOpen();

    const textarea = screen.getByLabelText('Комментарий');
    await userEvent.type(textarea, 'Через клавиши');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(created).toHaveLength(1);
    });
    expect(created[0]!['text']).toBe('Через клавиши');
  });

  it('пустой комментарий не уходит на сервер', async () => {
    renderReader();
    await waitChapter();
    await selectAndOpen();

    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Комментарий'), '  ');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    expect(created).toHaveLength(0);
  });

  it('после отправки форма чистая, а не в состоянии ошибки', async () => {
    renderReader();
    await waitChapter();
    await selectAndOpen();
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Один раз');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Второе открытие не должно начинаться со старого текста.
    await selectAndOpen();
    expect(screen.getByLabelText('Комментарий')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });
});

