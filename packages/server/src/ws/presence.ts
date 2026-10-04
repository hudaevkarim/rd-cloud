import { logger } from '../lib/logger.js';

/**
 * Присутствие: кто где сейчас.
 *
 * ─── Почему два слоя ─────────────────────────────────────────────────────────
 *
 * В памяти — чтобы «кто читает третью главу» обновлялось мгновенно. В базе —
 * чтобы после перезагрузки страницы список не был пустым. Сбрасывается раз в
 * 15 секунд, потому что чаще только создаёт записи: открытая книга шлёт
 * обновление на каждое перелистывание абзаца.
 *
 * Всё держится в памяти процесса, и это осознанный выбор для одной ноты.
 * Администратор один, читателей несколько, переживать перезапуск нечего:
 * после рестарта список пуст до первого обновления, и комнаты покажут «никого
 * не читает», что правдой не является, но и не опаснее нуля человек.
 *
 * Обращение к `Map<userId, …>` осознанно скрыто за функциями модуля: порядок
 * обхода `Map` — это порядок вставки, и если бы кто-то начал полагаться на него
 * при выдаче списка, участники комнаты перечислялись бы по времени первого
 * входа, а не по времени последнего обновления.
 */

/**
 * Ключ — `${userId}:${roomId}`.
 *
 * Составной, а не `userId`: у человека открыто несколько вкладок, и присутствие
 * в двух комнатах не должны затирать друг друга. Иначе переключение комнаты
 * во второй вкладке выкидывало бы человека из первой.
 */
interface Slot {
  userId: string;
  roomId: string;
  displayName: string;
  avatar: string | null;
  positionType: 'text' | 'timestamp';
  positionData: Record<string, unknown>;
  updatedAt: Date;
}

/** Актуальное состояние; обновляется на каждое событие. */
const slots = new Map<string, Slot>();

/**
 * Кто изменился с прошлого сброса.
 *
 * Отдельный набор от `slots`: иначе в базу ушёл бы весь список при каждом
 * обновлении, и смысл троттлинга пропал бы.
 */
const dirty = new Map<string, Slot>();

/** Сброс по расписанию: один таймер на процесс, а не на пользователя. */
let flushTimer: NodeJS.Timeout | null = null;

function key(userId: string, roomId: string): string {
  return `${userId}:${roomId}`;
}

/** Замена или создание присутствия. Возвращает итоговое состояние. */
export function setPresence(
  userId: string,
  roomId: string,
  displayName: string,
  avatar: string | null,
  positionType: 'text' | 'timestamp',
  positionData: Record<string, unknown>,
): Slot {
  const slot: Slot = {
    userId,
    roomId,
    displayName,
    avatar,
    positionType,
    positionData,
    updatedAt: new Date(),
  };
  const k = key(userId, roomId);
  slots.set(k, slot);
  dirty.set(k, slot);
  scheduleFlush();
  return slot;
}

/**
 * Убрать человека из комнаты.
 *
 * Возвращает снятое присутствие, чтобы вызывающий знал, что и кому объявлять.
 */
export function clearPresence(userId: string, roomId: string): Slot | null {
  const k = key(userId, roomId);
  const slot = slots.get(k);
  if (slot === undefined) return null;
  slots.delete(k);
  dirty.delete(k);
  return slot;
}

/**
 * Убрать человека из всех комнат.
 *
 * Вызывается при обрыве соединения. Комнаты узнаются из `socket.data`, а не из
 * присутствия: вкладка могла закрыться, ни разу не обновив позицию, и тогда
 * в присутствии её не было — но вкладка была, и комнаты о ней помнят.
 */
export function clearUserEverywhere(userId: string): PresenceOut[] {
  const removed: PresenceOut[] = [];
  for (const [k, slot] of slots) {
    if (slot.userId !== userId) continue;
    slots.delete(k);
    dirty.delete(k);
    removed.push(toPresenceOut(slot));
  }
  return removed;
}

/** Присутствующие в комнате. */
export function presenceInRoom(roomId: string, limit: number): PresenceOut[] {
  const out: PresenceOut[] = [];
  for (const slot of slots.values()) {
    if (slot.roomId !== roomId) continue;
    out.push(toPresenceOut(slot));
    if (out.length >= limit) break;
  }
  return out;
}

export interface PresenceOut {
  userId: string;
  displayName: string;
  avatar: string | null;
  roomId: string;
  positionType: 'text' | 'timestamp';
  positionData: Record<string, unknown>;
  updatedAt: string;
}

function toPresenceOut(slot: Slot): PresenceOut {
  return {
    userId: slot.userId,
    displayName: slot.displayName,
    avatar: slot.avatar,
    roomId: slot.roomId,
    positionType: slot.positionType,
    positionData: slot.positionData,
    updatedAt: slot.updatedAt.toISOString(),
  };
}

/**
 * Запись в базу.
 *
 * Передаётся отдельно, а не импортируется: модуль присутствия ничего не знает
 * о базе и проверяется без неё. Инъекция функции держит его честным.
 */
export type PresenceWriter = (rows: Array<{
  userId: string;
  roomId: string;
  positionType: 'text' | 'timestamp';
  positionData: Record<string, unknown>;
}>) => Promise<void>;

let writer: PresenceWriter | null = null;

export function setPresenceWriter(fn: PresenceWriter | null): void {
  writer = fn;
}

function scheduleFlush(): void {
  if (flushTimer !== null || writer === null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPresence();
  }, 15_000);
  // Таймер не должен удерживать процесс при остановке: закрытие сервера
  // сбрасывает присутствие само, а висящий таймер заставил бы ждать.
  flushTimer.unref();
}

/** Немедленный сброс. Вызывается при остановке сервера. */
export async function flushPresence(): Promise<void> {
  if (writer === null || dirty.size === 0) return;

  // Список забирается до записи: во время записи могут прийти обновления, и
  // их нельзя потерять — они в `dirty` останутся до следующего сброса.
  const batch = [...dirty.values()];
  dirty.clear();

  try {
    await writer(
      batch.map((slot) => ({
        userId: slot.userId,
        roomId: slot.roomId,
        positionType: slot.positionType,
        positionData: slot.positionData,
      })),
    );
  } catch (error) {
    // Не сбрасываем обратно в `dirty`: при устойчивой ошибке это дало бы
    // бесконечные повторы и растущий список. Присутствие восстановится при
    // следующем обновлении от клиента.
    logger.warn({ err: error, count: batch.length }, 'присутствие не сохранено');
  }
}

/** Полный сброс. Только для тестов и остановки сервера. */
export function resetPresence(): void {
  slots.clear();
  dirty.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
