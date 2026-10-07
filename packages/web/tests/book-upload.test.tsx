import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BookUploadDialog } from '../src/books/BookUploadDialog.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import { TEXT_LIMIT_BYTES } from '../src/books/file-kind.js';

/**
 * Форма загрузки книги в комнату.
 *
 * Здесь проверяется ровно то, что человек видит до отправки: отказ на
 * неподдерживаемый файл, на слишком большой и на пустую форму. Всё это дешевле
 * минуты загрузки, и именно ради этого проверки вынесены наверх.
 *
 * Определение формата и лимиты проверяются отдельно, в `file-kind.test.ts`.
 * Здесь важна реакция формы.
 */

type Listener = () => void;

/**
 * Подставной `XMLHttpRequest`.
 *
 * Слушатели регистрируются по имени события и срабатывают по вызову из проверки
 * — иначе промис загрузки никогда не разрешился бы, и проверки ждали бы впустую.
 */
class StubXhr {
  static last: StubXhr | null = null;

  url = '';
  body: FormData | null = null;
  aborted = false;
  status = 201;
  responseText = '{"book":{"id":"b1","title":"Книга"}}';

  /*
    Списки раздельные: обработчики `xhr.upload` не должны вызываться при отмене
    самого запроса. Общий список означал бы вызов обработчика прогресса без
    события — и падение на `lengthComputable`.
  */
  readonly upload = {
    addEventListener: (_type: string, fn: Listener) => this.#upload.push(fn),
  };
  readonly #upload: Listener[] = [];
  readonly #own = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener): void {
    this.#own.set(type, [...(this.#own.get(type) ?? []), fn]);
  }

  #fire(type: string): void {
    for (const fn of this.#own.get(type) ?? []) fn();
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
    // Отмена должна выглядеть для формы как отмена, а не как падение: иначе
    // на экране появилось бы сообщение об ошибке после того, как человек сам
    // остановил загрузку.
    this.#fire('abort');
  }

  getResponseHeader(): string | null {
    return 'application/json';
  }

  /** Ответ сервера. */
  respond(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.#fire('load');
  }
}

beforeEach(() => {
  StubXhr.last = null;
  setToken('токен');
  vi.stubGlobal('XMLHttpRequest', StubXhr as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

function renderDialog(onUploaded = vi.fn()) {
  render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter>
          <BookUploadDialog roomId="r1" open onClose={vi.fn()} onUploaded={onUploaded} />
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
  return onUploaded;
}

/**
 * Файл нужного имени и размера.
 *
 * Размер задаётся свойством, а не массивом байтов: проверка границы лимита в
 * 51 МБ не должна съедать 51 мегабайт памяти на каждый прогон.
 */
function fileOf(name: string, size: number): File {
  const file = new File(['данные'], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

/**
 * Выбрать файл.
 *
 * `fireEvent.change`, а не `userEvent.upload`: тот отбрасывает файл, не
 * совпадающий с `accept`, — а именно несовпадение здесь и проверяется. Плюс он
 * пересоздаёт `FileList` из настоящего файла и терял бы подделанный размер.
 */
function pickFile(name: string, size = 1024): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fileOf(name, size)] } });
}

