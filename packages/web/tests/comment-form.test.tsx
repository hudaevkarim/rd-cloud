import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentComposer } from '../src/books/CommentComposer.js';
import { ChapterView } from '../src/books/ChapterView.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import * as wsModule from '../src/ws/client.js';
import { renderChapter } from '@rd/library/render';
import type { XmlNode } from '@rd/library/parse';
import type { ChapterBlock } from '../src/api/types.js';

/**
 * Окно создания комментария.
 *
 * ─── Почему форма проверяется сама по себе ────────────────────────────────────
 *
 * Все проверки этой формы — про то, что человек не потеряет написанное: кнопка
 * выключена на пустом тексте, `Escape` закрывает окно, ошибка остаётся в форме.
 * В полном цикле (отдельный файл) эти же свойства не различить — там важно
 * другое, поэтому смешивать их в одном файле означало бы проверять каждое
 * свойство дважды и ни одно толком.
 */

/** Глава из одного абзаца, к которой и привязывается выделение. */
const PARAGRAPH = 'ветер ветер письмо улица дорога фонарь';

function block(index: number, text: string): ChapterBlock {
  const node: XmlNode = { name: 'p', attrs: {}, children: [{ name: '#text', text, attrs: {}, children: [] }] };
  return { index, kind: 'p', node, text };
}

let host: HTMLElement | null = null;

/**
 * Готовит контейнер главы и сразу рисует в нём абзац.
 *
 * `ChapterView` отрисовывается отдельно и вручную передаётся композитору: в
 * бою контейнер приходит из `onRendered`, и проверка этой связи здесь была бы
 * лишней — она покрыта в тестах читалки.
 */
function renderComposer(): { onCreated: ReturnType<typeof vi.fn> } {
  const holder = document.createElement('div');
  document.body.appendChild(holder);
  holder.appendChild(renderChapter({ blocks: [block(1, PARAGRAPH)] }));
  // Именно контейнер, а не абзац внутри: в бою композитор получает `.chapter`,
  // внутри которого ищутся блоки, и подмена одного другим сдвинула бы проверку
  // с настоящей разметки на искусственную.
  host = holder;

  const onCreated = vi.fn();
  render(
    <ToastProvider>
      <CommentComposer
        host={host}
        chapterIndex={0}
        roomId="r1"
        bookId="b1"
        onCreated={onCreated}
      />
    </ToastProvider>,
  );
  return { onCreated };
}

/** Выделяет фрагмент и нажимает «Комментировать». */
async function openDialog(): Promise<void> {
  const el = host!.querySelector('[data-block="1"]')!;
  const range = document.createRange();
  range.setStart(el.firstChild as Text, 0);
  range.setEnd(el.firstChild as Text, 5);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  el.dispatchEvent(new Event('pointerup', { bubbles: true }));
  await userEvent.click(await screen.findByRole('button', { name: 'Комментировать' }));
}

beforeEach(() => {
  host = null;
  vi.spyOn(wsModule, 'getSocket').mockReturnValue({
    emit: vi.fn(),
    connected: true,
    on: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
  } as never);
});

