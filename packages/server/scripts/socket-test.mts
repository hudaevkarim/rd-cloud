// Подключение тестовой базы обязано быть первым: подмена `DATABASE_URL` должна
// произойти до того, как `src/db/client.js` создаст клиента Prisma.
import './use-test-db.mts';

import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
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

/* ─── Загрузка файлов для проверки ────────────────────────────────────────── */

/**
 * Минимальный EPUB.
 *
 * Собирается прямо здесь, а не читается фикстурой: скрипт сокетов запускается
 * отдельно от `books.test.ts`, и его собственная фикстура не зависит ни от
 * порядка тестов, ни от того, что другой файл тестов уже собрал каталог.
 *
 * Реальный EPUB нужен потому, что сервер разбирает его при загрузке: подсунуть
 * zip с мусором значило бы проверять не тот путь, которым идёт живой человек.
 */
function buildEpub(): Buffer {
  const files = new Map<string, Buffer>();
  const put = (name: string, text: string): void => {
    files.set(name, Buffer.from(text, 'utf8'));
  };

  // `mimetype` обязан быть первым и несжатым — этого требует спецификация.
  files.set('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  put(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  put(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Проверка сокетов</dc:title>
    <dc:creator>Тестовый Автор</dc:creator>
    <dc:language>ru</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
  );
  put(
    'OEBPS/ch1.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Глава</title></head>
<body><h1>Глава</h1><p>Ветер гулял по пустым улицам и не хотел останавливаться.</p></body></html>`,
  );

  return zipSync(files);
}

/** Сборка zip без сжатия: структура EPUB должна оставаться читаемой. */
function zipSync(files: Map<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(content) >>> 0;
    const size = content.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    const lv = local;
    lv.writeUInt32LE(0x04034b50, 0);
    lv.writeUInt16LE(20, 4);
    lv.writeUInt16LE(0, 6); // флаги
    lv.writeUInt16LE(0, 8); // метод: без сжатия
    lv.writeUInt32LE(crc, 14);
    lv.writeUInt32LE(size, 18);
    lv.writeUInt32LE(size, 22);
    lv.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);

    locals.push(local, content);
    centrals.push(cd);
    offset += local.length + size;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}

const EPUB_BYTES = buildEpub();

/** Часть multipart с полем. */
function fieldPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8',
  );
}

/** Часть multipart с файлом: имя файла обязательно, иначе сервер его не увидит. */
function filePart(boundary: string, field: string, filename: string, bytes: Buffer): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  return Buffer.concat([head, bytes, Buffer.from('\r\n', 'utf8')]);
}

/**
 * Загрузка в комнату.
 *
 * Поля идут раньше файла: от `kind` и `format` зависит лимит размера, и сервер
 * обязан знать его до первого байта. Этот порядок — часть контракта, а не
 * особенность сборки.
 */
async function uploadToRoom(token: string, roomId: string): Promise<Response> {
  const boundary = `----rdsock${randomUUID().replace(/-/g, '')}`;
  return fetch(`${BASE}/api/rooms/${roomId}/books/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat([
      fieldPart(boundary, 'kind', 'text'),
      fieldPart(boundary, 'format', 'epub'),
      fieldPart(boundary, 'title', 'Проверка сокетов'),
      fieldPart(boundary, 'author', 'Тестовый Автор'),
      filePart(boundary, 'file', 'test-book.epub', EPUB_BYTES),
      Buffer.from(`--${boundary}--\r\n`, 'utf8'),
    ]),
  });
}

