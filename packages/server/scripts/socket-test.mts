// Подключение тестовой базы обязано быть первым: подмена `DATABASE_URL` должна
// произойти до того, как `src/db/client.js` создаст клиента Prisma.
import './use-test-db.mts';

import { randomUUID } from 'node:crypto';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { buildServer } from '../src/app.js';
import { connectDatabase, disconnectDatabase, prisma } from '../src/db/client.js';
import { createSocketServer, closeSocketServer } from '../src/ws/io.js';
import { hashToken } from '../src/auth/tokens.js';
import { resetPresence } from '../src/ws/presence.js';

/**
 * Проверка сокетов двумя клиентами.
 *
 * Почему скрипт, а не vitest: `app.inject()` не поднимает сервер на порт, а
 * Socket.IO нужен настоящий HTTP. Серверные тесты остаются на `inject`, а сокеты
 * проверяются здесь — один раз, целиком, с двумя клиентами одновременно.
 *
 * Проверяется то, что иначе сломается незаметно:
 *
 *   - рукопожатие отклоняется без токена;
 *   - `comment:new` доходит до второго клиента и **не** возвращается автору;
 *   - присутствие обновляется у обоих и уходит при обрыве;
 *   - в чужую комнату не войти.
 *
 * Данные для проверки создаются прямо в базе, а не через REST: скрипту не нужен
 * администратор, а в CI токен администратора не существует — он выдаётся при
 * сидировании и нигде не сохраняется.
 *
 * Запуск: npm run test:socket
 */

const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;

/** Текстовый якорь: глава 0, блок 0, выделение «Ветер». */
const TEXT_ANCHOR = {
  kind: 'text',
  chapterIndex: 0,
  blockIndex: 0,
  start: 0,
  end: 5,
  quote: 'Ветер',
  prefix: '',
  suffix: ' гулял',
};

let passed = 0;
let failed = 0;

/** Проверка с выводом: в CI нужен читаемый лог, а не только код возврата. */
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * Ожидание события с таймаутом.
 *
 * Таймаут обязателен: без него висящий сокет выдавал бы бесконечное ожидание
 * вместо внятного падения, и в CI это выглядело бы как «шаг завис».
 */
function waitFor<T>(socket: ClientSocket, event: string, ms = 5_000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);

    function handler(payload: T): void {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

function emitWithAck<T>(socket: ClientSocket, event: string, payload: unknown, ms = 5_000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.emit(event as never, payload as never, ((response: T) => {
      clearTimeout(timer);
      resolve(response);
    }) as never);
  });
}

/**
 * Подключение клиента; при неудаче возвращает `null` вместе с причиной.
 *
 * `onSocket` вызывается **синхронно** сразу после создания сокета и до
 * ожидания подключения. Это единственный способ не пропустить событие,
 * которое сервер шлёт в момент соединения: `server:ready` прилетает раньше, чем
 * сработает обработчик `connect`, и подписка после `connect` уже поздняя.
 */
async function connect(
  token: string | null,
  onSocket?: (socket: ClientSocket) => void,
): Promise<{ socket: ClientSocket | null; error: string | null }> {
  const socket = ioClient(BASE, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5_000,
    auth: token === null ? {} : { token },
    extraHeaders: {},
  });
  onSocket?.(socket);

  const result = await new Promise<{ ok: boolean; error: string | null }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'таймаут подключения' }), 6_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ ok: true, error: null });
    });
    socket.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });

  return result.ok ? { socket, error: null } : { socket: null, error: result.error };
}

