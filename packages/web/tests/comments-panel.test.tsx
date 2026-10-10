import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentsPanel } from '../src/books/CommentsPanel.js';
import { ToastProvider } from '../src/components/ui/Toast.js';
import { addComment, positionOf, sortByPosition } from '../src/books/comments-tree.js';
import type { WireComment } from '../src/api/types.js';

/**
 * Панель комментариев: список, порядок, пустое состояние.
 *
 * ─── Что проверяется про порядок ──────────────────────────────────────────────
 *
 * Порядок по времени для панели бессмыслен: человек ищет «что написали к этому
 * абзацу», а пять комментариев из пяти мест, перечисленные по времени, не
 * отвечают на этот вопрос. Проверяется, что список идёт по тексту: блок, затем
 * символ внутри блока.
 */

function comment(over: Partial<WireComment> = {}, anchor?: Partial<Record<string, unknown>>): WireComment {
  return {
    id: 'c1',
    bookFileKind: 'text',
    text: 'Комментарий',
    anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 4, quote: 'ветер', ...anchor },
    anchorType: 'text',
    isSpoiler: false,
    isResolved: false,
    parentId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    author: { id: 'u1', username: 'boris', displayName: 'Борис Петров', avatar: null },
    reactions: [],
    ...over,
  };
}

function renderPanel(comments: WireComment[], over: Partial<React.ComponentProps<typeof CommentsPanel>> = {}) {
  const onAdd = vi.fn();
  const onAddReply = vi.fn();
  const onPick = vi.fn();
  const onToggle = vi.fn();
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
        onToggle={onToggle}
        onAdd={onAdd}
        onAddReply={onAddReply}
        onPick={onPick}
        {...over}
      />
    </ToastProvider>,
  );
  return { onAdd, onAddReply, onPick, onToggle };
}

