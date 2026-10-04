import type { Socket } from 'socket.io';
import { prisma } from '../db/client.js';
import { memberRole } from '../rooms/membership.js';
import {
  channelOf,
  presenceChanged,
  presenceLeft,
} from './broadcast.js';
import {
  MAX_PRESENCE_IN_ROOM,
  type ClientToServerEvents,
  type JoinResult,
  type ServerToClientEvents,
  type SocketData,
} from './types.js';
import {
  clearPresence,
  clearUserEverywhere,
  presenceInRoom,
  setPresence,
  type PresenceOut,
} from './presence.js';
import { logger } from '../lib/logger.js';

/**
 * Обработчики событий комнаты.
 *
 * ─── Проверка членства на каждое событие, а не только на входе ───────────────
 *
 * Человек мог быть исключён или вышедший удалён, пока сокет жив. Если проверять
 * членство только в `room:join`, такой сокет продолжил бы получать события
 * комнаты, в которой он больше не состоит.
 *
 * Стоимость — один запрос по индексу `@@unique([roomId, userId])` на событие.
 * Присутствие и так шлётся на каждое перелистывание, и это не делает сокет
 * дорогим: узкое место здесь — интерфейс, а не база.
 */

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

/** Положение приходит от клиента: проверяем форму, а не содержимое. */
function readPosition(payload: unknown): {
  positionType: 'text' | 'timestamp';
  positionData: Record<string, unknown>;
} | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as Record<string, unknown>;

  const positionType = raw['positionType'];
  if (positionType !== 'text' && positionType !== 'timestamp') return null;

  const positionData = raw['positionData'];
  if (typeof positionData !== 'object' || positionData === null || Array.isArray(positionData)) {
    return null;
  }

  return { positionType, positionData: positionData as Record<string, unknown> };
}

function toEntry(out: PresenceOut) {
  return {
    userId: out.userId,
    displayName: out.displayName,
    avatar: out.avatar,
    roomId: out.roomId,
    positionType: out.positionType,
    positionData: out.positionData,
    updatedAt: out.updatedAt,
  };
}

export function registerRoomHandlers(socket: TypedSocket): void {
  const user = socket.data.user;

  /**
   * Комнаты этого сокета, которые мы помним сами.
   *
   * У Socket.IO к моменту события `disconnect` список `socket.rooms` уже пуст:
   * сокет покидает все комнаты раньше, чем приходит событие. Наблюдалось как
   * `rooms: 0` в логе при обрыве подключённого сокета — из-за этого
   * `presence:left` не уходил никому.
   *
   * Поэтому список ведётся здесь: при входе добавляется, при выходе и при обрыве
   * очищается. Один источник правды вместо попытки разгадать порядок событий
   * внутри библиотеки.
   */
  const joined = new Set<string>();

  // ─── Вход в комнату ─────────────────────────────────────────────────────────

  socket.on('room:join', async (payload, ack) => {
    const reply: JoinResult = { ok: false };

    try {
      const roomId =
        typeof payload === 'object' && payload !== null
          ? (payload as { roomId?: unknown }).roomId
          : undefined;
      if (typeof roomId !== 'string' || roomId === '') {
        reply.error = 'Не указана комната';
        ack(reply);
        return;
      }

      // Чужая комната — отказ, а не пустой ответ. Иначе по различию «вход
      // прошёл» и «вход не прошёл» можно было бы перебирать идентификаторы.
      if ((await memberRole(prisma, roomId, user.id)) === null) {
        reply.error = 'Вы не участник этой комнаты';
        ack(reply);
        return;
      }

      await socket.join(channelOf(roomId));
      joined.add(roomId);

      // Локальная переменная, а не поле ответа: поле необязательное, и
      // TypeScript правомерно не дал бы его перебрать без проверки.
      const members = presenceInRoom(roomId, MAX_PRESENCE_IN_ROOM).map(toEntry);

      reply.ok = true;
      reply.members = members;
      ack(reply);

      // Новичку отдаём список присутствия в комнате: его «сокет только что
      // подключился», и без этого он был бы один в списке, пока остальные не
      // двинули страницу.
      for (const member of members) {
        if (member.userId !== user.id) {
          socket.emit('presence:changed', member);
        }
      }
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'room:join не удался');
      reply.error = 'Не удалось войти в комнату';
      ack(reply);
    }
  });

  // ─── Выход из комнаты ───────────────────────────────────────────────────────

  /**
   * `socket.leave` снимает подписку, но **не** убирает присутствие из карты:
   * человек мог закрыть вкладку комнаты, оставив вкладку с уведомлениями, и
   * тогда его перестало бы быть видно, хотя он всё ещё читает.
   */
  socket.on('room:leave', async (payload) => {
    const roomId =
      typeof payload === 'object' && payload !== null
        ? (payload as { roomId?: unknown }).roomId
        : undefined;
    if (typeof roomId !== 'string' || roomId === '') return;

    await socket.leave(channelOf(roomId));
    joined.delete(roomId);
    clearPresence(user.id, roomId);
    presenceLeft(roomId, user.id);
    socket.emit('room:left', { roomId });
  });

  // ─── Присутствие ────────────────────────────────────────────────────────────

  /**
   * Обновление положения.
   *
   * Ответ не отправляется: клиенту не нужно подтверждение, ему нужно увидеть
   * у себя в интерфейсе подтверждённое положение. А оно придёт в общем
   * `presence:changed`, которое получит и сам отправитель.
   *
   * Если не throttle-ить на клиенте, событие будет уходить на каждое движение
   * мыши; серверная запись в базу от этого отделена троттлингом в 15 секунд.
   */
  socket.on('presence:update', async (payload) => {
    try {
      if (typeof payload !== 'object' || payload === null) return;
      const roomId = (payload as { roomId?: unknown }).roomId;
      if (typeof roomId !== 'string' || roomId === '') return;

      const position = readPosition(payload);
      if (position === null) return;

      // Повторная проверка членства: между входом и этим событием человека
      // могли удалить из комнаты, и подписка бы осталась.
      if ((await memberRole(prisma, roomId, user.id)) === null) {
        await socket.leave(channelOf(roomId));
        clearPresence(user.id, roomId);
        presenceLeft(roomId, user.id);
        return;
      }

      const slot = setPresence(
        user.id,
        roomId,
        user.displayName,
        user.avatar,
        position.positionType,
        position.positionData,
      );

      presenceChanged(roomId, {
        userId: slot.userId,
        displayName: slot.displayName,
        avatar: slot.avatar,
        roomId: slot.roomId,
        positionType: position.positionType,
        positionData: position.positionData,
        updatedAt: slot.updatedAt.toISOString(),
      });
    } catch (error) {
      logger.warn({ err: error, userId: user.id }, 'presence:update не обработан');
    }
  });

  // ─── Обрыв ──────────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    // Комнаты берём из своего списка, а не из `socket.rooms`: к моменту события
    // Socket.IO уже снял сокет со всех комнат, и список пуст.
    for (const roomId of joined) {
      clearPresence(user.id, roomId);
      presenceLeft(roomId, user.id);
    }
    joined.clear();

    // Подчистка на случай, если событие `room:leave` не успел отработать или
    // присутствие осталось от другой вкладки.
    for (const entry of clearUserEverywhere(user.id)) {
      presenceLeft(entry.roomId, entry.userId);
    }

    logger.debug({ userId: user.id, socketId: socket.id, rooms: joined.size }, 'сокет отключён');
  });

}
