import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AdminCatalogPage } from '../src/pages/AdminCatalog.js';
import { AuthProvider } from '../src/auth/AuthContext.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import { jsonResponse } from './setup.js';
import type { BookSummary, CurrentUser } from '../src/api/types.js';

/**
 * Админский каталог: форма пополнения и уборка.
 *
 * Главное здесь — «хотя бы один файл». Форма принимает книгу с одним файлом из
 * двух, но не с нулём: книга, у которой нечего ни читать, ни слушать, попала бы в
 * каталог и осталась бы там навсегда, потому что чинить её пришлось бы админу
 * вручную. Проверка должна сработать до отправки — иначе человек увидит отказ
 * сервера после того, как уже нажал кнопку.
 */

const ADMIN: CurrentUser = { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null, role: 'admin' };

let catalog: BookSummary[] = [];
let calls: string[] = [];
/** Ответ `removeFromCatalog` для следующего убирания. */
let removeResult = { deleted: true };

function book(over: Partial<BookSummary> = {}): BookSummary {
  return {
    id: 'b1',
    title: 'Евгений Онегин',
    author: 'А. С. Пушкин',
    description: null,
    authorBio: null,
    coverUrl: null,
    isCatalog: true,
    language: 'ru',
    year: 1825,
    uploadedById: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    hasText: true,
    hasAudio: false,
    files: [],
    ...over,
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

/**
 * Подставной `XMLHttpRequest`.
 *
 * Форма каталога ходит через XHR, потому что там тоже видно прогресс. Здесь
 * прогресс не проверяется — он проверяется в `upload-xhr.test.ts`, а в тесте
 * формы важно, уйдёт запрос или останется на кнопке.
 */
type Listener = () => void;

class StubXhr {
  static last: StubXhr | null = null;

  url = '';
  body: FormData | null = null;
  aborted = false;
  status = 201;
  responseText = '{"book":{"id":"b1"}}';

  readonly upload = { addEventListener: (_type: string, fn: Listener) => this.#upload.push(fn) };
  readonly #upload: Listener[] = [];
  readonly #own = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener): void {
    this.#own.set(type, [...(this.#own.get(type) ?? []), fn]);
  }

  setRequestHeader(): void {
    /* заголовки проверяются в upload-xhr.test.ts */
  }

  open(_method: string, url: string): void {
    this.url = url;
  }

  send(body: FormData): void {
    this.body = body;
    StubXhr.last = this;
  }

  abort(): void {
    this.aborted = true;
    this.#fire('abort');
  }

  getResponseHeader(): string | null {
    return 'application/json';
  }

  respond(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.#fire('load');
  }

  #fire(type: string): void {
    for (const fn of this.#own.get(type) ?? []) fn();
  }
}

beforeEach(() => {
  calls = [];
  removeResult = { deleted: true };
  catalog = [book()];
  StubXhr.last = null;
  setToken('токен');
  vi.stubGlobal('XMLHttpRequest', StubXhr as unknown as typeof XMLHttpRequest);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (url.startsWith('/api/catalog')) return jsonResponse({ books: catalog });
      if (url.startsWith('/api/admin/catalog/') && method === 'DELETE') return jsonResponse(removeResult);
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setToken(null);
});

function renderPage(): void {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <AuthProvider storage={storage()} fetchMe={vi.fn().mockResolvedValue({ user: ADMIN })}>
            <AdminCatalogPage />
          </AuthProvider>
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

/** Открыть форму и дождаться её появления. */
async function openForm(u: ReturnType<typeof userEvent.setup>): Promise<void> {
  await u.click(screen.getByRole('button', { name: 'Добавить книгу в каталог' }));
  await screen.findByRole('dialog', { name: 'Добавить книгу в каталог' });
}

/** Файл нужного имени и размера. Размер — свойством, чтобы не есть память. */
function fileOf(name: string, size = 1024): File {
  const file = new File(['данные'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/**
 * Выбрать файл в конкретном поле.
 *
 * `fireEvent.change`, а не `userEvent.upload`: тот отбрасывает файл, не
 * совпадающий с `accept`, — а несовпадение с видом поля здесь и проверяется.
 */
function pick(fieldLabel: string, name: string, size = 1024): void {
  const field = screen.getByText(fieldLabel).closest('.field') as HTMLElement;
  const input = field.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fileOf(name, size)] } });
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('список', () => {
  it('показывает книги с бейджами', async () => {
    catalog = [book(), book({ id: 'b2', title: 'Пиковая дама', hasAudio: true, hasText: false })];
    renderPage();

    expect(await screen.findByText('Евгений Онегин')).toBeInTheDocument();
    expect(screen.getAllByText('Аудио')).toHaveLength(1);
  });

  it('пустой каталог объясняет, кто его наполняет', async () => {
    catalog = [];
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Каталог пуст' })).toBeInTheDocument();
    expect(screen.getByText(/не загружая файл к себе/i)).toBeInTheDocument();
  });

  it('убирание спрашивает подтверждение и говорит, что будет', async () => {
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('Евгений Онегин');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await u.click(screen.getByRole('button', { name: 'Убрать' }));

    // Подтверждение обязательно: книга, которой нет ни в одной комнате, уходит
    // вместе с файлами, и отменить это нечем.
    expect(confirm).toHaveBeenCalled();
    expect(confirm.mock.calls[0]?.[0]).toContain('Евгений Онегин');
    await waitFor(() => {
      expect(calls).toContain('DELETE /api/admin/catalog/b1');
    });
  });

  it('отказ от подтверждения ничего не удаляет', async () => {
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('Евгений Онегин');

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await u.click(screen.getByRole('button', { name: 'Убрать' }));

    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('разница между «удалена» и «осталась в комнатах» не теряется', async () => {
    removeResult = { deleted: false };
    const u = userEvent.setup();
    renderPage();
    await screen.findByText('Евгений Онегин');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await u.click(screen.getByRole('button', { name: 'Убрать' }));

    /*
      «Книга удалена» при `deleted: false` было бы неправдой: файлы лежат в
      комнатах, и человек потом не найдёт, откуда они взялись.
    */
    expect(await screen.findByText(/в комнатах она осталась/i)).toBeInTheDocument();
  });
});

describe('форма: хотя бы один файл', () => {
  it('без файлов кнопка не активна', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    // Кнопка заблокирована, а не «нажми и увиди ошибку»: оба файла необязательны,
    // но хотя бы один обязателен, и человек должен понять это до отправки.
    expect(screen.getByRole('button', { name: 'Добавить в каталог' })).toBeDisabled();
  });

  it('одного файла достаточно', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Книга.epub');

    // Аудио можно не присылать: книга с одним файлом — это книга с одним файлом.
    expect(screen.getByRole('button', { name: 'Добавить в каталог' })).toBeEnabled();
  });

  it('убранный файл снова закрывает кнопку', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Книга.epub');
    expect(screen.getByRole('button', { name: 'Добавить в каталог' })).toBeEnabled();

    await u.click(screen.getByRole('button', { name: 'Убрать файл' }));

    expect(screen.getByRole('button', { name: 'Добавить в каталог' })).toBeDisabled();
  });

  it('и текст, и аудио, и обложка уходят одним запросом', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Книга.epub');
    pick('Аудио (необязательно)', 'Книга.mp3');
    pick('Обложка (необязательно)', 'обложка.jpg');
    fill('Автор', 'А. С. Пушкин');

    await u.click(screen.getByRole('button', { name: 'Добавить в каталог' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    const xhr = StubXhr.last as StubXhr;
    const form = xhr.body as FormData;
    expect(form.get('text')).toBeInstanceOf(File);
    expect(form.get('audio')).toBeInstanceOf(File);
    expect(form.get('cover')).toBeInstanceOf(File);
    expect(form.get('title')).toBe('Книга');
    expect(form.get('author')).toBe('А. С. Пушкин');
    /*
      Обложка едет в том же запросе. Отдельным маршрутом она была бы вторым
      шагом, и после первого шага на диске осталась бы книга без обложки — то
      есть промежуточный результат, который никто не заказывал.
    */
    expect(xhr.url).toBe('/api/admin/catalog');
  });

  it('одного аудио достаточно', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Аудио (необязательно)', 'Книга.mp3');
    fill('Автор', 'Автор');

    await u.click(screen.getByRole('button', { name: 'Добавить в каталог' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    const form = (StubXhr.last as StubXhr).body as FormData;
    expect(form.get('audio')).toBeInstanceOf(File);
    // Пустые поля не отправляются: серверу незачем отличать «не прислали» от
    // «прислали пустое», а пустая строка в описании — это опечатка человека.
    expect(form.get('text')).toBeNull();
  });
});

describe('форма: подходящие файлы по полям', () => {
  it('текст в поле аудио отклоняется', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Аудио (необязательно)', 'Книга.epub');

    /*
      Сервер принял бы книгу с аудио, которого нет: имя поля «audio» для него
      значит «это аудиофайл». Отказ здесь экономит админу книгу-призрак.
    */
    expect(await screen.findByRole('alert')).toHaveTextContent('Это текстовый файл');
    expect(screen.getByRole('button', { name: 'Добавить в каталог' })).toBeDisabled();
  });

  it('аудио в поле текста отклоняется', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Книга.mp3');

    expect(await screen.findByRole('alert')).toHaveTextContent('Это аудиофайл');
  });

  it('чужой формат отклоняется с подсказкой', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Заметки.docx');

    const alert = await screen.findByRole('alert');
    // Подсказка называет нужные расширения, а не «неверный файл»: человек не
    // обязан знать, что именно принимает проект.
    expect(alert).toHaveTextContent('.epub');
    expect(alert).toHaveTextContent('.fb2');
    expect(alert).toHaveTextContent('.pdf');
  });

  it('обложка проверяется отдельно от книжных файлов', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Обложка (необязательно)', 'обложка.heic');

    // HEIC не принимается: браузеры его не показывают, и книга с такой обложкой
    // выглядела бы как книга без обложки — молча и навсегда. Отказ называет
    // допустимые форматы и объясняет причину, а не просто «неверный файл».
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Обложка/);
    expect(alert).toHaveTextContent('.jpg');
    expect(alert).toHaveTextContent('браузеры могут не показать');
  });

  it('слишком большой файл отклоняется до отправки', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Большая.epub', 51 * 1_024 * 1_024);

    const alert = await screen.findByRole('alert');
    // Оба числа: «слишком большой» без чисел не скажет, насколько уменьшить.
    expect(alert).toHaveTextContent('50 МБ');
    expect(alert).toHaveTextContent('51 МБ');
    expect(screen.getByRole('button', { name: 'Добавить в каталог' })).toBeDisabled();
    expect(StubXhr.last).toBeNull();
  });
});

