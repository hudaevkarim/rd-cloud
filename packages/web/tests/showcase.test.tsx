import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { ShowcasePage } from '../src/dev/ShowcasePage.js';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import { ToastProvider } from '../src/components/ui/Toast.js';

/**
 * Страница компонентов.
 *
 * Проверяется ровно то, ради чего она сделана: **все компоненты присутствуют и
 * отображаются**. Страница — инструмент проверки дизайн-системы глазами, и если
 * половина компонентов на ней не отрисуется, её назначение теряется: человек
 * посмотрит, решит, что так и задумано, и построит на этом страницы.
 *
 * Отдельно проверяются две вещи, которые ломаются тихо:
 *
 *   `noindex`  метка ставится на время жизни страницы и снимается при уходе.
 *              Оставленная метка пометила бы адрес, открытый следом.
 *
 *   ширина     переключение идёт через `iframe`, потому что медиазапросы
 *              реагируют на вьюпорт, а не на контейнер. Без кадра переключатель
 *              ширины был бы декорацией: сузить контейнер и не увидеть адаптива.
 */

/**
 * Корень репозитория — из `define` в `vitest.config.ts`.
 *
 * Вычислять его в тесте нельзя: в воркере vitest пути с кириллицей
 * декодируются неверно, и `readFileSync` по вычисленному пути вернёт мусор
 * молча. Подробности — в комментарии к `define`.
 */
const ROOT = __REPO_ROOT__;

function renderPage(path = '/dev/components') {
  return render(
    <ThemeProvider prefersDark={false}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <ShowcasePage />
        </MemoryRouter>
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  document.head.querySelectorAll('meta[name="robots"]').forEach((node) => node.remove());
  // jsdom не грузит кадр: `contentWindow` есть, но документ внутри чужой.
  // Подмена нужна, чтобы обработчик `onLoad` не спотыкался о недоступный
  // документ — в браузере там полноценная страница.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response));
});