describe('окно комментария', () => {
  it('открывается с цитатой выделенного', async () => {
    renderComposer();

    await openDialog();

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('ветер')).toBeInTheDocument();
  });

  it('поле пустое, кнопка отправки выключена', async () => {
    renderComposer();

    await openDialog();

    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });

  it('введённый текст включает кнопку', async () => {
    renderComposer();
    await openDialog();

    await userEvent.type(screen.getByLabelText('Комментарий'), 'Интересно');

    expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled();
  });

  it('пробелы не считаются текстом комментария', async () => {
    renderComposer();
    await openDialog();

    await userEvent.type(screen.getByLabelText('Комментарий'), '   ');

    // Сервер обрезает текст и отверг бы пустой остаток; кнопка обязана быть
    // выключена, чтобы человек не отправлял заведомо отвергаемое.
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });

  it('фокус в поле, а не на кнопке закрытия', async () => {
    renderComposer();

    await openDialog();

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Комментарий'));
    });
  });

  it('Ctrl+Enter отправляет', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, text: async () => '' }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { onCreated } = renderComposer();
    await openDialog();

    const textarea = screen.getByLabelText('Комментарий');
    await userEvent.type(textarea, 'Проверка');
    // Модификатор держится между двумя вызовами, поэтому `keyboard`, а не
    // `type` с `{Control>}` внутри строки.
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(onCreated).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Enter без Ctrl переносит строку и ничего не отправляет', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, text: async () => '' }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    renderComposer();
    await openDialog();

    const textarea = screen.getByLabelText('Комментарий') as HTMLTextAreaElement;
    await userEvent.type(textarea, 'первая{Enter}вторая');

    expect(textarea.value).toBe('первая\nвторая');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('Escape закрывает окно', async () => {
    renderComposer();
    await openDialog();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('кнопка «Отмена» закрывает окно', async () => {
    renderComposer();
    await openDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('чекбокс спойлера выключен по умолчанию', async () => {
    renderComposer();
    await openDialog();

    expect(screen.getByRole('checkbox', { name: 'Спойлер' })).not.toBeChecked();
  });

  it('счётчик символов молчит до порога', async () => {
    renderComposer();
    await openDialog();

    await userEvent.type(screen.getByLabelText('Комментарий'), 'Коротко');

    expect(screen.queryByText(/Осталось/)).not.toBeInTheDocument();
    expect(screen.getByText('Ctrl+Enter — отправить')).toBeInTheDocument();
  });

  it('счётчик появляется у порога и считает остаток', async () => {
    renderComposer();
    await openDialog();

    const textarea = screen.getByLabelText('Комментарий');
    // 4499 символов — ещё без счётчика, 4500 — уже с ним.
    await userEvent.click(textarea);
    await userEvent.paste('я'.repeat(4499));
    expect(screen.queryByText(/Осталось/)).not.toBeInTheDocument();

    await userEvent.paste('я');
    expect(screen.getByText('Осталось 500')).toBeInTheDocument();
  });

  it('превышение лимита выключает отправку и объясняет на сколько', async () => {
    renderComposer();
    await openDialog();

    await userEvent.click(screen.getByLabelText('Комментарий'));
    await userEvent.paste('я'.repeat(5001));

    expect(screen.getByText('На 1 длиннее лимита')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });

  it('длинная цитата обрезается с многоточием', async () => {
    const long = 'я'.repeat(400);
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    holder.appendChild(renderChapter({ blocks: [block(1, long)] }));
    host = holder;

    render(
      <ToastProvider>
        <CommentComposer host={host} chapterIndex={0} roomId="r1" bookId="b1" onCreated={vi.fn()} />
      </ToastProvider>,
    );

    const el = host.querySelector('[data-block="1"]')!;
    const range = document.createRange();
    range.setStart(el.firstChild as Text, 0);
    range.setEnd(el.firstChild as Text, 400);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Комментировать' }));

    const quote = screen.getByText(/…$/);
    expect(quote.textContent).toHaveLength(201);
    expect(quote.textContent?.endsWith('я…')).toBe(true);
  });
});

describe('кнопка у выделения', () => {
  it('не появляется без выделения', async () => {
    renderComposer();

    expect(screen.queryByRole('button', { name: 'Комментировать' })).not.toBeInTheDocument();
  });

  it('появляется после выделения и снимается после снятия', async () => {
    renderComposer();
    const el = host!.querySelector('[data-block="1"]')!;
    const text = el.firstChild as Text;

    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new Event('pointerup', { bubbles: true }));

    expect(await screen.findByRole('button', { name: 'Комментировать' })).toBeInTheDocument();

    // Выделение схлопнулось — человек просто ткнул в текст.
    selection.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Комментировать' })).not.toBeInTheDocument();
    });
  });

  it('выделение через два абзаца объясняет причину и кнопки не даёт', async () => {
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    holder.appendChild(
      renderChapter({ blocks: [block(1, PARAGRAPH), block(2, 'второй абзац')] }),
    );
    host = holder;

    render(
      <ToastProvider>
        <CommentComposer host={host} chapterIndex={0} roomId="r1" bookId="b1" onCreated={vi.fn()} />
      </ToastProvider>,
    );

    const els = host.querySelectorAll('[data-block]');
    const range = document.createRange();
    range.setStart(els[0]!.firstChild as Text, 0);
    range.setEnd(els[1]!.firstChild as Text, 3);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    els[0]!.dispatchEvent(new Event('pointerup', { bubbles: true }));

    expect(await screen.findByText('Выделите фрагмент внутри одного абзаца')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Комментировать' })).not.toBeInTheDocument();
  });

  it('на тач-устройстве кнопки нет', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    renderComposer();

    const el = host!.querySelector('[data-block="1"]')!;
    const range = document.createRange();
    range.setStart(el.firstChild as Text, 0);
    range.setEnd(el.firstChild as Text, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new Event('pointerup', { bubbles: true }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Комментировать' })).not.toBeInTheDocument();
    });
    vi.restoreAllMocks();
  });
});

