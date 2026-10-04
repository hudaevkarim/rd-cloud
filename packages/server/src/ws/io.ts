import { Server } from 'socket.io';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { hashToken } from '../auth/tokens.js';
import { setNotificationEmitter } from '../lib/notify.js';
import type { Prisma, User } from '../generated/prisma/client.js';
import { registerRoomHandlers } from './rooms.js';
import { setIo, notificationTo, userChannelOf } from './broadcast.js';
import { setPresenceWriter, flushPresence } from './presence.js';
import type { ClientToServerEvents, ServerToClientEvents, SocketData, SocketUser } from './types.js';

/**
 * Сервер сокетов на том же HTTP-сервере, что и Fastify.
 *
 * ─── Почему отдельного порта не нужно и конфликта не будет ───────────────────
 *
 * `engine.io` при подключении снимает слушатели `request` у HTTP-сервера,
 * ставит свой, а в нём возвращает всё, что не начинается с `/socket.io`,
 * прежним слушателям. То есть Fastify продолжает обслуживать API и раздачу
 * файлов без всяких правок. Это документированная схема, а не совпадение.
 *
 * Два нюанса, из-за которых это перестаёт быть очевидным:
 *
 * 1. У сокета **свой** CORS. Плагин `@fastify/cors` не дотягивается до
 *    `/socket.io`, и без явного `cors` браузер отклонил бы рукопожатие —
 *    причём только в режиме polling, а с WebSocket сокет молча не подключится.
 *
 * 2. Сервер сокетов держит таймеры и открытые дескрипторы. Без `close()` при
 *    остановке процесс не завершится: Fastify закроет свой сервер, а `engine.io`
 *    останется слушать.
 */

/** Куда вклинивается сокет. Стандартный путь, совпадает с клиентским. */
const SOCKET_PATH = '/socket.io';

/**
 * Токен из рукопожатия.
 *
 * Два источника, потому что живут два разных клиента: в браузере cookie едет
 * сама, а в Node-скриптах и мобильных обёртках её может не быть, и токен
 * передаётся в `auth`.
 *
 * `?t=` в адресе здесь не читается намеренно: рукопожатие не проходит через
 * Fastify, и разбирать строку запроса пришлось бы вручную, а токен в адресе
 * оседает в логах и истории. Для сокета есть `auth`.
 *
 * Cookie разбирается прямо здесь, а не берётся из `@fastify/cookie`: у сокета
 * нет `request`, доступна только сырая строка заголовка. Парсер плагина
 * рассчитан на `request.cookies`, и подключать ради этого плагин к сокету
 * незачем.
 */

/** Имя cookie совпадает с тем, что ставит `POST /api/auth/login`. */
const TOKEN_COOKIE = 'rd_token';

function tokenFromCookies(header: string | undefined): string | null {
  if (header === undefined || header === '') return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== TOKEN_COOKIE) continue;

    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Значение cookie приходит из `serializeCookie`, то есть URL-экранировано.
      // Если оно не декодируется — значит, это не наша cookie, и продолжать
      // незачем: исходная строка всё равно не совпадёт с хешем токена.
      continue;
    }
    if (value !== '') return value;
  }
  return null;
}

function tokenFromHandshake(
  headers: Record<string, string | string[] | undefined>,
  auth: unknown,
): string | null {
  if (typeof auth === 'object' && auth !== null) {
    const value = (auth as { token?: unknown }).token;
    if (typeof value === 'string' && value !== '') return value;
  }

  const raw = headers['cookie'];
  return tokenFromCookies(Array.isArray(raw) ? raw.join('; ') : raw);
}

/**
 * Подключение и проверка токена.
 *
 * Проверка именно здесь, в middleware, а не в обработчиках: соединение без
 * токена не должно доходить ни до одного события. Иначе пришлось бы повторять
 * проверку в каждом обработчике, и одна забытая строка означала бы анонимный
 * доступ к комнате.
 */
export async function createSocketServer(httpServer: import('node:http').Server): Promise<Server> {
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    path: SOCKET_PATH,
    // Отдельно от плагина Fastify: до этого пути он не достаёт.
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    // Комната на переподключении восстанавливается через `room:join`: полагаться
    // на восстановление состояния сокета значило бы считать, что оно есть.
    connectionStateRecovery: undefined,
  });

  io.use(async (socket, next) => {
    try {
      const token = tokenFromHandshake(
        socket.handshake.headers as Record<string, string | string[] | undefined>,
        socket.handshake.auth,
      );
      if (token === null) {
        // Текст ошибки попадает в `connect_error` на клиенте. Он же — причина
        // отказа в логах клиента, поэтому должен быть осмысленным, а не
        // «Error».
        next(new Error('unauthorized'));
        return;
      }

      const user = await prisma.user.findUnique({
        where: { tokenHash: hashToken(token) },
        select: { id: true, username: true, displayName: true, avatar: true, role: true },
      });
      if (user === null) {
        next(new Error('unauthorized'));
        return;
      }

      socket.data.user = user satisfies SocketUser;
      next();
    } catch (error) {
      logger.error({ err: error }, 'ошибка проверки токена при рукопожатии');
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;

    // Персональный канал: в него уходят уведомления, и подписка происходит
    // один раз при подключении, а не в обработчике каждого события. Без неё
    // уведомление оставшемуся человеку ушло бы в никуда.
    void socket.join(userChannelOf(user.id));
    socket.emit('server:ready', { userId: user.id });

    registerRoomHandlers(socket);

    logger.debug({ userId: user.id, socketId: socket.id }, 'сокет подключён');
  });

  // ─── Присутствие в базе ─────────────────────────────────────────────────────
  //
  // Присутствие сбрасывается пачками, потому что оно меняется на каждое
  // перелистывание абзаца, а записывать по одной строке на каждое событие —
  // значит нагружать базу темпом чтения.

  setPresenceWriter(async (rows) => {
    for (const row of rows) {
      // Приведение — на границе JSON, и именно здесь оно честное: `positionData`
      // проверен на входе как «объект без массива», а Prisma требует свой тип для
      // колонки `Json`. Значения внутри приходят от клиента, поэтому в базу
      // попадает ровно то, что прислали, — но записать это можно только через
      // JSON-сериализацию Postgres, и она отбросит значения, которые JSON не
      // умеет (`undefined`, функции, BigInt).
      const positionData = row.positionData as unknown as Prisma.InputJsonValue;

      await prisma.presence.upsert({
        where: { userId_roomId: { userId: row.userId, roomId: row.roomId } },
        create: {
          userId: row.userId,
          roomId: row.roomId,
          positionType: row.positionType,
          positionData,
        },
        update: { positionType: row.positionType, positionData },
      });
    }
  });

  // Уведомления из REST уходят в персональный канал. Эмит получает готовую
  // запись, поэтому дополнительного запроса не требуется: идентификатор и
  // метка времени уже известны.
  setNotificationEmitter((row) => {
    notificationTo(row.userId, {
      id: row.id,
      type: row.type,
      payload: row.payload as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    });
  });

  setIo(io);
  return io;
}

/**
 * Остановка сервера сокетов.
 *
 * Порядок: сначала закрываем соединения, потом присутствие, потом сам сервер.
 * Наоборот — таймер сброса остался бы работать и не дал бы процессу завершиться.
 */
export async function closeSocketServer(io: Server): Promise<void> {
  setIo(null);
  setNotificationEmitter(null);
  setPresenceWriter(null);

  await flushPresence();
  await io.close();

  logger.info('сервер сокетов остановлен');
}

/** Тип пользователя, как его видит защита REST. Совпадает с сокетным. */
export type AuthenticatedUser = User;
