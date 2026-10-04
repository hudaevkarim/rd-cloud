import type { Server } from 'socket.io';
import type { PresenceEntry, WireComment } from './types.js';

/**
 * Рассылка событий.
 *
 * ─── Почему исключается пользователь, а не сокет ─────────────────────────────
 *
 * Обычно это делают через `socket.to(room).emit`: сокет отправителя исключается,
 * потому что у него объект уже есть. Но комментарий создаётся через **REST**, и
 * сокета, который его создал, у маршрута нет.
 *
 * `io.to(room).except(userId)` — аналог для этого случая, и он даже точнее:
 * исключаются все вкладки автора. Если человек открыл ленту в двух вкладках и
 * создал комментарий в одной, вторая тоже не получит событие — а получит его,
 * и комментарий появится там дважды: из ответа REST и из вещания.
 *
 * Внутри сокетных обработчиков, где сокет есть, смысл тот же, и там
 * исключение пользователя остаётся правильным выбором.
 *
 * ─── Молчаливый отказ ────────────────────────────────────────────────────────
 *
 * Если сокеты не подключены (REST-тесты, `buildServer` без `index.ts`), вызов
 * ничего не делает. Ошибку бросать нельзя: маршруту комментария неинтересно,
 * работает ли в этой сборке вещание.
 */

/**
 * Экземпляр сервера сокетов.
 *
 * Модульная переменная, а не параметр во всех функциях: рассылку вызывают
 * маршруты REST, у которых нет доступа к сокетному серверу, а прокидывать его
 * через `request` значило бы связывать два подсистемы, которые должны быть
 * независимы.
 */
let io: Server | null = null;

export function setIo(server: Server | null): void {
  io = server;
}

export function getIo(): Server | null {
  return io;
}

/** Имя комнаты сокета для комнаты rd. Префикс отделяет от персональных. */
export function channelOf(roomId: string): string {
  return `room:${roomId}`;
}

/** Имя персонального канала пользователя. */
export function userChannelOf(userId: string): string {
  return `user:${userId}`;
}

/**
 * Комментарий создан.
 *
 * Исключается **персональный канал** автора, а не его идентификатор.
 *
 * `BroadcastOperator.except()` принимает имя комнаты, а не socket id и не
 * userId: он добавляет комнату в список исключённых. Передав `authorId`, мы
 * исключали комнату, в которую не подписан никто, — то есть не исключали
 * ничего, и автор получал вещание собственного комментария. Проверено
 * скриптом: без правильного канала автор видел `comment:new` от себя.
 *
 * Исключать `user:<id>` корректно: каждый подписывается на свой канал при
 * подключении, и все вкладки автора отпадают разом.
 */
export function commentCreated(
  roomId: string,
  bookId: string,
  comment: WireComment,
  authorId: string,
): void {
  const server = io;
  if (server === null) return;
  server
    .to(channelOf(roomId))
    .except(userChannelOf(authorId))
    .emit('comment:new', { roomId, bookId, comment });
}

/**
 * Комментарий изменён.
 *
 * Исключений нет: у автора правки объект уже новый, но если он правил на одной
 * вкладке, на второй полезна синхронизация.
 */
export function commentUpdated(roomId: string, comment: WireComment): void {
  io?.to(channelOf(roomId)).emit('comment:updated', { roomId, comment });
}

/**
 * Комментарий удалён.
 *
 * Исключений нет, и это важно: исключение автора оставило бы удалённый
 * комментарий висеть во второй его вкладке. Пусть лучше придёт лишнее событие.
 */
export function commentDeleted(roomId: string, commentId: string): void {
  io?.to(channelOf(roomId)).emit('comment:deleted', { roomId, commentId });
}

/** Реакция поставлена или снята. */
export function reactionChanged(
  roomId: string,
  comment: WireComment,
  active: boolean,
  userId: string,
): void {
  const server = io;
  if (server === null) return;
  // Тот же персональный канал, а не идентификатор: см. комментарий в
  // `commentCreated` — `except()` ждёт имя комнаты.
  server
    .to(channelOf(roomId))
    .except(userChannelOf(userId))
    .emit('reaction:changed', { roomId, comment, active, userId });
}

/**
 * Присутствие человека изменилось.
 *
 * Без исключения отправителя, в отличие от комментариев: событие подтверждает
 * серверную позицию, и клиент обязан увидеть и свою собственную — по нему он
 * понимает, что дошёл до нужного места, а не висит на старом.
 */
export function presenceChanged(roomId: string, entry: PresenceEntry): void {
  io?.to(channelOf(roomId)).emit('presence:changed', entry);
}

/** Человек ушёл из комнаты. */
export function presenceLeft(roomId: string, userId: string): void {
  io?.to(channelOf(roomId)).emit('presence:left', { userId, roomId });
}

/**
 * Персональное уведомление.
 *
 * Отправляется всем вкладкам получателя: они все о нём и есть.
 */
export function notificationTo(
  userId: string,
  payload: { id: string; type: string; payload: Record<string, unknown>; createdAt: string },
): void {
  io?.to(userChannelOf(userId)).emit('notification:new', payload);
}

/** Для диагностики при старте. */
export function debugIo(): string {
  return io === null ? 'не подключено' : `подключено, комнат: ${io.sockets.adapter.rooms.size}`;
}
