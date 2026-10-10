import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  defaultComments,
  markOf,
  renderReaderWithComments,
  waitReaderReady,
} from './reader-harness.js';
import { resetScrollCalls, scrollIntoViewCalls } from './setup.js';

/**
 * Клик по маркеру в тексте.
 *
 * ─── Почему связь односторонней проверкой не закрывается ──────────────────────
 *
 * Маркер и панель рисуются разными компонентами и связываются идентификатором,
 * который ставится при наложении. Если забыть этот атрибут, маркер и панель
 * останутся двумя списками, которые просто существуют на одной странице: ничего
 * не упадёт, комментарии будут видны, и связь обнаружится только тем, что клик
 * по подчёркиванию ничего не делает.
 */

afterEach(() => {
  resetScrollCalls();
  vi.unstubAllGlobals();
});

describe('клик по маркеру', () => {
  it('подсвечивает карточку комментария в панели', async () => {
    renderReaderWithComments();
    await waitReaderReady();

    await userEvent.click(markOf('c')!);

    await waitFor(() => {
      expect(document.querySelector('[data-comment-card="c"]')?.classList.contains('is-flash')).toBe(true);
    });
  });

  it('подсвечивает только тот комментарий, по которому кликнули', async () => {
    renderReaderWithComments();
    await waitReaderReady();

    await userEvent.click(markOf('b')!);

    await waitFor(() => {
      expect(document.querySelector('[data-comment-card="b"]')?.classList.contains('is-flash')).toBe(true);
    });
    expect(document.querySelector('[data-comment-card="a"]')?.classList.contains('is-flash')).toBe(false);
  });

  it('прокручивает панель к нужному комментарию', async () => {
    renderReaderWithComments();
    await waitReaderReady();
    resetScrollCalls();

    await userEvent.click(markOf('c')!);

    await waitFor(() => {
      const calls = scrollIntoViewCalls();
      expect(calls.length).toBeGreaterThan(0);
      const last = calls[calls.length - 1]!;
      expect((last.target as HTMLElement).dataset['commentCard']).toBe('c');
      /*
        `block: 'nearest'` — обязателен: без него панель прокручивалась бы к
        началу элемента, и короткая карточка внизу списка уезжала бы наверх,
        теряя соседей, которых человек читает.
      */
      expect(last.options).toMatchObject({ block: 'nearest', behavior: 'smooth' });
    });
  });

  it('подсветка гаснет сама, а не живёт до следующего клика', async () => {
    renderReaderWithComments();
    await waitReaderReady();

    await userEvent.click(markOf('a')!);
    await waitFor(() => {
      expect(document.querySelector('[data-comment-card="a"]')?.classList.contains('is-flash')).toBe(true);
    });

    await waitFor(
      () => {
        expect(document.querySelector('[data-comment-card="a"]')?.classList.contains('is-flash')).toBe(false);
      },
      { timeout: 3_000 },
    );
  });

  it('открывает панель, если она была свёрнута', async () => {
    renderReaderWithComments();
    await waitReaderReady();

    const panel = document.querySelector('.comments')!;
    expect(panel.classList.contains('is-open')).toBe(false);

    await userEvent.click(markOf('a')!);

    await waitFor(() => {
      expect(panel.classList.contains('is-open')).toBe(true);
    });
  });

  it('клик по обычному тексту ничего не открывает', async () => {
    renderReaderWithComments();
    await waitReaderReady();
    resetScrollCalls();

    const paragraph = document.querySelector('[data-block="1"]')!;
    /*
      Клик по тексту между двумя маркерами.

      Первый дочерний узел абзаца — это как раз маркер «ветер», и клик по нему
      обязан открыть панель. Берётся узел между маркерами, чтобы проверить, что
      слушатель нацелен именно на обёртку, а не на весь блок: иначе любой клик
      по абзацу вёл бы к последнему комментарию главы.
    */
    const between = [...paragraph.childNodes].find(
      (node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '',
    )!;
    fireEvent.click(between);

    expect(document.querySelector('.comments')?.classList.contains('is-open')).toBe(false);
    expect(scrollIntoViewCalls()).toHaveLength(0);
  });

  it('у каждого маркера есть идентификатор комментария', async () => {
    renderReaderWithComments();
    await waitReaderReady();

    for (const comment of defaultComments()) {
      expect(markOf(comment.id)).not.toBeNull();
    }
    const marks = document.querySelectorAll('mark.rd-comment-marker');
    for (const mark of marks) {
      expect(mark.getAttribute('data-comment-id')).toBeTruthy();
    }
  });

  it('при «меньше движения» прокрутка идёт без анимации', async () => {
    /*
      Наблюдалось в браузере: плавная прокрутка не двигает страницу, когда
      движение отключено, и человек остаётся на месте после нажатия на маркер.
      Значит, вид прокрутки спрашивается у системы, а не задаётся всегда.
    */
    /*
    Заглушка `matchMedia` повторяет форму из `setup.ts`, а не одиночное
    `{ matches: true }`: читалка подписывается на изменение запроса через
    `addEventListener`, и голый объект роняет её при монтировании. Ошибка была
    бы в чужом месте — в `useNarrow`, — и смотрелась бы как поломка адаптива.
  */
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList);
    renderReaderWithComments();
    await waitReaderReady();
    resetScrollCalls();

    await userEvent.click(markOf('c')!);

    await waitFor(() => {
      const calls = scrollIntoViewCalls();
      expect(calls[calls.length - 1]?.options).toMatchObject({ behavior: 'auto' });
    });
    vi.restoreAllMocks();
  });

  it('второй маркер в том же абзаце остаётся кликабельным', async () => {
    /*
      Два комментария в одном абзаце дают две обёртки, и обе с одним и тем же
      списком идентификаторов. Если бы вторая не получила атрибут, клик по ней
      молча ничего бы не сделал — при том, что подчёркивание на месте.
    */
    renderReaderWithComments();
    await waitReaderReady();

    const inFirst = [...document.querySelectorAll('[data-block="1"] mark.rd-comment-marker')];
    expect(inFirst).toHaveLength(2);
    expect(inFirst.map((m) => m.getAttribute('data-comment-id'))).toEqual(['a', 'b']);

    resetScrollCalls();
    await userEvent.click(inFirst[1]!);

    await waitFor(() => {
      const calls = scrollIntoViewCalls();
      expect((calls[calls.length - 1]!.target as HTMLElement).dataset['commentCard']).toBe('b');
    });
  });

  it('переключатель в шапке открывает и закрывает панель', async () => {
    renderReaderWithComments();
    await waitReaderReady();

    const toggle = screen.getByRole('button', { name: 'Комментарии к главе' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(toggle);
    await waitFor(() => {
      expect(document.querySelector('.comments')?.classList.contains('is-open')).toBe(true);
    });

    await userEvent.click(toggle);
    await waitFor(() => {
      expect(document.querySelector('.comments')?.classList.contains('is-open')).toBe(false);
    });
  });

  it('в шапке видно, сколько комментариев в главе', async () => {
    renderReaderWithComments();
    await waitReaderReady();

    expect(screen.getByRole('button', { name: 'Комментарии к главе' })).toHaveTextContent(
      'Комментарии · 3',
    );
  });
});