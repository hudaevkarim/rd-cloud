import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReaderPage } from '../src/pages/Reader.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import { positionKey } from '../src/books/reading-position.js';
import * as wsModule from '../src/ws/client.js';
import { jsonResponse } from './setup.js';
import type { BlockKind, XmlText } from '@rd/library/parse';
import type { BookIndex, BookSummary, ChapterBlock, CurrentUser } from '../src/api/types.js';

/**
 * Читалка: рендер главы, навигация, горячие клавиши.
 *
 * Главное здесь — что текст попадает в DOM через рендерер библиотеки, а не
 * строкой: содержание книги недоверенное, и проверка идёт именно по узлам
 * `data-block`, которые ставит рендерер. Якоря комментариев в 7.4.2 ищутся по
 * тем же узлам, поэтому «в DOM есть блок» — не деталь реализации, а контракт.
 */

const USER: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'user' };

let book: BookSummary;
let index: BookIndex;
let chapters: Record<number, ChapterBlock[]>;
let calls: string[] = [];
/** Глав, запрошенный последним: по нему видно, какая глава на экране. */
let requestedChapters: number[] = [];

/** Текстовый узел: у него `name` всегда `'#text'`. */
function textNode(text: string): XmlText {
  return { name: '#text', text, attrs: {}, children: [] };
}

/**
 * Блок главы ровно такой формы, какую пишет сервер в `ch/NNNN.json`.
 *
 * Вид блока — закрытый союз `BlockKind`: подставить произвольную строку
 * значило бы скрыть ошибку в формате главы до момента, когда она проявится
 * на тексте у человека.
 */
function block(index: number, kind: BlockKind, text: string): ChapterBlock {
  return {
    index,
    kind,
    node: { name: kind, attrs: {}, children: [textNode(text)] },
    text,
  };
}

function chapterOf(n: number, paragraphs = 3): ChapterBlock[] {
  const blocks: ChapterBlock[] = [block(0, 'h1', `Глава номер ${n}`)];
  for (let i = 1; i <= paragraphs; i += 1) {
    blocks.push(block(i, 'p', `Абзац ${i} главы ${n}. Он достаточно длинный, чтобы строка заняла место.`));
  }
  return blocks;
}

function makeBook(over: Partial<BookSummary> = {}): BookSummary {
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
    ...over,
  };
}

