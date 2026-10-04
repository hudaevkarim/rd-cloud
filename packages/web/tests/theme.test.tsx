import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '../src/theme/ThemeContext.js';
import {
  readStoredTheme,
  resolveTheme,
  useTheme,
  writeStoredTheme,
  type Theme,
} from '../src/theme/theme-context.js';

/**
 * Тема.
 *
 * Три состояния — светлая, тёмная и «как в системе» — и переключение между
 * ними. Отдельно проверяется `resolveTheme` как чистая функция: правило
 * «system превращается в то, что выбрала система» легко сломать правкой в
 * компоненте, а здесь оно видно сразу.
 */

function Probe() {
  const { theme, resolved, setTheme, toggle } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolved}</span>
      <button type="button" onClick={toggle}>
        Переключить
      </button>
      <button type="button" onClick={() => setTheme('system')}>
        Как в системе
      </button>
      <button type="button" onClick={() => setTheme('dark')}>
        Тёмная
      </button>
    </div>
  );
}

/**
 * Рендер с темой, подставляемой вручную: jsdom не знает о системных настройках.
 *
 * Тема записывается в хранилище, а не передаётся провайдеру: провайдер читает
 * её оттуда при инициализации. Если передать её иначе, компонент всё равно
 * начал бы с `system`, и проверка нажатия считала бы не то состояние, которое
 * выставил тест.
 */
function renderTheme(storage: Storage, theme: Theme, prefersDark = false) {
  writeStoredTheme(storage, theme);
  return render(
    <ThemeProvider storage={storage} prefersDark={prefersDark}>
      <Probe />
    </ThemeProvider>,
  );
}

/** Хранилище в памяти: `jsdom` даёт `localStorage`, но он общий на файл. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
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

describe('resolveTheme', () => {
  it('system разрешается в то, что выбрала система', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('выбранная тема системную игнорирует', () => {
    // Явный выбор человека сильнее настройки системы: он её переключил
    // осознанно, и молча менять обратно нельзя.
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('хранение настройки', () => {
  it('читает записанное значение', () => {
    const storage = memoryStorage();
    writeStoredTheme(storage, 'dark');
    expect(readStoredTheme(storage)).toBe('dark');
  });

  it('битое значение равносильно отсутствию', () => {
    const storage = memoryStorage();
    storage.setItem('rd.theme', 'не-тема');
    // Мусор в хранилище не должен ломать страницу: значение отбрасывается, а
    // не вызывает ошибку при разборе.
    expect(readStoredTheme(storage)).toBe('system');
  });

  it('без хранилища возвращается system', () => {
    expect(readStoredTheme(undefined)).toBe('system');
    // Запись без хранилища не падает: приватный режим браузера запрещает
    // писать, и это не повод ломать переключение.
    expect(() => writeStoredTheme(undefined, 'dark')).not.toThrow();
  });
});

describe('переключение', () => {
  it('по умолчанию следует за системой', () => {
    renderTheme(memoryStorage(), 'system');
    // Настройки ещё нет — значит, поведение равно системному, а не
    // запомненному с прошлого визита.
    expect(screen.getByTestId('theme')).toHaveTextContent('system');
  });

  it('кнопка переключения меняет тему и ставит атрибут на <html>', async () => {
    const storage = memoryStorage();
    const user = userEvent.setup();
    renderTheme(storage, 'light');

    await user.click(screen.getByRole('button', { name: 'Переключить' }));

    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    // Атрибут важен не только для стилей: по нему и `color-scheme` панели
    // браузера, и сохранённое системное значение на скриншоте.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(storage.getItem('rd.theme')).toBe('dark');
  });

  it('переключение назад возвращает светлую', async () => {
    const user = userEvent.setup();
    renderTheme(memoryStorage(), 'dark');

    await user.click(screen.getByRole('button', { name: 'Переключить' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('из system переключение идёт в противоположную текущей', async () => {
    const user = userEvent.setup();
    // Система тёмная, выбор не задан: переключение должно дать светлую, а не
    // тёмную — иначе первое нажатие ничего не меняет.
    renderTheme(memoryStorage(), 'system', true);

    await user.click(screen.getByRole('button', { name: 'Переключить' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('выбор «как в системе» откатывает ручной выбор', async () => {
    const user = userEvent.setup();
    renderTheme(memoryStorage(), 'light', true);

    await user.click(screen.getByRole('button', { name: 'Как в системе' }));

    expect(screen.getByTestId('theme')).toHaveTextContent('system');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('заданная тема влияет на разрешённую', async () => {
    const user = userEvent.setup();
    renderTheme(memoryStorage(), 'light', true);

    await user.click(screen.getByRole('button', { name: 'Тёмная' }));

    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });

  it('useTheme вне провайдера бросает ошибку', () => {
    // Ошибка программиста должна быть громкой: молчание привело бы к
    // «тема не переключается» без внятной причины.
    //
    // React печатает брошенную ошибку в консоль и считает её необработанной,
    // из-за чего прогон падает целиком. Здесь она ожидаемая, поэтому вывод
    // глушится на время проверки — и возвращается сразу после, иначе следующий
    // тест потерял бы настоящее сообщение об ошибке.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
    } finally {
      spy.mockRestore();
    }
  });
});
