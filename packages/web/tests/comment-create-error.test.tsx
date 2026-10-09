import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentComposer } from '../src/books/CommentComposer.js';
import { ChapterView } from '../src/books/ChapterView.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { setToken } from '../src/api/client.js';
import { renderChapter } from '@rd/library/render';
import * as wsModule from '../src/ws/client.js';
import type { XmlNode } from '@rd/library/parse';
import type { ChapterBlock, WireComment } from '../src/api/types.js';

/**
 * Отказ при отправке комментария.
 *
 * ─── Главное правило этого файла ───────────────────────────────────────────────
 *
 * Окно не закрывается, а написанный текст остаётся на месте.
 *
 * Это не «хороший тон», а требование к поведению: человек пишет мысль, отправляет
 * и, вместо результата, видит пустое окно — мысль потеряна, и писать заново
 * лень. Проверяется именно текст в поле после отказа, потому что форма может
 * остаться открытой и при этом обнулиться — и выглядеть это будет правильно.
 */

const PARAGRAPH = 'ветер ветер письмо улица дорога фонарь страница письмо';

function block(index: number, text: string): ChapterBlock {
  const node: XmlNode = { name: 'p', attrs: {}, children: [{ name: '#text', text, attrs: {}, children: [] }] };
  return { index, kind: 'p', node, text };
}

let host: HTMLElement | null = null;
/** Ответ сервера на POST: `null` — сеть отвалилась и ответа нет вовсе. */
let postReply: (() => Response) | null;

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/comments') && init?.method === 'POST') {
      if (postReply === null) throw new TypeError('Failed to fetch');
      return postReply();
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({}) } as Response;
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderComposer(): { onCreated: ReturnType<typeof vi.fn> } {
  const holder = document.createElement('div');
  document.body.appendChild(holder);
  holder.appendChild(renderChapter({ blocks: [block(1, PARAGRAPH)] }));
  host = holder;

  const onCreated = vi.fn();
  render(
    <ToastProvider>
      <CommentComposer host={host} chapterIndex={0} roomId="r1" bookId="b1" onCreated={onCreated} />
    </ToastProvider>,
  );
  return { onCreated };
}

/** Выделяет фрагмент, открывает окно и пишет текст. */
async function openWithText(text: string): Promise<void> {
  const el = host!.querySelector('[data-block="1"]')!;
  const range = document.createRange();
  range.setStart(el.firstChild as Text, 0);
  range.setEnd(el.firstChild as Text, 5);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  el.dispatchEvent(new Event('pointerup', { bubbles: true }));
  await userEvent.click(await screen.findByRole('button', { name: 'Комментировать' }));
  await userEvent.type(screen.getByLabelText('Комментарий'), text);
}