function makeIndex(count: number): BookIndex {
  return {
    version: 1,
    parserVersion: '1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    language: 'ru',
    totalBlocks: count * 4,
    chapters: Array.from({ length: count }, (_, i) => ({
      index: i,
      id: `c${i}`,
      href: `ch${i}.xhtml`,
      title: `Глава номер ${i}`,
      blockCount: 4,
    })),
    toc: [],
    coverHref: null,
  };
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

beforeEach(() => {
  calls = [];
  requestedChapters = [];
  book = makeBook();
  index = makeIndex(3);
  chapters = {
    0: chapterOf(0),
    1: chapterOf(1),
    2: chapterOf(2),
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(`GET ${url}`);
      if (url === '/api/rooms/r1/books/b1') return jsonResponse({ book });
      if (url === '/api/rooms/r1/books/b1/index.json') return jsonResponse(index);
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

/** Возвращает контейнер рендера: проверкам позиции нужен доступ к нему. */
function renderReader(): { container: HTMLElement } {
  return render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/rooms/r1/books/b1']}>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
            <Routes>
              <Route path="/rooms/:roomId/books/:bookId" element={<ReaderPage roomId="r1" bookId="b1" />} />
              <Route path="/rooms/:roomId" element={<span>Комната</span>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/**
 * Ждать главу внутри текста, а не на странице.
 *
 * Заголовок главы есть и в оглавлении, и в тексте: поиск по странице находит
 * две строки и падает на «multiple elements». Ищем по контейнеру `.chapter` —
 * это ровно то место, где строит DOM рендерер.
 */
async function waitChapter(n = 0): Promise<HTMLElement> {
  // Сначала сам контейнер: он появляется вместе с запросом главы, а текст
  // внутри — следующим кадром, уже от рендерера.
  const host = await waitFor(() => {
    const el = document.querySelector('.chapter');
    expect(el, 'контейнер главы должен появиться').not.toBeNull();
    return el as HTMLElement;
  });

  await within(host).findByText(`Глава номер ${n}`);
  return host;
}

/**
 * Элемент списка по номеру.
 *
 * `noUncheckedIndexedAccess` делает `items[2]` типом «или undefined», и
 * `within(undefined)` не принимается. Здесь отсутствие элемента — падение с
 * понятным сообщением, а не `Cannot read properties of undefined` через три
 * строки ниже.
 */
function itemAt(items: HTMLElement[], n: number): HTMLElement {
  const el = items[n];
  if (el === undefined) throw new Error(`В оглавлении нет пункта ${n}`);
  return el;
}

describe('рендер главы', () => {
  it('блоки строятся рендерером, с атрибутом data-block', async () => {
    renderReader();
    await waitChapter();

    const host = document.querySelector('.chapter') as HTMLElement;
    // Атрибут ставит рендерер библиотеки. На нём же ищутся якоря комментариев
    // в 7.4.2, поэтому его наличие — контракт, а не деталь оформления.
    expect(host.querySelectorAll('[data-block]').length).toBe(4);
    expect(host.querySelector('[data-block="0"]')?.tagName).toBe('H1');
    expect(host.querySelector('[data-block="1"]')?.tagName).toBe('P');
  });

  it('текст книги попадает как текст, а не как разметка', async () => {
    renderReader();
    await waitChapter();

    const host = document.querySelector('.chapter') as HTMLElement;
    // Скрипт внутри абзаца обязан остаться текстом: содержимое книги
    // недоверенное, и рендерер строит DOM через `textContent`.
    expect(host.querySelector('script')).toBeNull();
    expect(host.innerHTML).not.toContain('dangerouslySetInnerHTML');
  });

  it('при смене главы прошлая не остаётся под новой', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    await u.click(screen.getByRole('button', { name: 'Следующая' }));

    await waitChapter(1);
    const host = document.querySelector('.chapter') as HTMLElement;
    // Две главы подряд читались бы как одна, и «где я» стало бы неизвестно.
    expect(host.textContent).not.toContain('Глава номер 0');
    expect(host.querySelectorAll('[data-block]').length).toBe(4);
  });

  it('заголовок книги и автор над текстом', async () => {
    renderReader();
    await waitChapter();

    expect(screen.getByRole('heading', { name: 'Евгений Онегин' })).toBeInTheDocument();
    expect(screen.getByText('А. С. Пушкин')).toBeInTheDocument();
  });
});

describe('навигация', () => {
  it('полоса прогресса показывает номер главы', async () => {
    renderReader();
    await waitChapter();

    const bar = screen.getByRole('progressbar', { name: 'Прогресс по главам' });
    expect(bar).toHaveAttribute('aria-valuemin', '1');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(bar).toHaveAttribute('aria-valuenow', '1');

    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitChapter(1);

    expect(screen.getByRole('progressbar', { name: 'Прогресс по главам' })).toHaveAttribute(
      'aria-valuenow',
      '2',
    );
  });

  it('первая и последняя главы: кнопки гаснут', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    // На первой главе «Предыдущая» обещала бы переход туда же, а на последней
    // «Следующая» — в несуществующую главу.
    expect(screen.getByRole('button', { name: 'Предыдущая' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Следующая' })).toBeEnabled();

    await u.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitChapter(1);
    await u.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitChapter(2);

    expect(screen.getByRole('button', { name: 'Следующая' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Предыдущая' })).toBeEnabled();
  });

  it('оглавление перечисляет главы и текущая помечена', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    const toc = screen.getByRole('navigation', { name: 'Оглавление' });
    const items = within(toc).getAllByRole('button');
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      'Глава номер 0',
      'Глава номер 1',
      'Глава номер 2',
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'true');

    await u.click(itemAt(items, 2));
    await waitChapter(2);
    expect(itemAt(within(toc).getAllByRole('button'), 2)).toHaveAttribute('aria-current', 'true');
  });

  it('переход по оглавлению не грузит главы по дороге', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    const toc = screen.getByRole('navigation', { name: 'Оглавление' });
    await u.click(itemAt(within(toc).getAllByRole('button'), 1));
    await waitChapter(1);

    // Прыжок с первой на вторую — это одна глава, а не по очереди обе.
    expect(requestedChapters).toEqual([0, 1]);
  });
});

describe('горячие клавиши', () => {
  it('стрелки листают главы', async () => {
    renderReader();
    await waitChapter();

    fireEvent.keyDown(document, { key: 'ArrowRight' });
    await waitChapter(1);

    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await waitChapter(0);
  });

  it('PageDown и PageUp равны стрелкам', async () => {
    renderReader();
    await waitChapter();

    fireEvent.keyDown(document, { key: 'PageDown' });
    await waitChapter(1);

    fireEvent.keyDown(document, { key: 'PageUp' });
    await waitChapter(0);
  });

  it('у краёв книги клавиши ничего не делают', async () => {
    renderReader();
    await waitChapter();

    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    // Глава не сменилась, и страница не уехала: номера вне диапазона игнорируются.
    await waitFor(() => {
      expect(requestedChapters).toEqual([0]);
    });
    expect(within(await waitChapter()).getByText('Глава номер 0')).toBeInTheDocument();
  });

  it('стрелки в поле ввода не листают книгу', async () => {
    /*
      Поле поиска комментариев появится в 7.4.2, но правило действует уже сейчас:
      перехватывать стрелки в поле значило бы двигать текст, который человек
      печатает.
    */
    renderReader();
    await waitChapter();

    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(requestedChapters).toEqual([0]);
    });
    input.remove();
  });

  it('ctrl со стрелкой остаётся системным', async () => {
    renderReader();
    await waitChapter();

    // ctrl+стрелка в большинстве редакторов — «в начало/в конец документа».
    // Перехват ломал бы привычное сочетание.
    fireEvent.keyDown(document, { key: 'ArrowRight', ctrlKey: true });

    await waitFor(() => {
      expect(requestedChapters).toEqual([0]);
    });
  });
});

describe('состояния без текста', () => {
  it('книга без текста объясняет это и предлагает вернуться', async () => {
    book = makeBook({ hasText: false, files: [] });
    renderReader();

    expect(await screen.findByRole('heading', { name: 'Не читается' })).toBeInTheDocument();
    expect(screen.getByText(/только слушать/i)).toBeInTheDocument();
    // Человек, пришедший по ссылке, обязан иметь куда вернуться.
    expect(screen.getByRole('link', { name: 'В комнату' })).toHaveAttribute('href', '/rooms/r1');
  });

  it('неразобранная книга говорит, что её надо загрузить заново', async () => {
    book = makeBook({
      files: [
        {
          kind: 'text',
          format: 'epub',
          fileSize: 1024,
          mimeType: 'application/epub+zip',
          durationSec: null,
          parsed: false,
          url: '/api/books/b1/file?kind=text',
        },
      ],
    });
    renderReader();

    expect(await screen.findByRole('heading', { name: 'Не читается' })).toBeInTheDocument();
    expect(screen.getByText(/загрузите её заново/i)).toBeInTheDocument();
  });

  it('книга без глав не показывает пустую страницу', async () => {
    index = makeIndex(0);
    renderReader();

    expect(await screen.findByRole('heading', { name: 'Не читается' })).toBeInTheDocument();
    expect(screen.getByText(/нет ни одной главы/i)).toBeInTheDocument();
  });

  it('отказ главы показывается текстом', async () => {
    chapters = {};
    renderReader();

    expect(await screen.findByText('Глава')).toBeInTheDocument();
  });
});

describe('позиция в StrictMode', () => {
  /*
    Восстановление позиции сначала было написано прямо в теле рендера, с
    `setChapter` во время рендера. Тесты это пропускали: без StrictMode React
    обрабатывает такое состояние, а с StrictMode — отбрасывает первую попытку
    вместе с обновлением, и книга открывалась с первой главы.

    Ровно этот случай уже ломал страницу входа по коду в 7.2: проверки гонялись
    без StrictMode, поломка жила только в браузере. Здесь обёртка настоящая.
  */
  function renderStrict(): void {
    render(
      <StrictMode>
        <ThemeProvider prefersDark={false}>
          <ToastProvider>
            <MemoryRouter initialEntries={['/rooms/r1/books/b1']}>
              <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: USER })}>
                <Routes>
                  <Route
                    path="/rooms/:roomId/books/:bookId"
                    element={<ReaderPage roomId="r1" bookId="b1" />}
                  />
                  <Route path="/rooms/:roomId" element={<span>Комната</span>} />
                </Routes>
              </AuthProvider>
            </MemoryRouter>
          </ToastProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  }

  it('сохранённая глава восстанавливается и под StrictMode', async () => {
    window.localStorage.setItem(
      positionKey('b1'),
      JSON.stringify({ chapter: 2, block: 1, scrollY: 0, updatedAt: 1 }),
    );

    renderStrict();

    await waitChapter(2);
    expect(requestedChapters).toEqual([2]);
  });

  it('без сохранённой позиции открывается первая глава', async () => {
    renderStrict();

    await waitChapter(0);
    expect(requestedChapters).toEqual([0]);
  });

  it('восстановление не запрашивает лишнюю первую главу', async () => {
    window.localStorage.setItem(
      positionKey('b1'),
      JSON.stringify({ chapter: 1, block: 0, scrollY: 0, updatedAt: 1 }),
    );

    renderStrict();
    await waitChapter(1);

    /*
      Пока не решено, куда возвращаться, грузить нечего. Первая глава здесь была
      бы запрошена, показана и выброшена — на медленной сети человек увидел бы
      лишний переход мимо начала книги.
    */
    expect(requestedChapters).toEqual([1]);
  });
});

/**
 * Подмена раскладки: блоки через `data-block` стоят на высоте `blockTop`,
 * а прокручиваемый блок — высотой `scrollHeight`.
 *
 * Возвращает функцию отката: прототипные свойства восстанавливаются, иначе
 * подмена утекла бы в следующие проверки и сломала бы их неожиданно.
 */
function withLayout(
  el: HTMLElement,
  blockTop: number,
  scrollHeight: number,
): () => void {
  const originals = (['offsetTop', 'scrollHeight'] as const).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
  ] as const);

  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement): number {
      const attr = this.getAttribute('data-block');
      return attr === null ? 0 : Number(attr) * blockTop;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(): number {
      return scrollHeight;
    },
  });

  void el;
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor === undefined) {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      } else {
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      }
    }
  };
}