async function main(): Promise<void> {
  console.log('Проверка Socket.IO');

  await connectDatabase();

  // ─── Данные ─────────────────────────────────────────────────────────────────
  const suffix = randomUUID().slice(0, 8);
  const aliceToken = `alice_${suffix}_${randomUUID()}`;
  const bobToken = `bob_${suffix}_${randomUUID()}`;
  const carolToken = `carol_${suffix}_${randomUUID()}`;

  const alice = await prisma.user.create({
    data: { username: `alice_${suffix}`, displayName: 'Алиса', tokenHash: hashToken(aliceToken) },
    select: { id: true },
  });
  const bob = await prisma.user.create({
    data: { username: `bob_${suffix}`, displayName: 'Борис', tokenHash: hashToken(bobToken) },
    select: { id: true },
  });
  // Кэрол — посторонняя: в комнату не состоит, и это должно мешать.
  const carol = await prisma.user.create({
    data: { username: `carol_${suffix}`, displayName: 'Кэрол', tokenHash: hashToken(carolToken) },
    select: { id: true },
  });

  const room = await prisma.room.create({
    data: {
      name: 'Проверка сокетов',
      inviteCode: randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z2-9]/g, 'X'),
      ownerId: alice.id,
      members: {
        create: [
          { userId: alice.id, role: 'owner' },
          { userId: bob.id, role: 'member' },
        ],
      },
    },
    select: { id: true },
  });

  const book = await prisma.book.create({
    data: {
      title: 'Проверка сокетов',
      author: 'Автор',
      rooms: { create: { roomId: room.id } },
      files: {
        create: [
          {
            kind: 'text',
            format: 'epub',
            filePath: `files/socket/${suffix}.epub`,
            fileSize: 1,
            mimeType: 'application/epub+zip',
          },
        ],
      },
    },
    select: { id: true },
  });

  // ─── Сервер ─────────────────────────────────────────────────────────────────
  const app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const io = await createSocketServer(app.server);
  resetPresence();
  console.log(`  сервер на ${BASE}`);

  const sockets: ClientSocket[] = [];
  let exited = false;

  try {
    // ─── 1. Рукопожатие ───────────────────────────────────────────────────────
    section('1. Рукопожатие');

    const anon = await connect(null);
    check('без токена соединение отклонено', anon.socket === null, `а оно соединилось`);
    check('причина отказа — unauthorized', anon.error === 'unauthorized', `причина: ${anon.error}`);

    const bad = await connect('заведомо-неверный-токен');
    check('с неверным токеном отклонено', bad.socket === null);

    // Подписка на `server:ready` — до подключения: событие приходит в момент
    // соединения, и после `connect` слушать уже поздно.
    let readySeen: { userId: string } | null = null;
    const aliceConn = await connect(aliceToken, (socket) => {
      socket.on('server:ready', (payload: { userId: string }) => {
        readySeen = payload;
      });
    });
    const bobConn = await connect(bobToken);

    check('с верным токеном соединение принято', aliceConn.socket !== null && bobConn.socket !== null);
    if (aliceConn.socket === null || bobConn.socket === null) {
      throw new Error(`не удалось подключиться: ${aliceConn.error ?? bobConn.error}`);
    }
    sockets.push(aliceConn.socket, bobConn.socket);

    check('сервер прислал server:ready с верным userId', readySeen?.userId === alice.id);

    // Через cookie, а не `auth`: браузер с токеном в localStorage в dev-режиме
    // полагается на cookie, и сокет обязан работать в обоих случаях.
    const viaCookie = await new Promise<{ ok: boolean; error: string | null }>((resolve) => {
      const s = ioClient(BASE, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 5_000,
        extraHeaders: { Cookie: `rd_token=${bobToken}` },
      });
      const timer = setTimeout(() => resolve({ ok: false, error: 'таймаут' }), 6_000);
      s.on('connect', () => {
        clearTimeout(timer);
        s.disconnect();
        resolve({ ok: true, error: null });
      });
      s.on('connect_error', (err: Error) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
    });
    check('токен из cookie rd_token тоже принимается', viaCookie.ok, viaCookie.error ?? '');

    // ─── 2. Вход в комнату ─────────────────────────────────────────────────────
    section('2. Вход в комнату');

    const aliceJoin = await emitWithAck<{ ok: boolean; members?: unknown[]; error?: string }>(
      aliceConn.socket,
      'room:join',
      { roomId: room.id },
    );
    check('первый клиент вошёл', aliceJoin?.ok === true, aliceJoin?.error ?? '');

    const bobJoin = await emitWithAck<{ ok: boolean; members?: unknown[]; error?: string }>(
      bobConn.socket,
      'room:join',
      { roomId: room.id },
    );
    check('второй клиент вошёл', bobJoin?.ok === true, bobJoin?.error ?? '');

    const carolConn = await connect(carolToken);
    if (carolConn.socket !== null) sockets.push(carolConn.socket);
    const carolJoin = await emitWithAck<{ ok: boolean; error?: string }>(
      carolConn.socket,
      'room:join',
      { roomId: room.id },
    );
    check('посторонний в комнату не пущен', carolJoin?.ok === false, carolJoin?.error ?? '');

    // ─── 3. Комментарий через REST ────────────────────────────────────────────
    section('3. Комментарий через REST вещается в комнату');

    // Слушаем до запроса: иначе быстрый ответ сервера мог прийти раньше, чем
    // подписка, и проверка прошла бы с ложным «событие не дошло».
    const bobSeesComment = waitFor<{ roomId: string; comment: { text: string; anchorType: string } }>(
      bobConn.socket,
      'comment:new',
    );
    const aliceSeesComment = waitFor<unknown>(aliceConn.socket, 'comment:new', 2_500);

    const response = await fetch(
      `${BASE}/api/rooms/${room.id}/books/${book.id}/comments`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${aliceToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text: 'Ветер гулял по пустым улицам',
          bookFileKind: 'text',
          anchor: {
            kind: 'text',
            chapterIndex: 0,
            blockIndex: 0,
            start: 0,
            end: 5,
            quote: 'Ветер',
            prefix: '',
            suffix: ' гулял',
          },
        }),
      },
    );
    const created = (await response.json()) as { comment?: { id: string } };

    check('комментарий создан через REST', response.status === 201, `статус ${response.status}`);

    const got = await bobSeesComment;
    check('второй клиент получил comment:new', got !== null);
    check(
      'в payload полный объект, а не только id',
      got !== null && typeof got.comment.text === 'string' && got.comment.text.includes('Ветер'),
    );
    check(
      'anchorType в payload совпадает с вычисленным сервером',
      got !== null && got.comment.anchorType === 'text',
    );

    const echo = await aliceSeesComment;
    check('автор вещание не получил', echo === null);

    // ─── 4. Присутствие ───────────────────────────────────────────────────────
    section('4. Присутствие');

    const bobSeesPresence = waitFor<{ userId: string; positionData: Record<string, unknown> }>(
      bobConn.socket,
      'presence:changed',
    );
    const aliceSeesPresence = waitFor<{ userId: string }>(aliceConn.socket, 'presence:changed');

    aliceConn.socket.emit('presence:update', {
      roomId: room.id,
      positionType: 'text',
      positionData: { chapterIndex: 1, blockIndex: 42 },
    });

    const presence = await bobSeesPresence;
    check('второй клиент получил presence:changed', presence !== null);
    check('в присутствии верный userId', presence?.userId === alice.id);
    check(
      'положение дошло целиком',
      presence?.positionData['chapterIndex'] === 1 && presence?.positionData['blockIndex'] === 42,
    );

    // Отправитель тоже должен получить подтверждение: по нему он понимает, что
    // дошёл до нужного места, а не висит на старом.
    const selfPresence = await aliceSeesPresence;
    check('автор тоже получает своё присутствие', selfPresence?.userId === alice.id);

    const inRoom = await emitWithAck<{ ok: boolean; members?: Array<{ userId: string }> }>(
      bobConn.socket,
      'room:join',
      { roomId: room.id },
    );
    check(
      'список members содержит автора',
      inRoom?.members?.some((m) => m.userId === alice.id) === true,
    );

    // ─── 5. Обрыв ─────────────────────────────────────────────────────────────
    section('5. Обрыв соединения');

    // Слушает Алиса, а не Борис: обрывается сокет Бориса, и ушедший сам себе
    // `presence:left` не пришлёт — сокета у него уже нет. Проверять надо на
    // том, кто остался в комнате.
    const aliceSeesLeft = waitFor<{ userId: string; roomId: string }>(aliceConn.socket, 'presence:left');
    bobConn.socket.disconnect();
    const left = await aliceSeesLeft;
    check('после обрыва остальным пришло presence:left', left !== null);
    check('presence:left содержит ушедшего', left?.userId === bob.id);
    check('presence:left содержит комнату', left?.roomId === room.id);

    // ─── 6. Уведомление ───────────────────────────────────────────────────────
    section('6. Уведомление в персональный канал');

    // Кэрол вне комнаты, и её ответ был бы отвергнут с 403 — уведомления не
    // было бы вовсе, и проверка прошла бы ложно. Отвечает Борис, который в
    // комнату состоит, а уведомление получает Алиса — автор корневого
    // комментария.
    //
    // Прежний сокет Бориса отключён в разделе 5, поэтому нужен новый: заодно
    // проверяется, что после обрыва комнату можно занять заново.
    const bobAgain = await connect(bobToken);
    if (bobAgain.socket === null) throw new Error('Борис не переподключился');
    sockets.push(bobAgain.socket);
    const rejoin = await emitWithAck<{ ok: boolean }>(bobAgain.socket, 'room:join', { roomId: room.id });
    check('Борис снова вошёл после обрыва', rejoin?.ok === true);

    // Оба слушателя — до запроса: иначе быстрый ответ сервера мог прийти раньше
    // подписки, и проверка прошла бы с ложным «событие не дошло».
    const aliceNotification = waitFor<{ type: string; payload: Record<string, unknown> }>(
      aliceConn.socket,
      'notification:new',
    );
    const bobSeesOwnReply = waitFor<unknown>(bobAgain.socket, 'notification:new', 2_000);

    if (created.comment === undefined) throw new Error('не создан комментарий для ответа');

    const replyResponse = await fetch(
      `${BASE}/api/rooms/${room.id}/books/${book.id}/comments`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${bobToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Согласен, красиво',
          // Тот же текстовый файл, что и у корня: якорь обязан соответствовать
          // файлу, иначе сервер отверг бы ответ с 400, а уведомления не было бы.
          bookFileKind: 'text',
          parentId: created.comment.id,
          anchor: TEXT_ANCHOR,
        }),
      },
    );
    check('ответ создан через REST', replyResponse.status === 201, `статус ${replyResponse.status}`);

    const notification = await aliceNotification;
    check('уведомление доставлено в персональный канал', notification !== null);
    check('тип уведомления — reply', notification?.type === 'reply', `тип: ${notification?.type}`);
    check(
      'в уведомлении есть идентификатор комментария',
      typeof notification?.payload['commentId'] === 'string',
    );

    check('автор ответа не уведомлён о себе', (await bobSeesOwnReply) === null);
  } catch (error) {
    failed++;
    console.log(`\n  ✗ сценарий прерван: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await closeSocketServer(io).catch(() => undefined);
    await app.close().catch(() => undefined);
    await disconnectDatabase().catch(() => undefined);
  }

  console.log(`\nИтог: ${passed} прошло, ${failed} провалено`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

void main().catch((error: unknown) => {
  console.error('проверка сокетов упала', error);
  process.exit(1);
});
