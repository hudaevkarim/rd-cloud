import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createPositionSaver,
  positionKey,
  readPosition,
  writePosition,
  SAVE_INTERVAL_MS,
  type PositionStorage,
} from '../src/books/reading-position.js';

/**
 * Позиция чтения.
 *
 * ─── Почему без React ─────────────────────────────────────────────────────────
 *
 * Здесь нет ни рендера, ни сети: только разбор записи из хранилища и решение,
 * писать её или отбросить. Проверка в React обернула бы эти три случая в
 * `render` и `act` и ничего не добавила бы, а поломки — скрыла.
 *
 * ─── Почему битая запись важна ───────────────────────────────────────────────
 *
 * Позиция — единственное, что человек замечает потерянным, когда ломается.
 * Именно на кривом JSON из прошлой версии приложения страница обязана открыться
 * с начала, а не упасть с «Не читается».
 */

/** Хранилище в памяти: словарь, а не `window.localStorage`. */
function memoryStorage(): PositionStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
  };
}

/** Хранилище, которое бросает: приватный режим Safari, запрещённые куки. */
function throwingStorage(): PositionStorage {
  return {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

const BOOK = 'book-1';

describe('чтение позиции', () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it('пустое хранилище — это отсутствие позиции, а не ошибка', () => {
    expect(readPosition(BOOK, storage)).toBeNull();
  });

  it('запись читается обратно целиком', () => {
    writePosition(BOOK, { chapter: 3, block: 17, scrollY: 840 }, storage, 1_700_000_000_000);

    expect(readPosition(BOOK, storage)).toEqual({
      chapter: 3,
      block: 17,
      scrollY: 840,
      updatedAt: 1_700_000_000_000,
    });
  });

  it('позиции разных книг не путаются', () => {
    writePosition('book-1', { chapter: 1, block: 2, scrollY: 30 }, storage);
    writePosition('book-2', { chapter: 9, block: 40, scrollY: 900 }, storage);

    expect(readPosition('book-1', storage)?.chapter).toBe(1);
    expect(readPosition('book-2', storage)?.chapter).toBe(9);
  });

  it('битый JSON отбрасывается, а не роняет страницу', () => {
    storage.setItem(positionKey(BOOK), '{это не json');

    // Позиция — удобство. Потеря её означает «откроется с начала», а падение на
    // разборе означало бы, что книга не открывается вовсе.
    expect(readPosition(BOOK, storage)).toBeNull();
  });

  it('запись чужой формы отбрасывается', () => {
    storage.setItem(positionKey(BOOK), JSON.stringify({ chapter: 'третья' }));
    expect(readPosition(BOOK, storage)).toBeNull();

    storage.setItem(positionKey(BOOK), JSON.stringify([1, 2, 3]));
    expect(readPosition(BOOK, storage)).toBeNull();

    storage.setItem(positionKey(BOOK), JSON.stringify(null));
    expect(readPosition(BOOK, storage)).toBeNull();
  });

  it('дробные и отрицательные номера отбрасываются', () => {
    /*
      Номер главы используется как индекс: `chapters[1.5]` — это `undefined`, и
      глава молча не открылась бы. Проверка на разборе дешевле, чем отладка
      «кнопка следующая ничего не делает».
    */
    for (const bad of [
      { chapter: 1.5, block: 2, scrollY: 0 },
      { chapter: 1, block: 0.5, scrollY: 0 },
      { chapter: -1, block: 0, scrollY: 0 },
      { chapter: 0, block: -2, scrollY: 0 },
      { chapter: 0, block: 0, scrollY: -5 },
    ]) {
      storage.setItem(positionKey(BOOK), JSON.stringify({ ...bad, updatedAt: 1 }));
      expect(readPosition(BOOK, storage), JSON.stringify(bad)).toBeNull();
    }
  });

  it('запрещённое хранилище не мешает читать', () => {
    // Приватный режим: обращение бросает. Страница обязана продолжить работу.
    expect(() => writePosition(BOOK, { chapter: 1, block: 1, scrollY: 1 }, throwingStorage())).not.toThrow();
    expect(readPosition(BOOK, throwingStorage())).toBeNull();
  });

  it('нулевая позиция сохраняется, а не считается отсутствующей', () => {
    // Первая глава, первый блок, верх страницы — это настоящая позиция, и
    // отбрасывать её по признаку «нули» нельзя: получился бы скачок назад.
    writePosition(BOOK, { chapter: 0, block: 0, scrollY: 0 }, storage, 5);

    const read = readPosition(BOOK, storage);
    expect(read).not.toBeNull();
    expect(read?.chapter).toBe(0);
  });
});

describe('отложенная запись', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('пишет не сразу, а не чаще раза в секунду', () => {
    const storage = memoryStorage();
    const saver = createPositionSaver(BOOK, storage);

    saver.schedule({ chapter: 0, block: 1, scrollY: 10 });
    expect(storage.raw.size).toBe(0);

    vi.advanceTimersByTime(SAVE_INTERVAL_MS);
    expect(storage.raw.size).toBe(1);
    expect(readPosition(BOOK, storage)?.block).toBe(1);
  });

  it('десять прокруток подряд дают одну запись с последней позицией', () => {
    /*
      Прокрутка шлёт событие десятками раз в секунду. Запись на каждое событие
      означала бы сотни записей в минуту, и на телефоне это видно по батарее.
    */
    const storage = memoryStorage();
    const saver = createPositionSaver(BOOK, storage);

    for (let i = 1; i <= 10; i += 1) {
      saver.schedule({ chapter: 0, block: i, scrollY: i * 50 });
      vi.advanceTimersByTime(100);
    }

    expect(storage.raw.size).toBe(1);
    // Записана последняя позиция, а не первая: вернуться надо туда, где человек
    // остановился, а не туда, откуда начал листать.
    expect(readPosition(BOOK, storage)?.block).toBe(10);
  });

  it('flush записывает немедленно — это уход со страницы', () => {
    const storage = memoryStorage();
    const saver = createPositionSaver(BOOK, storage);

    saver.schedule({ chapter: 2, block: 5, scrollY: 300 });
    saver.flush();

    expect(readPosition(BOOK, storage)).toMatchObject({ chapter: 2, block: 5, scrollY: 300 });
  });

  it('flush без накопленного положения ничего не пишет', () => {
    const storage = memoryStorage();
    const saver = createPositionSaver(BOOK, storage);

    saver.flush();
    saver.flush();

    // Пустая запись означала бы «человек был в начале», и возврат из любого
    // места уводил бы в начало книги.
    expect(storage.raw.size).toBe(0);
  });

  it('flush отменяет отложенную запись, а не дублирует её', () => {
    const storage = memoryStorage();
    const saver = createPositionSaver(BOOK, storage);

    saver.schedule({ chapter: 1, block: 1, scrollY: 1 });
    saver.flush();
    vi.advanceTimersByTime(SAVE_INTERVAL_MS * 3);

    expect(storage.raw.size).toBe(1);
  });

  it('таймер не переживает следующую позицию', () => {
    const storage = memoryStorage();
    const saver = createPositionSaver(BOOK, storage);

    saver.schedule({ chapter: 0, block: 1, scrollY: 1 });
    vi.advanceTimersByTime(SAVE_INTERVAL_MS - 10);
    saver.schedule({ chapter: 0, block: 2, scrollY: 2 });
    vi.advanceTimersByTime(SAVE_INTERVAL_MS - 10);

    // Вторая позиция пришла незакрыто: она должна пережить в том же окне, а не
    // ждать следующей секунды, иначе при быстрой прокрутке теряется конец.
    expect(readPosition(BOOK, storage)?.block).toBe(2);
  });
});