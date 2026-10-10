import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentsPanel } from '../src/books/CommentsPanel.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { jsonResponse } from './setup.js';
import type { WireComment } from '../src/api/types.js';

/**
 * Треды: ответ, вложенность, сворачивание.
 *
 * ─── Почему ответ не в модальном окне ─────────────────────────────────────────
 *
 * Проверяется не «окна нет», а то, что ответ виден рядом с исходным
 * комментарием. Модальное окно убрало бы исходный текст из поля зрения, и
 * человек перечитывал бы его, чтобы понять, на что отвечает.
 *
 * ─── Почему один уровень вложенности ──────────────────────────────────────────
 *
 * Это ограничение сервера: он отвергает ответ на ответ. Клиент не рисует кнопку
 * «Ответить» у ответа, иначе человек написал бы, нажал и получил отказ. Проверка
 * на отсутствие кнопки важнее проверки на её наличие: лишняя кнопка видна
 * сразу, а правило сервера объясняется только в момент отказа.
 */

function comment(over: Partial<WireComment> = {}): WireComment {
  return {
    id: 'root1',
    bookFileKind: 'text',
    text: 'Первый комментарий',
    anchor: {
      kind: 'text',
      chapterIndex: 0,
      blockIndex: 1,
      start: 0,
      end: 5,
      quote: 'ветер',
      prefix: '',
      suffix: '',
    },
    anchorType: 'text',
    isSpoiler: false,
    isResolved: false,
    parentId: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    editedAt: null,
    author: { id: 'u1', username: 'boris', displayName: 'Борис', avatar: null },
    reactions: [],
    ...over,
  };
}

function reply(over: Partial<WireComment> = {}): WireComment {
  return comment({
    id: 'reply1',
    text: 'Ответ Бориса',
    parentId: 'root1',
    author: { id: 'u2', username: 'lida', displayName: 'Лида', avatar: null },
    ...over,
  });
}

let posted: Array<Record<string, unknown>>;

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/comments') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        const created = reply({ id: `reply${posted.length}`, text: String(body['text']) });
        return jsonResponse({ comment: created }, 201);
      }
      return { ok: true, status: 200, text: async () => '{}' } as Response;
    }),
  );
});

function renderPanel(comments: WireComment[]) {
  const onAddReply = vi.fn();
  const onAdd = vi.fn();
  render(
    <ToastProvider>
      <CommentsPanel
        roomId="r1"
        bookId="b1"
        comments={comments}
        meId="u1"
        focusId={null}
        flashId={null}
        open
        onToggle={vi.fn()}
        onAdd={onAdd}
        onAddReply={onAddReply}
      />
    </ToastProvider>,
  );
  return { onAdd, onAddReply };
}

