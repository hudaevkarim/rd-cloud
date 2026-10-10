import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { markOf, renderReaderWithComments, waitReaderReady, defaultComments } from './reader-harness.js';
import { resetScrollCalls, scrollIntoViewCalls } from './setup.js';

/**
 * Клик по комментарию в панели: текст прокручивается к его маркеру.
 *
 * ─── Почему прокрутка идёт к маркеру, а не к блоку ────────────────────────────
 *
 * Человек кликнул на комментарий к конкретной фразе и хочет видеть именно её.
 * Прокрутка к началу абзаца поставила бы фразу где-то за экраном, и человек
 * искал бы её глазами по тексту — то есть потерял бы ровно то, ради чего кликнул.
 */

afterEach(() => {
  resetScrollCalls();
  vi.unstubAllGlobals();
});

/** Открывает панель: без неё карточек в дереве нет. */
async function openPanel(): Promise<void> {
  await waitReaderReady();
  await userEvent.click(document.querySelector('.reader__comments-toggle')!);
  await waitFor(() => {
    expect(document.querySelector('.comments')?.classList.contains('is-open')).toBe(true);
  });
}

describe('клик по комментарию в панели', () => {
  it('прокручивает текст к маркеру этого комментария', async () => {
    renderReaderWithComments();
    await openPanel();
    resetScrollCalls();

    await userEvent.click(document.querySelector('[data-comment-card="c"]')!);

    await waitFor(() => {
      const calls = scrollIntoViewCalls();
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[calls.length - 1]!.target as HTMLElement).getAttribute('data-comment-id')).toBe('c');
      expect(calls[calls.length - 1]!.options).toMatchObject({ block: 'center', behavior: 'smooth' });
    });
  });

  it('подсвечивает маркер в тексте', async () => {
    renderReaderWithComments();
    await openPanel();

    await userEvent.click(document.querySelector('[data-comment-card="a"]')!);

    await waitFor(() => {
      expect(markOf('a')?.classList.contains('is-flash')).toBe(true);
    });
  });

  it('подсвечивает только свой маркер', async () => {
    renderReaderWithComments();
    await openPanel();

    await userEvent.click(document.querySelector('[data-comment-card="b"]')!);

    await waitFor(() => {
      expect(markOf('b')?.classList.contains('is-flash')).toBe(true);
    });
    expect(markOf('a')?.classList.contains('is-flash')).toBe(false);
    expect(markOf('c')?.classList.contains('is-flash')).toBe(false);
  });

  it('подсветка маркера гаснет сама', async () => {
    renderReaderWithComments();
    await openPanel();

    await userEvent.click(document.querySelector('[data-comment-card="a"]')!);
    await waitFor(() => {
      expect(markOf('a')?.classList.contains('is-flash')).toBe(true);
    });

    await waitFor(
      () => {
        expect(markOf('a')?.classList.contains('is-flash')).toBe(false);
      },
      { timeout: 3_000 },
    );
  });

  it('второй комментарий того же абзаца ведёт к своему маркеру', async () => {
    renderReaderWithComments();
    await openPanel();
    resetScrollCalls();

    await userEvent.click(document.querySelector('[data-comment-card="b"]')!);

    await waitFor(() => {
      const calls = scrollIntoViewCalls();
      expect((calls[calls.length - 1]!.target as HTMLElement).getAttribute('data-comment-id')).toBe('b');
    });
  });

  it('клик по кнопке «Ответить» не прокручивает текст', async () => {
    /*
      Кнопка внутри карточки: без остановки события клик всплыл бы до карточки и
      отправил бы человека к маркеру в тот момент, когда он хочет писать ответ.
    */
    renderReaderWithComments();
    await openPanel();
    resetScrollCalls();

    await userEvent.click(screen_replyButton());

    expect(scrollIntoViewCalls()).toHaveLength(0);
  });

  it('клик по кнопке свёртывания не прокручивает текст', async () => {
    /*
      У комментария с ответом появляется вторая кнопка в подвале карточки. Она
      стоит рядом с «Ответить» и так же не должна отправлять человека к маркеру.
    */
    const withReply = defaultComments();
    renderReaderWithComments([
      {
        ...withReply[0]!,
        replies: [
          {
            ...withReply[0]!,
            id: 'a1',
            parentId: 'a',
            text: 'Ответ',
            author: { id: 'u3', username: 'petr', displayName: 'Пётр', avatar: null },
          },
        ],
      },
      ...withReply.slice(1),
    ]);
    await openPanel();
    resetScrollCalls();

    await userEvent.click(screen_collapseButton());

    expect(scrollIntoViewCalls()).toHaveLength(0);
    await waitFor(() => {
      expect(screen.queryByText('Ответ')).not.toBeInTheDocument();
    });
  });

  it('комментарий без маркера в тексте не роняет страницу', async () => {
    /*
      Так бывает, когда книгу пересобрали и цитата перестала находиться:
      комментарий виден в панели, а подчёркивания под ним нет. Клик должен быть
      просто ничем, а не ошибкой.
    */
    renderReaderWithComments();
    await openPanel();
    resetScrollCalls();

    // Карточка ответа: у ответа своего маркера нет, он живёт в треде родителя.
    const root = document.querySelector('[data-comment-card="b"]') as HTMLElement;
    root.querySelector<HTMLButtonElement>('.comment__link')!.click();

    await waitFor(() => {
      expect(document.querySelector('[aria-label^="Ответ на комментарий"]')).not.toBeNull();
    });
    expect(scrollIntoViewCalls()).toHaveLength(0);
  });
});

function screen_replyButton(): HTMLElement {
  const button = [...document.querySelectorAll('.comment__link')].find((b) => b.textContent === 'Ответить');
  if (button === undefined) throw new Error('кнопка «Ответить» не найдена');
  return button as HTMLElement;
}

function screen_collapseButton(): HTMLElement {
  const button = [...document.querySelectorAll('.comment__link')].find((b) =>
    (b.textContent ?? '').startsWith('Свернуть'),
  );
  if (button === undefined) throw new Error('кнопка свёртывания не найдена');
  return button as HTMLElement;
}