describe('позиция', () => {
  it('сохранённая глава восстанавливается при открытии', async () => {
    window.localStorage.setItem(
      positionKey('b1'),
      JSON.stringify({ chapter: 2, block: 1, scrollY: 0, updatedAt: 1 }),
    );

    renderReader();

    // Человек возвращается туда, где остановился, а не в начало книги.
    await waitChapter(2);
    expect(requestedChapters).toEqual([2]);
  });

  it('сохранённая глава за пределами книги открывает последнюю', async () => {
    window.localStorage.setItem(
      positionKey('b1'),
      JSON.stringify({ chapter: 99, block: 0, scrollY: 0, updatedAt: 1 }),
    );

    renderReader();

    // Позиция ушла за конец: открывать нечего, и открывать первую главу молча
    // значило бы выглядеть так, будто позиция потерялась.
    await waitChapter(2);
  });

  it('прокрутка возвращается к сохранённому блоку', async () => {
    window.localStorage.setItem(
      positionKey('b1'),
      JSON.stringify({ chapter: 0, block: 2, scrollY: 0, updatedAt: 1 }),
    );

    const restore = withLayout(document.body, 400, 40_000);
    try {
      const { container } = renderReader();
      await waitChapter();

      const host = container.querySelector('.reader__main') as HTMLElement;
      // Прокрутка останавливается у сохранённого блока минус отступ сверху:
      // блок 2 стоит на 2 × 400 = 800, сверху отступ 24.
      expect(host.scrollTop).toBe(800 - 24);
    } finally {
      restore();
    }
  });

  it('сохранённый блок не найден — возвращается к месту экрана', async () => {
    window.localStorage.setItem(
      positionKey('b1'),
      JSON.stringify({ chapter: 0, block: 99, scrollY: 500, updatedAt: 1 }),
    );

    const restore = withLayout(document.body, 400, 40_000);
    try {
      const { container } = renderReader();
      await waitChapter();

      const host = container.querySelector('.reader__main') as HTMLElement;
      /*
        Блок не нашёлся — книгу пересобрали или это был другой абзац. Возврат к
        сохранённому месту экрана ближе, чем в начало главы: человек увидит
        текст рядом с тем, на котором остановился.
      */
      expect(host.scrollTop).toBe(500);
    } finally {
      restore();
    }
  });

  it('битая позиция не мешает открыть книгу', async () => {
    window.localStorage.setItem(positionKey('b1'), 'не json');

    renderReader();

    await waitChapter();
    expect(requestedChapters).toEqual([0]);
  });

  it('позиция пишется и без прокрутки — по смене главы', async () => {
    const u = userEvent.setup();
    renderReader();
    await waitChapter();

    await u.click(screen.getByRole('button', { name: 'Следующая' }));
    await waitChapter(1);

    // Уход со страницы — повод записать немедленно: `pagehide` на телефоне
    // приходит надёжнее, чем таймер.
    fireEvent(window, new Event('pagehide'));

    await waitFor(() => {
      expect(window.localStorage.getItem(positionKey('b1'))).not.toBeNull();
    });

    const saved = JSON.parse(window.localStorage.getItem(positionKey('b1')) as string) as {
      chapter: number;
    };
    /*
      Без этого человек читал бы вторую главу, закрыл вкладку и вернулся в
      начало: прокрутки не было, а позиция знала только о ней.
    */
    expect(saved.chapter).toBe(1);
  });

  it('позиция пишется при прокрутке', async () => {
    renderReader();
    await waitChapter();

    const scroller = document.querySelector('.reader__main') as HTMLElement;
    fireEvent.scroll(scroller);

    // Прокрутка огрубляется таймером: десятки событий превращаются в одну
    // запись. Здесь ждём этого окна, а не проверяем мгновение.
    await waitFor(
      () => {
        expect(window.localStorage.getItem(positionKey('b1'))).not.toBeNull();
      },
      { timeout: 3000 },
    );
  });
});