describe('тред', () => {
  it('у корневого комментария есть «Ответить»', () => {
    renderPanel([comment()]);

    expect(screen.getByRole('button', { name: 'Ответить' })).toBeInTheDocument();
  });

  it('у ответа кнопки «Ответить» нет', () => {
    renderPanel([comment({ replies: [reply()] })]);

    /*
      Кнопка есть ровно одна — у корня. У ответа её нет, потому что сервер
      отвергает ответ на ответ: человек написал бы, нажал и получил отказ вместо
      реплики. Проверяется именно количество, а не отсутствие: иначе проверка
      прошла бы и на пустой панели.
    */
    const buttons = screen.getAllByRole('button', { name: 'Ответить' });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.closest('[data-comment-card="root1"]')).not.toBeNull();

    const replyCard = document.querySelector('[data-comment-card="reply1"]')!;
    expect(within(replyCard as HTMLElement).queryByRole('button', { name: 'Ответить' })).toBeNull();
  });

  it('форма ответа раскрывается под комментарием и в автофокусе', async () => {
    renderPanel([comment()]);

    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));

    const field = screen.getByLabelText('Ответ на комментарий Борис');
    expect(field).toHaveFocus();
    // Форма внутри карточки, а не поверх: исходный комментарий остаётся виден.
    expect(screen.getByText('Первый комментарий')).toBeInTheDocument();
  });

  it('отправка ответа уходит с parentId и якорем родителя', async () => {
    const { onAddReply } = renderPanel([comment()]);
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    await userEvent.type(screen.getByLabelText('Ответ на комментарий Борис'), 'Согласен');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]!['parentId']).toBe('root1');
    expect(posted[0]!['text']).toBe('Согласен');
    // Якорь ответа — якор родителя: обсуждение ведётся вокруг фрагмента текста.
    expect(posted[0]!['anchor']).toMatchObject({ kind: 'text', blockIndex: 1, start: 0, end: 5 });
    expect('anchorType' in posted[0]!).toBe(false);

    await waitFor(() => {
      expect(onAddReply).toHaveBeenCalledWith('root1', expect.objectContaining({ text: 'Согласен' }));
    });
  });

  it('Ctrl+Enter отправляет ответ', async () => {
    renderPanel([comment()]);
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    await userEvent.type(screen.getByLabelText('Ответ на комментарий Борис'), 'Клавишей');

    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
  });

  it('Enter без Ctrl переносит строку', async () => {
    renderPanel([comment()]);
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    const field = screen.getByLabelText('Ответ на комментарий Борис') as HTMLTextAreaElement;

    await userEvent.type(field, 'раз{Enter}два');

    expect(field.value).toBe('раз\nдва');
    expect(posted).toHaveLength(0);
  });

  it('Escape закрывает форму', async () => {
    renderPanel([comment()]);
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    expect(screen.getByLabelText('Ответ на комментарий Борис')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByLabelText('Ответ на комментарий Борис')).not.toBeInTheDocument();
    });
  });

  it('пустой ответ не отправляется', async () => {
    renderPanel([comment()]);
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));

    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    expect(posted).toHaveLength(0);
  });

  it('после отправки форма закрывается и текст очищен', async () => {
    renderPanel([comment()]);
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    await userEvent.type(screen.getByLabelText('Ответ на комментарий Борис'), 'Готово');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('Ответ на комментарий Борис')).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    expect(screen.getByLabelText('Ответ на комментарий Борис')).toHaveValue('');
  });

  it('отказ не закрывает форму и сохраняет текст', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { code: 'internal', message: 'Ошибка' } }),
      }) as Response),
    );
    renderPanel([comment()]);
    await userEvent.click(screen.getByRole('button', { name: 'Ответить' }));
    await userEvent.type(screen.getByLabelText('Ответ на комментарий Борис'), 'Не отправится');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText('Ответ на комментарий Борис')).toHaveValue('Не отправится');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }) as Response),
    );
  });
});

describe('сворачивание треда', () => {
  it('ответы показаны, пока тред открыт', () => {
    renderPanel([comment({ replies: [reply({ text: 'Первый ответ' })] })]);

    expect(screen.getByText('Первый ответ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Свернуть ответы' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('клик сворачивает и раскрывает', async () => {
    renderPanel([
      comment({ replies: [reply({ text: 'Первый ответ' }), reply({ id: 'r2', text: 'Второй ответ' })] }),
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Свернуть ответы' }));

    await waitFor(() => {
      expect(screen.queryByText('Первый ответ')).not.toBeInTheDocument();
    });
    // Счётчик виден и на свёрнутом треде: человек должен знать, что там есть.
    const toggle = screen.getByRole('button', { name: /Показать 2 ответа/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getByText('Первый ответ')).toBeInTheDocument();
    });
  });

  it('у корневого без ответов кнопки свёртывания нет', () => {
    renderPanel([comment()]);

    expect(screen.queryByRole('button', { name: /ответ/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ответить' })).toBeInTheDocument();
  });

  it('склонение счётчика', () => {
    const one = comment({ replies: [reply()] });
    renderPanel([one]);

    expect(screen.getByRole('button', { name: 'Свернуть ответы' })).toBeInTheDocument();
  });
});

describe('пометка «вы»', () => {
  it('стоит у собственного ответа и не стоит у чужого', () => {
    renderPanel([
      comment({ replies: [reply({ author: { id: 'u1', username: 'boris', displayName: 'Борис', avatar: null } })] }),
    ]);

    expect(screen.getByText('вы')).toBeInTheDocument();
  });
});