describe('панель комментариев', () => {
  it('показывает комментарии с автором, текстом и временем', () => {
    renderPanel([comment({ text: 'Красивая строка' })]);

    expect(screen.getByRole('heading', { name: /Комментарии/ })).toBeInTheDocument();
    expect(screen.getByText('Борис Петров')).toBeInTheDocument();
    expect(screen.getByText('Красивая строка')).toBeInTheDocument();
    // Инициалы вместо пустой аватарки: круг с буквой читается как человек.
    expect(screen.getByText('БП')).toBeInTheDocument();
    expect(document.querySelector('time')).toHaveAttribute('dateTime', '2026-01-01T00:00:00.000Z');
  });

  it('счётчик в заголовке равен числу комментариев', () => {
    renderPanel([comment({ id: 'a' }), comment({ id: 'b' }), comment({ id: 'c' })]);

    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('пустое состояние объясняет, что комментариев нет', () => {
    renderPanel([]);

    expect(screen.getByText('К этой главе пока нет комментариев')).toBeInTheDocument();
  });

  it('порядок по месту в тексте, а не по времени', () => {
    /*
      Три комментария, созданные в обратном порядке чтения: средний абзац
      создан раньше всех, последний — последним. По времени список вышел бы
      «третий, первый, второй», и человек не нашёл бы ничего.
    */
    renderPanel([
      comment({ id: 'third', text: 'Третий абзац', createdAt: '2026-01-01T03:00:00.000Z' }, { blockIndex: 2, start: 0 }),
      comment({ id: 'first', text: 'Первый абзац', createdAt: '2026-01-01T01:00:00.000Z' }, { blockIndex: 0, start: 0 }),
      comment({ id: 'second', text: 'Второй абзац', createdAt: '2026-01-01T02:00:00.000Z' }, { blockIndex: 1, start: 0 }),
    ]);

    const texts = screen.getAllByText(/абзац$/).map((el) => el.textContent);
    expect(texts).toEqual(['Первый абзац', 'Второй абзац', 'Третий абзац']);
  });

  it('внутри блока порядок по смещению', () => {
    renderPanel([
      comment({ id: 'b', text: 'Позже', createdAt: '2026-01-01T01:00:00.000Z' }, { blockIndex: 1, start: 40 }),
      comment({ id: 'a', text: 'Раньше', createdAt: '2026-01-01T02:00:00.000Z' }, { blockIndex: 1, start: 5 }),
    ]);

    const texts = screen.getAllByText(/^(Позже|Раньше)$/).map((el) => el.textContent);
    expect(texts).toEqual(['Раньше', 'Позже']);
  });

  it('показывает цитату, за которую зацеплен комментарий', () => {
    renderPanel([comment({}, { quote: 'отрывок из книги' })]);

    expect(screen.getByText('отрывок из книги')).toBeInTheDocument();
  });

  it('у комментария без цитаты строка цитаты не появляется', () => {
    renderPanel([comment({ anchor: { kind: 'audio', timeSec: 12 } }, {})]);

    expect(screen.queryByText(/книг/)).not.toBeInTheDocument();
  });

  it('клик по карточке передаёт её идентификатор', async () => {
    const { onPick } = renderPanel([comment({ id: 'x1' })]);

    await userEvent.click(screen.getByText('Комментарий'));

    expect(onPick).toHaveBeenCalledWith('x1');
  });

  it('сворачивание вызывает переключатель', async () => {
    const { onToggle } = renderPanel([comment()]);

    await userEvent.click(screen.getByRole('button', { name: 'Скрыть комментарии' }));

    expect(onToggle).toHaveBeenCalled();
  });

  it('аватар-картинка рисуется, а не инициалами', () => {
    renderPanel([
      comment({ author: { id: 'u2', username: 'lida', displayName: 'Лида', avatar: '/api/books/cover.jpg' } }),
    ]);

    expect(document.querySelector('img.comment__avatar')).toHaveAttribute(
      'src',
      '/api/books/cover.jpg',
    );
  });

  it('у каждой карточки есть идентификатор для связи с маркером', () => {
    renderPanel([comment({ id: 'x1' })]);

    expect(document.querySelector('[data-comment-card="x1"]')).not.toBeNull();
  });
});

describe('дерево комментариев', () => {
  it('корень добавляется в список', () => {
    const root = comment({ id: 'a' });
    expect(addComment([], root)).toEqual([root]);
  });

  it('ответ уходит к своему родителю', () => {
    const root = comment({ id: 'a' });
    const reply = comment({ id: 'r1', parentId: 'a' });

    const next = addComment([root], reply);

    expect(next).toHaveLength(1);
    expect(next[0]?.replies).toEqual([reply]);
    // Исходный объект не тронут: мутация здесь обновила бы только текущий корень,
    // а на панели с ответами требовался бы ещё и новый объект родителя.
    expect(root.replies).toBeUndefined();
  });

  it('ответ без родителя в списке не теряется', () => {
    /*
      Так бывает, когда человек ответил на комментарий из другой главы. Ответ
      показан как корневой и помечен родителем в данных: потерять его молча хуже,
      чем показать не там.
    */
    const reply = comment({ id: 'r1', parentId: 'missing' });

    const next = addComment([], reply);

    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe('r1');
  });

  it('порядок по позиции устойчив при одинаковых координатах', () => {
    const a = comment({ id: 'a', createdAt: '2026-01-01T01:00:00.000Z' });
    const b = comment({ id: 'b', createdAt: '2026-01-01T02:00:00.000Z' });

    const sorted = sortByPosition([b, a]);

    expect(sorted.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('позиция берётся из якоря, а не из порядка в списке', () => {
    expect(positionOf(comment({}, { blockIndex: 7, start: 12 }))).toEqual({ block: 7, start: 12 });
  });

  it('якорь без координат даёт нули и не роняет сортировку', () => {
    expect(positionOf(comment({ anchor: { kind: 'text' } }, {}))).toEqual({ block: 0, start: 0 });
  });
});

describe('доступность панели', () => {
  it('панель — это область с подписью', () => {
    renderPanel([]);

    expect(within(screen.getByRole('complementary', { name: 'Комментарии к главе' })).getByRole('heading')).toBeInTheDocument();
  });
});