describe('форма: отправка', () => {
  it('без названия и автора объясняет, что заполнить', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Аудио (необязательно)', 'Книга.mp3');
    await u.click(screen.getByRole('button', { name: 'Добавить в каталог' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Нужны название и автор.');
    // Запроса не было: сервер всё равно отказал бы, а человек узнал бы об этом
    // после отправки.
    expect(StubXhr.last).toBeNull();
  });

  it('название предзаполняется из имени файла', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Евгений_Онегин.epub');

    await waitFor(() => {
      expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Евгений Онегин');
    });
  });

  it('успех перечитывает список', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);
    await screen.findByText('Евгений Онегин');

    pick('Текст (необязательно)', 'Книга.epub');
    fill('Автор', 'Автор');
    await u.click(screen.getByRole('button', { name: 'Добавить в каталог' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    catalog = [book(), book({ id: 'b2', title: 'Новая книга' })];
    (StubXhr.last as StubXhr).respond(201, '{"book":{"id":"b2"}}');

    expect(await screen.findByText('Новая книга')).toBeInTheDocument();
    // Форма закрыта: после успеха незачем держать открытой уже отправленное.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Добавить книгу в каталог' })).not.toBeInTheDocument();
    });
  });

  it('отказ сервера показывается текстом', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Книга.epub');
    fill('Автор', 'Автор');
    await u.click(screen.getByRole('button', { name: 'Добавить в каталог' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    (StubXhr.last as StubXhr).respond(
      400,
      JSON.stringify({ error: { code: 'no_files', message: 'Нужен хотя бы один файл' } }),
    );

    // Текст с сервера, а не «Ошибка 400»: конкретное сообщение сразу объясняет,
    // что делать.
    expect(await screen.findByRole('alert')).toHaveTextContent('Нужен хотя бы один файл');
    // Форма осталась открытой с выбранными файлами: перезаполнять заново после
    // отказа не нужно.
    expect(screen.getByRole('dialog', { name: 'Добавить книгу в каталог' })).toBeInTheDocument();
  });

  it('отмена рвёт запрос, форма остаётся чистой', async () => {
    const u = userEvent.setup();
    renderPage();
    await openForm(u);

    pick('Текст (необязательно)', 'Книга.epub');
    fill('Автор', 'Автор');
    await u.click(screen.getByRole('button', { name: 'Добавить в каталог' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    await u.click(screen.getByRole('button', { name: 'Отменить загрузку' }));

    // Отмена — решение человека, а не сбой: сообщения об ошибке здесь не было бы,
    // и человек решил бы, что что-то сломалось.
    expect((StubXhr.last as StubXhr).aborted).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    /*
      Окно остаётся открытым, а поля очищаются — так же, как в форме загрузки в
      комнату. Закрывать окно было бы хуже: человеку после отмены на два гигабайта
      пришлось бы снова открывать форму и заново выбирать файлы.
    */
    expect(screen.getByRole('dialog', { name: 'Добавить книгу в каталог' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Добавить в каталог' })).toBeDisabled();
    });
  });
});