/** Вписать значение в поле. */
function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('выбор файла', () => {
  it('поддержанный файл принимается и показывает размер', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Евгений Онегин.epub', 2048);

    expect(await screen.findByText('Евгений Онегин.epub')).toBeInTheDocument();
    // Размер виден сразу: человек должен понять объём до отправки.
    expect(screen.getByText(/2 КБ/)).toBeInTheDocument();
    expect(screen.getByText(/текст/)).toBeInTheDocument();
  });

  it('название предзаполняется из имени файла', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Евгений_Онегин.epub');

    await waitFor(() => {
      expect((screen.getByLabelText('Название') as HTMLInputElement).value).toBe('Евгений Онегин');
  });
  });

  it('неподдерживаемый формат отклоняется до отправки', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Заметки.docx');

    // Отказ под зоной, а не тост: он относится к выбору файла и должен остаться
    // на месте, пока человек не выберет другой.
    expect(await screen.findByRole('alert')).toHaveTextContent(/\.epub/);
    // И кнопка загрузки заблокирована: отправлять нечего.
    expect(screen.getByRole('button', { name: 'Загрузить' })).toBeDisabled();
  });

  it('слишком большой текст отклоняется с обоими числами', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Большая.epub', 51 * 1_024 * 1_024);

    const alert = await screen.findByRole('alert');
    // Человек должен видеть и лимит, и размер своего файла: «слишком большой»
    // без чисел не скажет, насколько уменьшить.
    expect(alert).toHaveTextContent('50 МБ');
    expect(alert).toHaveTextContent('51 МБ');
    expect(screen.getByRole('button', { name: 'Загрузить' })).toBeDisabled();
  });

  it('файл ровно в лимит принимается', async () => {
    const user = userEvent.setup();
    renderDialog();
    // Строгое «больше», а не «не меньше»: файл ровно в 50 МБ сервер берёт, и
    // отказ здесь означал бы расхождение с сервером.
    pickFile('Ровно.epub', TEXT_LIMIT_BYTES);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('аудио показывает свой лимит', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Голос.mp3');

    expect(await screen.findByText(/аудио/)).toBeInTheDocument();
    // Два гигабайта, а не пятьдесят мегабайт: лимит зависит от вида файла, и
    // показывать чужой значило бы отговаривать человека от нормального файла.
    // Лимит есть и в подписи под файлом, и в подсказке внизу формы, — поэтому
    // ищем все вхождения, а не первое: иначе проверка зависела бы от того, какая
    // из двух подписей отрисовалась первой.
    expect(screen.getAllByText(/2 ГБ/).length).toBeGreaterThan(0);
  });
});

describe('отправка', () => {
  it('без названия и автора объясняет, что заполнить', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Книга.epub');
    fill('Название', '');

    await user.click(screen.getByRole('button', { name: 'Загрузить' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/название и автор/i);
    // Запроса не было: без названия сервер всё равно откажет, а человек узнал бы
    // об этом только после отправки.
    expect(StubXhr.last).toBeNull();
  });

  it('тело запроса собрано правильно', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Книга.epub');

    fill('Автор', 'А. С. Пушкин');
    await user.click(screen.getByRole('button', { name: 'Загрузить' }));

    await waitFor(() => expect(StubXhr.last).not.toBeNull());
    const xhr = StubXhr.last as StubXhr;
    // Порядок обязателен: сервер читает multipart одним проходом и узнаёт `kind`
    // только из полей, пришедших раньше файла.
    const names = [...(xhr.body as FormData).keys()];
    expect(names.indexOf('kind')).toBeLessThan(names.indexOf('file'));
    expect(xhr.body?.get('kind')).toBe('text');
    expect(xhr.body?.get('format')).toBe('epub');
    expect(xhr.body?.get('author')).toBe('А. С. Пушкин');
    expect(xhr.url).toBe('/api/rooms/r1/books/upload');
  });

  it('успех зовёт onUploaded', async () => {
    const user = userEvent.setup();
    const onUploaded = renderDialog();
    pickFile('Книга.epub');
    fill('Автор', 'Автор');

    await user.click(screen.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    (StubXhr.last as StubXhr).respond(201, '{"book":{"id":"b1","title":"Книга"}}');
    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
  });

  it('отказ сервера показывается текстом, а не кодом', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Книга.epub');
    fill('Автор', 'Автор');
    await user.click(screen.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    (StubXhr.last as StubXhr).respond(
      400,
      JSON.stringify({ error: { code: 'field_order', message: 'Файл должен идти после полей' } }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Файл должен идти после полей');
  });
});

describe('отмена', () => {
  it('кнопка «Отменить загрузку» рвёт запрос', async () => {
    const user = userEvent.setup();
    renderDialog();
    pickFile('Книга.epub');
    fill('Автор', 'Автор');
    await user.click(screen.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    await user.click(screen.getByRole('button', { name: 'Отменить загрузку' }));

    expect((StubXhr.last as StubXhr).aborted).toBe(true);
  });

  it('после отмены форма чиста, а не в состоянии ошибки', async () => {
    const user = userEvent.setup();
    const onUploaded = renderDialog();
    pickFile('Книга.epub');
    fill('Автор', 'Автор');
    await user.click(screen.getByRole('button', { name: 'Загрузить' }));
    await waitFor(() => expect(StubXhr.last).not.toBeNull());

    await user.click(screen.getByRole('button', { name: 'Отменить загрузку' }));

    /*
      Отмена — решение человека, а не сбой. Сообщение об ошибке здесь было бы
      враньём: человек ничего не испортил и не стал бы искать причину.
    */
    await waitFor(() => expect(screen.getByText(/Перетащите файл/)).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});