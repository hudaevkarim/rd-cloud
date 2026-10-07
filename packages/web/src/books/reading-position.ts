/**
 * Позиция чтения — в `localStorage`, по одному ключу на книгу.
 *
 * ─── Почему личное, а не через сервер ─────────────────────────────────────────
 *
 * Позиция — это «где я остановился», и она ничего не значит для другого
 * человека. Пока она личная, синхронизация в подэтапе 7.4.3 — отдельное
 * решение с сокетом; если бы она сразу пошла на сервер, пришлось бы сначала
 * придумать формат хранения, а потом ещё и переделывать его.
 *
 * ─── Почему блок, а не только глава ───────────────────────────────────────────
 *
 * Главы в книгах бывают длинными: одна глава «Войны и мира» — это десятки
 * экранов. Сохраняя только номер главы, человек возвращался бы в начало главы
 * и искал глазами, где он остановился. Номер блока внутри главы попадает
 * ровно туда.
 *
 * ─── Почему `scrollY` рядом с блоком ──────────────────────────────────────────
 *
 * Два числа, а не одно. Блок — это точка в тексте, и он переживает смену
 * размера шрифта. `scrollY` — точка на экране, и она нужна, чтобы вернуть
 * человека туда же «глазами», если он читал не с начала блока. Порядок
 * восстановления: сначала блок, и только если он не нашёлся — экран.
 */
export interface ReadingPosition {
  chapter: number;
  block: number;
  scrollY: number;
  /** Метка времени: без неё не отличить свежую запись от допотопной. */
  updatedAt: number;
}

const PREFIX = 'rd.read.';
const VERSION = 1;

/** Как хранилище отдаётся наружу: в тестах это словарь, а не `window`. */
export interface PositionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Ключ под книгу.
 *
 * `bookId` уже уникален, но с префиксом и версией: без версии смена формата
 * читала бы старую запись новым кодом, а молча испорченная позиция хуже
 * отсутствующей — человек вернулся бы не туда и не понял бы почему.
 */
export function positionKey(bookId: string): string {
  return `${PREFIX}${bookId}.v${VERSION}`;
}

/**
 * Прочитать позицию.
 *
 * `null` при любой негодности — и при битом JSON, и при записи чужой версии.
 * Позиция не критична: потеря её означает, что человек откроет книгу с
 * начала, и это переживёт, а падение на разборе означало бы, что страница
 * не открывается вовсе.
 */
export function readPosition(bookId: string, storage: PositionStorage): ReadingPosition | null {
  let raw: string | null;
  try {
    raw = storage.getItem(positionKey(bookId));
  } catch {
    // Приватный режим Safari и запрещённые куки: `localStorage` бросает на
    // обращении, а не на открытии.
    return null;
  }
  if (raw === null || raw === '') return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Partial<ReadingPosition>;
    if (
      typeof value.chapter !== 'number' ||
      typeof value.block !== 'number' ||
      typeof value.scrollY !== 'number' ||
      typeof value.updatedAt !== 'number'
    ) {
      return null;
    }
    // Отрицательные номера глав и блоков — это не «где я был», а испорченная
    // запись: по ним нельзя ни открыть главу, ни найти блок.
    if (!Number.isInteger(value.chapter) || !Number.isInteger(value.block)) return null;
    if (value.chapter < 0 || value.block < 0 || value.scrollY < 0) return null;
    return {
      chapter: value.chapter,
      block: value.block,
      scrollY: value.scrollY,
      updatedAt: value.updatedAt,
    };
  } catch {
    return null;
  }
}

/** Записать позицию. Молча: потеря позиции не должна прерывать чтение. */
export function writePosition(
  bookId: string,
  position: Omit<ReadingPosition, 'updatedAt'>,
  storage: PositionStorage,
  now: number = Date.now(),
): void {
  try {
    storage.setItem(positionKey(bookId), JSON.stringify({ ...position, updatedAt: now }));
  } catch {
    // Квота исчерпана или хранилище запрещено. Позиция — удобство, а не
    // условие чтения, и из-за неё страница обязана продолжать работать.
  }
}

/**
 * Частота записи: раз в секунду.
 *
 * Запись на каждый кадр прокрутки означала бы сотни записей в минуту, и на
 * телефоне это заметно по батарее. Раз в секунду — чаще, чем человек
 * возвращается к месту потерянной страницы.
 */
export const SAVE_INTERVAL_MS = 1000;

/**
 * Отложенная запись.
 *
 * Таймер не на каждый кадр, а один: последняя позиция до ухода со страницы всё
 * равно должна записаться, и поставить её должен сам таймер, а не событие
 * `pagehide` — оно на телефоне может не прийти вовсе.
 */
export function createPositionSaver(bookId: string, storage: PositionStorage) {
  let timer: number | null = null;
  let latest: Omit<ReadingPosition, 'updatedAt'> | null = null;

  const flush = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    if (latest !== null) {
      writePosition(bookId, latest, storage);
      latest = null;
    }
  };

  return {
    /** Отметить позицию: запишется не позже чем через секунду. */
    schedule(position: Omit<ReadingPosition, 'updatedAt'>): void {
      latest = position;
      if (timer !== null) return;
      timer = window.setTimeout(flush, SAVE_INTERVAL_MS);
    },
    /** Записать немедленно: уход со страницы, смена главы, отдача фокуса. */
    flush,
  };
}