function errorBody(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

beforeEach(() => {
  host = null;
  postReply = null;
  stubFetch();
  setToken('токен');
  vi.spyOn(wsModule, 'getSocket').mockReturnValue({
    emit: vi.fn(),
    connected: true,
    on: () => undefined,
    off: () => undefined,
    removeAllListeners: () => undefined,
  } as never);
});

describe('отказ при отправке', () => {
  it('400: окно остаётся, текст на месте, сообщение понятное', async () => {
    postReply = () =>
      ({
        ok: false,
        status: 400,
        text: async () => errorBody('bad_request', 'Якорь неверен: anchor.end: Должно быть позже начала'),
      }) as Response;

    const { onCreated } = renderComposer();
    await openWithText('Мысль, которая не должна пропасть');

    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Комментарий')).toHaveValue('Мысль, которая не должна пропасть');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('403: сказано про участие в комнате, а не про текст', async () => {
    /*
      403 не про текст комментария и повтором не лечится: человек не участник
      комнаты. Сообщение про «попробуйте ещё раз» отправило бы его в бессмысленный
      цикл, поэтому здесь ровно то, что он может сделать: понять, что дело не в
      формулировке.
    */
    postReply = () =>
      ({
        ok: false,
        status: 403,
        text: async () => errorBody('forbidden', 'Комментарии доступны только участникам комнаты'),
      }) as Response;

    renderComposer();
    await openWithText('Реакция');

    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByText('Вы не участник комнаты.')).toBeInTheDocument();
    expect(screen.getByLabelText('Комментарий')).toHaveValue('Реакция');
  });

  it('500: сервер упал, текст сохранён, повтор возможен', async () => {
    let attempts = 0;
    postReply = () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 500,
          text: async () => errorBody('internal', 'Что-то пошло не так'),
        } as Response;
      }
      const comment: WireComment = {
        id: 'c1',
        bookFileKind: 'text',
        text: 'Реакция',
        anchor: { kind: 'text', chapterIndex: 0, blockIndex: 1, start: 0, end: 5, quote: 'ветер' },
        anchorType: 'text',
        isSpoiler: false,
        isResolved: false,
        parentId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        editedAt: null,
        author: { id: 'u1', username: 'anya', displayName: 'Аня', avatar: null },
        reactions: [],
      };
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ comment }),
      } as Response;
    };

    const { onCreated } = renderComposer();
    await openWithText('Реакция');

    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByRole('alert');

    // Второе нажатие — без правки текста: человек повторяет, а не переписывает.
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('обрыв сети: не ошибка сервера, а понятное объяснение', async () => {
    postReply = null;

    renderComposer();
    await openWithText('Останется тут');

    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(
      await screen.findByText('Комментарий не отправлен. Проверьте соединение и попробуйте ещё раз.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Комментарий')).toHaveValue('Останется тут');
  });

  it('502 без тела ошибки: не «Запрос не удался: 502»', async () => {
    /*
      Наблюдалось в живом браузере: при упавшем бэкенде прокси Vite отвечает
      своим ответом без `error`, и человек читал «Запрос не удался: 502». Это
      правда о прокси и бесполезно о человеке — он не может ни понять, ни
      исправить. Текст должен звучать как то, что он может сделать.
    */
    postReply = () =>
      ({
        ok: false,
        status: 502,
        // Как отвечает прокси: HTML или пусто, без тела ошибки приложения.
        text: async () => '<html>502 Bad Gateway</html>',
      }) as Response;

    renderComposer();
    await openWithText('Не дойдёт');

    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(
      await screen.findByText('Комментарий не отправлен. Проверьте соединение и попробуйте ещё раз.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Комментарий')).toHaveValue('Не дойдёт');
  });

  it('после отказа отправка снова доступна', async () => {
    postReply = () =>
      ({ ok: false, status: 500, text: async () => errorBody('internal', 'Ошибка') }) as Response;

    renderComposer();
    await openWithText('Попробую ещё');

    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByRole('alert');

    // Кнопка не залипает в «занято»: запрос кончился, а не продолжается.
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled();
  });

  it('Escape после отказа закрывает окно', async () => {
    /*
      Отказ не должен превращать окно в ловушку: человек, передумавший, должен
      уйти обычным способом, а не искать, чем обойти неработающую отправку.
    */
    postReply = () =>
      ({ ok: false, status: 500, text: async () => errorBody('internal', 'Ошибка') }) as Response;

    renderComposer();
    await openWithText('Передумал');

    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByRole('alert');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('якорь из выделения уходит в том виде, в каком проверен', async () => {
    const fetchMock = stubFetch();
    renderComposer();
    await openWithText('Проверка');

    // Клиентская проверка якоря — та же функция, что на сервере. Здесь она
    // проходит: настоящий отказ проверяется саботажем подмены ответа.
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter((c) => c[1] !== undefined && String(c[0]).includes('/comments'));
      expect(posts.length).toBeGreaterThan(0);
    });
    const post = fetchMock.mock.calls.find((c) => c[1] !== undefined && String(c[0]).includes('/comments'))!;
    const body = JSON.parse(String((post[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body['anchor']).toMatchObject({ kind: 'text', chapterIndex: 0, blockIndex: 1, start: 0, end: 5 });
  });
});

describe('самостоятельный компонент главы в отказе', () => {
  it('маркеры не накладываются, пока комментарий не создан', async () => {
    /*
      Связка страницы: `ChapterView` получает комментарии от родителя, а не от
      формы. Пока отправка не дошла до родителя, маркера в тексте быть не
      должно — иначе человек увидел бы пометку на месте, где комментария нет.
    */
    postReply = () =>
      ({ ok: false, status: 500, text: async () => errorBody('internal', 'Ошибка') }) as Response;

    const holder = document.createElement('div');
    document.body.appendChild(holder);
    holder.appendChild(renderChapter({ blocks: [block(1, PARAGRAPH)] }));

    render(
      <ToastProvider>
        <ChapterView blocks={[block(1, PARAGRAPH)]} chapterIndex={0} comments={[]} />
        <CommentComposer host={holder} chapterIndex={0} roomId="r1" bookId="b1" onCreated={vi.fn()} />
      </ToastProvider>,
    );

    const el = holder.querySelector('[data-block="1"]')!;
    const range = document.createRange();
    range.setStart(el.firstChild as Text, 0);
    range.setEnd(el.firstChild as Text, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new Event('pointerup', { bubbles: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Комментировать' }));
    await userEvent.type(screen.getByLabelText('Комментарий'), 'Не отправится');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByRole('alert');

    expect(document.querySelector('mark.rd-comment-marker')).toBeNull();
  });
});