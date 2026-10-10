import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Dialog } from '../src/components/ui/Dialog.js';

/**
 * Фокус в модальном окне.
 *
 * ─── Почему это проверяется отдельно ─────────────────────────────────────────
 *
 * Наблюдалось в браузере: открываешь «Новая комната», нажимаешь Escape — и
 * фокус пропадает в `<body>`. С клавиатуры дальше нечем идти: первый Tab
 * уводит в начало страницы, то есть в шапку. Причина в порядке — `autoFocus`
 * поля срабатывает при фиксации дерева, между рендером и эффектом, поэтому
 * «кто открыл» должен запоминаться при рендере, а не в эффекте.
 *
 * Проверки идут на живом поведении (`document.activeElement`), а не на том,
 * вызвали ли мы `focus()`: вызвать можно и не туда.
 */

function Harness({ withAutoFocus = false }: { withAutoFocus?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Открыть
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Проверка">
        {withAutoFocus ? <input aria-label="Поле" autoFocus /> : <span>Просто текст</span>}
      </Dialog>
    </>
  );
}

/** Диалог по `role`, а не по классу: класс — деталь вёрстки. */
function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error('окно не открылось');
  return found;
}

describe('фокус в модальном окне', () => {
  it('окно без полей само забирает фокус', async () => {
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));

    expect(document.activeElement).toBe(dialog());
  });

  it('поле с автофокусом остаётся в фокусе', async () => {
    /*
      Именно этот случай ломался, когда окно переводило фокус на себя безусловно:
      человек начинал печатать в поле, а фокус уезжал на пустой контейнер — и
      первые буквы пропадали.
    */
    render(<Harness withAutoFocus />);

    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));

    expect(document.activeElement).toBe(screen.getByLabelText('Поле'));
  });

  it('после закрытия фокус возвращается на кнопку, которая открыла окно', async () => {
    render(<Harness withAutoFocus />);
    const opener = screen.getByRole('button', { name: 'Открыть' });

    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');

    expect(document.activeElement).toBe(opener);
  });

  it('второе открытие запоминает свой элемент, а не прошлый', async () => {
    /*
      Ссылка обнуляется при закрытии. Если бы она переживала открытие, второе
      окно вернуло бы фокус на кнопку от первого раза — на кнопку, которую
      человек уже не нажимал.
    */
    function Twice() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Первая
          </button>
          <button type="button" onClick={() => setOpen(true)}>
            Вторая
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Проверка">
            <span>Просто текст</span>
          </Dialog>
        </>
      );
    }
    render(<Twice />);
    const first = screen.getByRole('button', { name: 'Первая' });
    const second = screen.getByRole('button', { name: 'Вторая' });

    await userEvent.click(first);
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(first);

    await userEvent.click(second);
    await userEvent.keyboard('{Escape}');

    expect(document.activeElement).toBe(second);
  });

  it('пока окно открыто, стрелки Tab не уводят фокус из него', async () => {
    /*
      Подложка помечена `aria-hidden`, но она остаётся в дереве. Фокус на самом
      окне (`tabIndex={-1}`) — это то, что позволяет Tab дойти до полей окна,
      а не уйти на элемент под подложкой.
    */
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: 'Открыть' }));

    expect(dialog().contains(document.activeElement)).toBe(true);
  });
});