/** Загрузка в каталог: вид файла несёт имя поля, порядок частей не важен. */
async function uploadToCatalog(token: string): Promise<Response> {
  const boundary = `----rdcat${randomUUID().replace(/-/g, '')}`;
  return fetch(`${BASE}/api/admin/catalog`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat([
      fieldPart(boundary, 'title', 'Книга в каталоге'),
      fieldPart(boundary, 'author', 'Тестовый Автор'),
      filePart(boundary, 'text', 'test-book.epub', EPUB_BYTES),
      Buffer.from(`--${boundary}--\r\n`, 'utf8'),
    ]),
  });
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

    // ─── 7. Книги в комнате ────────────────────────────────────────────────────
    section('7. События книг');

    // Кэрол вне комнаты: её сокет не подписан на комнатный канал. Без проверки
    // «постороннему не ушло» утверждение «событие ушло всем подряд» прошло бы
    // ложно — и следующий дефект в маршруте никто бы не заметил.
    const bobSeesAdded = waitFor<{
      roomId: string;
      book: { id: string; title: string; coverUrl: string | null; hasText: boolean };
      addedBy: { id: string };
      source: string;
    }>(bobAgain.socket, 'book:added');
    const carolSeesAdded = waitFor<unknown>(carolConn.socket, 'book:added', 2_500);

    const upload = await uploadToRoom(aliceToken, room.id);
    check('книга загружена в комнату', upload.status === 201, `статус ${upload.status}`);

    const added = await bobSeesAdded;
    check('второй клиент получил book:added', added !== null);
    check('в событии верная комната', added?.roomId === room.id);
    check(
      'в payload книга с названием',
      typeof added?.book.title === 'string' && added.book.title.length > 0,
    );
    check('в payload есть признак текста', added?.book.hasText === true);
    // Ключ присутствует со значением null, а не отсутствует: иначе клиент
    // отличал бы «обложки нет» от «сервер не прислал сведения о книге».
    check('обложка в payload равна null, а не отсутствует', added !== null && added.book.coverUrl === null);
    check('источник — upload', added?.source === 'upload', `source: ${added?.source}`);
    check('указан, кто добавил', added?.addedBy.id === alice.id);
    check('постороннему в комнату событие не ушло', (await carolSeesAdded) === null);

    // Добавление из каталога: то же событие, другой источник. Событие легко
    // забыть именно здесь — книга появляется в комнате через `from-catalog`, а
    // не через загрузку файла.
    const catalogBook = await prisma.book.create({
      data: {
        title: 'Из каталога',
        author: 'Автор',
        isCatalog: true,
        files: {
          create: [
            {
              kind: 'text',
              format: 'epub',
              filePath: `files/socket/${suffix}-catalog.epub`,
              fileSize: 1,
              mimeType: 'application/epub+zip',
            },
          ],
        },
      },
      select: { id: true },
    });

    const bobSeesFromCatalog = waitFor<{ source: string; book: { id: string } }>(
      bobAgain.socket,
      'book:added',
    );
    const fromCatalog = await fetch(`${BASE}/api/rooms/${room.id}/books/from-catalog`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ catalogBookId: catalogBook.id }),
    });
    check('книга добавлена из каталога', fromCatalog.status === 201, `статус ${fromCatalog.status}`);

    const fromCatalogEvent = await bobSeesFromCatalog;
    check('то же событие при добавлении из каталога', fromCatalogEvent !== null);
    check('источник — catalog', fromCatalogEvent?.source === 'catalog', `source: ${fromCatalogEvent?.source}`);
    check('в payload та самая книга', fromCatalogEvent?.book.id === catalogBook.id);

    // Повторное добавление события не шлёт: книга уже стоит, и второе событие
    // показало бы «Борис добавил книгу» для книги, которая уже была.
    const bobSeesDuplicate = waitFor<unknown>(bobAgain.socket, 'book:added', 2_000);
    const duplicate = await fetch(`${BASE}/api/rooms/${room.id}/books/from-catalog`, {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ catalogBookId: catalogBook.id }),
    });
    check('повторное добавление отвечает added: false', duplicate.status === 200);
    check('и события не шлёт', (await bobSeesDuplicate) === null);

    const bobSeesRemoved = waitFor<{ roomId: string; bookId: string }>(bobAgain.socket, 'book:removed');
    const removed = await fetch(`${BASE}/api/rooms/${room.id}/books/${catalogBook.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    check('книга убрана из комнаты', removed.status === 200, `статус ${removed.status}`);

    const removal = await bobSeesRemoved;
    check('второй клиент получил book:removed', removal !== null);
    check('в удалении верная книга', removal?.bookId === catalogBook.id);
    check('в удалении верная комната', removal?.roomId === room.id);

    // Каталог общий: событие уходит всем подключённым, а не в комнату. Иначе
    // каталог обновлялся бы только у того, кто и так в комнате состоит.
    const bobSeesCatalogAdd = waitFor<{ book: { id: string } }>(bobAgain.socket, 'catalog:book:added');
    const carolSeesCatalogAdd = waitFor<{ book: { id: string } }>(
      carolConn.socket,
      'catalog:book:added',
      3_000,
    );

    const adminSuffix = randomUUID().slice(0, 8);
    const adminToken = `admin_${adminSuffix}_${randomUUID()}`;
    await prisma.user.create({
      data: {
        username: `adm_${adminSuffix}`,
        displayName: 'Админ',
        tokenHash: hashToken(adminToken),
        role: 'admin',
      },
      select: { id: true },
    });
    const adminConn = await connect(adminToken);
    if (adminConn.socket !== null) sockets.push(adminConn.socket);

    const toCatalog = await uploadToCatalog(adminToken);
    check('книга загружена в каталог', toCatalog.status === 201, `статус ${toCatalog.status}`);

    check('подписчик каталога получил событие', (await bobSeesCatalogAdd) !== null);
    check(
      'постороннему в комнате событие каталога тоже пришло',
      (await carolSeesCatalogAdd) !== null,
      'каталог не принадлежит ни одной комнате',
    );
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
