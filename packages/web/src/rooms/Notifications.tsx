import { useToast } from '../components/ui/Toast.js';
import { useRoomSocket } from './useRoomSocket.js';
import { describeNotification } from './room-notifications.js';
import type { WireNotification } from '../api/types.js';

/**
 * Показ уведомлений тостами.
 *
 * ─── Почему это компонент, а не хук в каждой странице ────────────────────────
 *
 * Тосты нужны везде, а хук вызывался бы в каждой странице, и каждая должна была
 * бы помнить про `notification:new`. Одна забытая подписка означала бы, что на
 * этой странице уведомления не появляются, — и это выглядело бы как ошибка
 * сервера. Здесь подписка одна, и её нельзя забыть: компонент стоит в каркасе.
 *
 * ─── Что с этим делает страница ──────────────────────────────────────────────
 *
 * Тост — только видимая часть. Комната, в которую человека приняли, должна
 * появиться в его лобби, поэтому страница передаёт `onRoomEvent` и
 * перезапрашивает свои данные. Уведомление само этого не сделает.
 */
export function Notifications({
  onRoomEvent,
}: {
  /** Комната, к которой относится событие. */
  onRoomEvent?: (roomId: string, note: WireNotification) => void;
}) {
  const toast = useToast();

  useRoomSocket({
    onNotification: (note) => {
      const { text, tone } = describeNotification(note);
      if (tone === 'error') toast.error(text);
      else toast.info(text);

      const roomId = note.payload.roomId;
      if (roomId !== undefined) onRoomEvent?.(roomId, note);
    },
  });

  return null;
}

/**
 * Человека только что впустили.
 *
 * Правило одно и используется в двух местах, а разойтись оно не должно: иначе
 * в лобби комната появилась бы, а на странице поиска кнопка осталась бы
 * «Запрос отправлен».
 */
export function isAdmitted(note: WireNotification): boolean {
  return note.type === 'added' || note.type === 'join_approved';
}

/**
 * Человека только что исключили из этой комнаты.
 *
 * Страница комнаты на такое уведомление уходит в лобби: открывать комнату после
 * исключения бессмысленно, сервер отдаст 403.
 */
export function isEvicted(note: WireNotification, roomId: string): boolean {
  return note.type === 'kicked' && note.payload.roomId === roomId;
}

/**
 * В этой комнате появилась заявка.
 *
 * Страница комнаты перезапрашивает список заявок и поднимает индикатор на
 * вкладке. Кто именно подал — неважно: человеку в комнате интересно, что
 * заявка вообще есть.
 */
export function isJoinRequest(note: WireNotification, roomId: string): boolean {
  return note.type === 'join_request' && note.payload.roomId === roomId;
}

/**
 * На мою заявку ответили.
 *
 * Поиск по нему снимает надпись «Запрос отправлен» и возвращает кнопку: иначе
 * человек видел бы вечное «ждём ответа» на уже отклонённую заявку.
 */
export function isMyRequestAnswered(note: WireNotification): boolean {
  return note.type === 'join_approved' || note.type === 'join_rejected';
}

/** Текст уведомления. Используется в тестах и в отладке тоста. */
export function notificationTitle(note: WireNotification): string {
  return describeNotification(note).text;
}