describe('страница витрины', () => {
  it('открывается и показывает заголовок', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Компоненты' })).toBeInTheDocument();
  });

  it('открывается без входа: сессия не требуется', async () => {
    // Страница нужна ровно тогда, когда сессии ещё нет, — при разработке формы
    // входа. Если бы она стояла под `RequireAuth`, её нельзя было бы открыть
    // в момент, когда вход и делают.
    renderPage();
    expect(screen.getByRole('heading', { name: 'Компоненты' })).toBeInTheDocument();
  });

  it('показывает кадр с витриной', async () => {
    renderPage();
    const frame = await screen.findByTitle('Витрина компонентов');
    expect(frame.getAttribute('src')).toBe('/dev/components?frame=1');
  });

  it('внутри кадра показывает только содержимое, без панели', () => {
    renderPage('/dev/components?frame=1');

    // Панели управления внутри кадра нет: она занимала бы место, отведённое
    // под компоненты, и на 320px вытеснила бы их за край.
    expect(screen.queryByRole('heading', { name: 'Компоненты' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Ширина' })).not.toBeInTheDocument();
    expect(screen.getByText('Кнопка')).toBeInTheDocument();
  });
});

describe('компоненты на витрине', () => {
  it('показывает все три варианта кнопки, недоступную и копии наведения', async () => {
    renderPage('/dev/components?frame=1');

    expect(screen.getByRole('button', { name: 'Обычная' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Призрачная' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Опасное' })).toBeInTheDocument();

    const disabled = screen.getAllByRole('button', { name: 'Недоступно' });
    expect(disabled).toHaveLength(2);
    expect(disabled[0]).toBeDisabled();

    // Копии наведения — статичные, настоящее наведение проверяется мышью.
    // По одной на каждый вариант: у `ghost` и `danger` правила наведения
    // разные, и одна общая копия не показала бы, в чём именно разница.
    const hovers = screen.getAllByRole('button', { name: /hover/ });
    expect(hovers).toHaveLength(3);
    expect(hovers.map((n) => n.className)).toEqual([
      expect.stringContaining('btn--hover-preview'),
      expect.stringContaining('btn--hover-preview-ghost'),
      expect.stringContaining('btn--hover-preview-danger'),
    ]);
  });

  it('показывает четыре состояния поля ввода', async () => {
    renderPage('/dev/components?frame=1');

    const byLabel = (name: string): HTMLInputElement =>
      screen.getByLabelText(name, { selector: 'input' }) as HTMLInputElement;

    expect(byLabel('Название комнаты')).toBeInTheDocument();

    const withPlaceholder = byLabel('Токен');
    expect(withPlaceholder.placeholder).toBe('Токен, выданный администратором');

    const withError = byLabel('Код приглашения');
    // Ошибка обязана быть и визуальной, и объявленной: только цветом её
    // сообщить нельзя — человек, который не различает цвета, её не увидит.
    expect(withError).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Код приглашения выглядит неверно');

    expect(byLabel('Читаемое поле')).toHaveAttribute('readonly');
  });

  it('показывает лейблы, линии и спиннеры', async () => {
    renderPage('/dev/components?frame=1');

    expect(screen.getByText('обычный')).toBeInTheDocument();
    expect(screen.getByText('акцентом')).toBeInTheDocument();

    const separators = document.querySelectorAll('[role="separator"], hr.rule');
    expect(separators.length).toBeGreaterThan(0);

    // Три размера: размер задан явно и цветом наследуется из currentColor.
    expect(document.querySelectorAll('.spinner').length).toBe(3);
  });

  it('показывает уведомления всех трёх видов', async () => {
    renderPage('/dev/components?frame=1');

    expect(screen.getByText('Комментарий сохранён')).toBeInTheDocument();
    expect(screen.getByText('Файл больше лимита в 50 МБ')).toBeInTheDocument();
    expect(screen.getByText('Борис ответил на ваш комментарий')).toBeInTheDocument();

    // Ошибка отличается рамкой и цветом, а не только текстом.
    const error = document.querySelector('.toast--error');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain('больше лимита');
  });

  it('показывает модальное окно в разобранном виде и открывает живое', async () => {
    const user = userEvent.setup();
    renderPage('/dev/components?frame=1');

    // Разобранная копия нужна для сравнения с живой: настоящее окно
    // перекрывает страницу, и после его открытия ничего не видно.
    const inline = screen.getByRole('dialog', { name: 'Пример окна' });
    expect(within(inline).getByText('Покинуть комнату?')).toBeInTheDocument();
    expect(within(inline).getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
  });

  it('живое окно открывается и закрывается по Escape', async () => {
    // Проверяется в кадре, а не на странице витрины: демонстрации живут в
    // содержимом, которое на странице ширины показывается кадром, а сам кадр
    // jsdom не загружает. На настоящей странице человек нажимает прямо в нём.
    const user = userEvent.setup();
    renderPage('/dev/components?frame=1');

    const opener = screen.getByRole('button', { name: 'Открыть окно' });
    await user.click(opener);

    const live = await screen.findByRole('dialog', { name: 'Покинуть комнату?' });
    expect(live).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Покинуть комнату?' })).not.toBeInTheDocument();
    });
  });

  it('показывает все токены, и каждый объявлен в tokens.css', async () => {
    renderPage('/dev/components?frame=1');

    for (const name of ['--paper', '--ink', '--ink-2', '--rule', '--accent', '--on-accent']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    for (const n of [1, 2, 3, 4, 6, 8, 12, 16]) {
      expect(screen.getByText(`--space-${n}`)).toBeInTheDocument();
    }
    // Имена ищутся по узким классам, а не по всему документу: `--gutter` и
    // `--measure` встречаются дважды — в таблице отступов и в списке токенов
    // формы, — и общий поиск по тексту нашёл бы не то.
    const shownNames = (): string[] =>
      [...document.querySelectorAll('.swatch__name, .spacing__name')].map(
        (n) => n.textContent ?? '',
      );

    for (const name of shownNames()) {
      expect(name).toMatch(/^--[a-z0-9-]+$/);
    }
    for (const name of ['--gutter', '--measure', '--paper', '--space-16']) {
      expect(shownNames()).toContain(name);
    }
    // Группа «Форма» подписывает токен вместе со значением, одним текстом.
    for (const name of ['--radius', '--touch', '--transition', '--topbar-h']) {
      expect(document.querySelector('code')?.textContent).not.toBeNull();
      expect(screen.getAllByText(new RegExp(`^${name}: `)).length).toBeGreaterThan(0);
    }

    /*
     * ─── Почему значения не сравниваются с ожидаемыми ───────────────────────
     *
     * jsdom не применяет `tokens.css`: `getComputedStyle` отдаёт для токенов
     * пустую строку, и витрина честно покажет прочерки. Сравнивать с ожидаемыми
     * значениями здесь бессмысленно — проверялся бы jsdom, а не страница.
     *
     * Значения проверяются по-настоящему на живой странице, где токены
     * применены. А вот существование самих имён проверяется здесь, чтением
     * файла: опечатка в имени (`--paer`) не дала бы ошибки в разметке — просто
     * прочерк вместо цвета, и человек увидел бы пустую клетку, не поняв, что
     * клетка должна была быть цветной.
     */
    const css = readFileSync(`${ROOT}packages/web/src/styles/tokens.css`, 'utf8');
    const declared = new Set(
      [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1] as string),
    );

    // Все имена, показанные на витрине, должны быть настоящими токенами.
    const shown = [
      ...shownNames(),
      ...[...document.querySelectorAll('code')]
        .map((n) => (n.textContent ?? '').match(/^(--[a-z0-9-]+):/)?.[1] ?? '')
        .filter((n) => n !== ''),
    ];
    expect(shown.length).toBeGreaterThan(15);
    for (const name of shown) {
      expect(declared, `${name} показан на витрине, но не объявлен в tokens.css`).toContain(name);
    }

    // И наоборот: показанное значение либо настоящее, либо прочерк — но не
    // пустая клетка. Пустая клетка читается как «данных нет», а означает
    // «токен не применён», и это разные вещи.
    await waitFor(() => {
      const cells = [...document.querySelectorAll('.swatch__value, .spacing__value')];
      expect(cells.length).toBeGreaterThan(10);
      for (const cell of cells) {
        expect((cell.textContent ?? '').trim()).not.toBe('');
      }
    });
  });

  it('показывает образцы типографики', async () => {
    renderPage('/dev/components?frame=1');

    expect(screen.getByText('СОСТОЯНИЕ ЧТЕНИЯ')).toBeInTheDocument();
    expect(screen.getByText('Заголовок раздела')).toBeInTheDocument();
    expect(screen.getByText('ЧИТАЙ')).toBeInTheDocument();
    // Книжный текст — единственный образец-абзац, и единственный, где важна
    // колонка `--measure`. Проверяется тегом, а не классом `.typo__row--book`:
    // этот класс на образце больше не нужен, и проверка на нём искала бы
    // снятую разметку, а не то, что на экране.
    const book = document.querySelector('.book');
    expect(book?.tagName).toBe('P');
    expect(book?.textContent).toContain('Пушкин написал об этом');
  });
});

describe('управление страницей', () => {
  it('переключает ширину через кадр, а не через контейнер', async () => {
    const user = userEvent.setup();
    renderPage();

    const frame = await screen.findByTitle('Витрина компонентов');
    expect(frame.getAttribute('width')).toBe('768');

    await user.click(screen.getByRole('button', { name: '320' }));
    expect(frame.getAttribute('width')).toBe('320');

    await user.click(screen.getByRole('button', { name: '1280' }));
    expect(frame.getAttribute('width')).toBe('1280');
  });

  it('переключатель ширины вне кадра: медиазапросы на него не реагируют', async () => {
    // Если бы переключатель менял ширину контейнера на этой же странице,
    // нижняя навигация не появилась бы: @media смотрит на окно, а не на блок.
    // Кадр с собственным вьюпортом — единственный способ проверить адаптив.
    renderPage();
    expect(screen.getByRole('group', { name: 'Ширина' })).toBeInTheDocument();
    expect(screen.getByTitle('Витрина компонентов').tagName).toBe('IFRAME');
  });

  it('переключает тему и помечает выбранный вариант', async () => {
    const user = userEvent.setup();
    renderPage();

    const toggle = screen.getByRole('button', { name: 'Тёмная тема' });
    await user.click(toggle);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Светлая тема' })).toBeInTheDocument();
    });
  });

  it('ставит noindex и снимает его при уходе', async () => {
    const { unmount } = renderPage();

    await waitFor(() => {
      const meta = document.head.querySelector('meta[name="robots"]');
      expect(meta?.getAttribute('content')).toBe('noindex, nofollow');
    });

    unmount();

    // Метка должна исчезнуть: оставленная, она пометила бы адрес, который
    // человек открыл следом, — то есть сделала бы ровно то, чего страница
    // не должна делать.
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  it('кадр применяет тему, присланную родителем, а не читает свою', async () => {
    /*
     * ─── Что здесь ломалось ───────────────────────────────────────────────────
     *
     * Раньше родитель ставил `data-theme` прямо на `documentElement` кадра.
     * Правила CSS применялись, фон и чипы становились тёмными, а
     * `ThemeProvider` внутри кадра продолжал считать тему светлой: числа
     * токенов на витрине оставались от светлой темы рядом с тёмными образцами.
     * Витрина, показывающая неверные значения токенов, хуже отсутствующей.
     *
     * Кадр применяет присланную тему своим провайдером, поэтому атрибут,
     * состояние React и показанные числа совпадают по построению.
     */
    const parent = renderPage();

    const frame = await screen.findByTitle('Витрина компонентов');
    const posted: unknown[] = [];
    // `postMessage` кадра заглушается: в jsdom кадр не грузится, и его
    // `contentWindow` есть, а отправка в него ничего не делает.
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: (message: unknown): void => void posted.push(message) },
    });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Тёмная тема' }));
    expect(posted).toContainEqual({ 'rd:showcase-theme': 'dark' });

    parent.unmount();
  });

  it('кадр принимает тему только от своего происхождения', async () => {
    // `message` приходит из любого окна. Без проверки происхождения и поля
    // чужое окно могло бы переключить тему витрины, а это страница, на которой
    // проверяют сами токены темы.
    renderPage('/dev/components?frame=1');

    const post = (origin: string, data: unknown): void => {
      window.dispatchEvent(new MessageEvent('message', { origin, data }));
    };

    post('https://чужая.example', { 'rd:showcase-theme': 'dark' });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    post(window.location.origin, { 'rd:showcase-theme': 'dark' });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  it('значения токенов не отстают от смены темы', async () => {
    /*
     * ─── Что здесь ломалось ───────────────────────────────────────────────────
     *
     * Чтение токенов стояло в эффекте с зависимостью `resolved`. Но `data-theme`
     * на `<html>` ставит `ThemeProvider`, а он — родитель витрины, и React
     * выполняет эффекты потомков раньше родительских. Значит чтение происходило
     * **до** записи новой темы: значения снимались со старой темы, а страница
     * перерисовывалась уже с новой. На экране появлялись тёмные образцы и
     * светлые числа токенов рядом с ними.
     *
     * Проверка без обмана: в тест добавляется настоящий `<style>` с
     * пользовательскими свойствами — jsdom их решает и по `data-theme`.
     * Сравниваются реальные значения до и после, а не факт срабатывания
     * наблюдателя: проверка «наблюдатель вызвался» прошла бы и в том случае,
     * когда витрина показывает неверные числа.
     */
    const style = document.createElement('style');
    style.textContent =
      ':root { --paper: #ffffff; --ink: #111111; }\n' +
      'html[data-theme="dark"] { --paper: #0f0f0f; --ink: #e8e8e8; }';
    document.head.appendChild(style);

    try {
      const { unmount } = renderPage('/dev/components?frame=1');

      const value = (name: string): string => {
        const cell = [...document.querySelectorAll('.swatch')].find(
          (n) => n.querySelector('.swatch__name')?.textContent === name,
        );
        return cell?.querySelector('.swatch__value')?.textContent ?? '';
      };

      await waitFor(() => expect(value('--ink')).toBe('#111111'));
      expect(value('--paper')).toBe('#ffffff');

      document.documentElement.setAttribute('data-theme', 'dark');

      await waitFor(() => {
        expect(value('--ink')).toBe('#e8e8e8');
        expect(value('--paper')).toBe('#0f0f0f');
      });

      // Показанное обязано совпадать с применённым: иначе тест прошёл бы,
      // обновив значения, но не из того источника, из которого их видно.
      const applied = getComputedStyle(document.documentElement)
        .getPropertyValue('--ink')
        .trim();
      expect(value('--ink')).toBe(applied);

      unmount();
    } finally {
      style.remove();
    }
  });

  it('внутри кадра noindex тоже стоит', async () => {
    // Кадр грузится по тому же адресу и сам по себе был бы индексируемым.
    renderPage('/dev/components?frame=1');
    await waitFor(() => {
      const meta = document.head.querySelector('meta[name="robots"]');
      expect(meta?.getAttribute('content')).toBe('noindex, nofollow');
    });
  });
});
