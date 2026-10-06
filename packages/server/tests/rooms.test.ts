import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApp, createTestApp, createTestRoom, createTestUser, resetDb, testDb } from './helpers/test-app.js';
import { INVITE_ALPHABET, normalizeInviteCode } from '../src/lib/invite-code.js';

/**
 * Комнаты: создание, вход по коду, заявки, права, выход.
 *
 * Права проверяются по базе, а не по телу запроса, поэтому тесты подделывают
 * `role` там, где это возможно, и убеждаются, что это не помогает.
 */

const app = await createTestApp();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
});

describe('создание комнаты', () => {
  it('возвращает комнату с кодом приглашения и делает создателя владельцем', async () => {
    const { token, user } = await createTestUser({ username: 'anya' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(token),
      payload: { name: 'Классика', description: 'Читаем по очереди', isPublic: true },
    });

    expect(response.statusCode).toBe(201);
    const { room } = response.json();
    expect(room.name).toBe('Классика');
    expect(room.isPublic).toBe(true);
    expect(room.inviteCode).toHaveLength(8);
    expect(room._count.members).toBe(1);

    const member = await testDb.roomMember.findUniqueOrThrow({
      where: { roomId_userId: { roomId: room.id, userId: user.id } },
    });
    expect(member.role).toBe('owner');
  });

  it('код не содержит неоднозначных символов', async () => {
    const { token } = await createTestUser();

    // 0/O и 1/I/l путают при переписывании на бумаге и при диктовке.
    expect(INVITE_ALPHABET).not.toMatch(/[01OIl]/);

    for (let i = 0; i < 12; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: auth(token),
        payload: { name: `Комната ${i}` },
      });
      const code = response.json().room.inviteCode as string;
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it('без токена — 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name: 'Без входа' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('без названия — 400', async () => {
    const { token } = await createTestUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(token),
      payload: { description: 'а name нет' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('список моих комнат', () => {
  it('показывает только те, где пользователь участник', async () => {
    const me = await createTestUser();
    const other = await createTestUser();
    await createTestRoom({ ownerId: me.user.id, name: 'Моя' });
    await createTestRoom({ ownerId: other.user.id, name: 'Чужая' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/rooms',
      headers: auth(me.token),
    });

    expect(response.statusCode).toBe(200);
    const rooms = response.json().rooms as Array<{ name: string; myRole: string }>;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.name).toBe('Моя');
    expect(rooms[0]?.myRole).toBe('owner');
  });
});

describe('вход по коду', () => {
  it('второй пользователь входит сразу, без одобрения', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();

    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(owner.token),
      payload: { name: 'Закрытая' },
    });
    const code = created.json().room.inviteCode as string;

    const joined = await app.inject({
      method: 'POST',
      url: '/api/rooms/join-by-code',
      headers: auth(guest.token),
      payload: { inviteCode: code },
    });

    expect(joined.statusCode).toBe(200);
    expect(joined.json().joined).toBe(true);

    const member = await testDb.roomMember.findUniqueOrThrow({
      where: {
        roomId_userId: { roomId: created.json().room.id as string, userId: guest.user.id },
      },
    });
    expect(member.role).toBe('member');
  });

  it('код нечувствителен к регистру', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();

    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(owner.token),
      payload: { name: 'Комната' },
    });
    const code = created.json().room.inviteCode as string;

    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/join-by-code',
      headers: auth(guest.token),
      payload: { inviteCode: code.toLowerCase() },
    });

    expect(response.statusCode).toBe(200);
    expect(normalizeInviteCode(code.toLowerCase())).toBe(code);
  });

  it('неизвестный код — 404, код с запрещённым символом — 400', async () => {
    const { token } = await createTestUser();

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/rooms/join-by-code',
      headers: auth(token),
      payload: { inviteCode: 'ZZZZZZZZ' },
    });
    expect(unknown.statusCode).toBe(404);

    // Ноль и «о» в алфавите нет: такой код не мог быть выдан.
    const withZero = await app.inject({
      method: 'POST',
      url: '/api/rooms/join-by-code',
      headers: auth(token),
      payload: { inviteCode: 'ABCD0EFG' },
    });
    expect(withZero.statusCode).toBe(400);
  });

  it('повторный вход — 200 с joined:false, а не ошибка', async () => {
    const owner = await createTestUser();
    const created = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(owner.token),
      payload: { name: 'Комната' },
    });
    const code = created.json().room.inviteCode as string;

    await app.inject({
      method: 'POST',
      url: '/api/rooms/join-by-code',
      headers: auth(owner.token),
      payload: { inviteCode: code },
    });

    const again = await app.inject({
      method: 'POST',
      url: '/api/rooms/join-by-code',
      headers: auth(owner.token),
      payload: { inviteCode: code },
    });

    // Человек уже в комнате — это не поломка, а желаемое состояние.
    expect(again.statusCode).toBe(200);
    expect(again.json().joined).toBe(false);
  });
});

describe('поиск публичных комнат', () => {
  it('находит по имени без учёта регистра и только публичные', async () => {
    const owner = await createTestUser();
    const priv = await createTestUser();

    await createTestRoom({ ownerId: owner.user.id, name: 'Анна Каренина', isPublic: true });
    await createTestRoom({ ownerId: priv.user.id, name: 'Анна Каренина (копия)', isPublic: false });

    const response = await app.inject({
      method: 'GET',
      // Запрос кодируется явно: `inject` не разбирает URL и передаёт его как есть,
      // а необработанная кириллица в строке запроса доезжает до сервера как
      // latin1 и не совпадает с UTF-8 в базе. Настоящий клиент кодирует всегда.
      url: `/api/rooms/search?q=${encodeURIComponent('анна')}`,
      headers: auth(owner.token),
    });

    expect(response.statusCode).toBe(200);
    const rooms = response.json().rooms as Array<{ name: string; inviteCode?: string }>;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.name).toBe('Анна Каренина');
    // Код в поиске не нужен: его выдают отдельно и по ссылке.
    expect(rooms[0]?.inviteCode).toBeUndefined();
  });

  it('требует токен: поиск комнат не должен быть публичным', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/rooms/search?q=кто' });
    expect(response.statusCode).toBe(401);
  });

  it('отдаёт владельца, число участников и мою роль', async () => {
    const owner = await createTestUser({ displayName: 'Хозяин' });
    const member = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id],
      name: 'Анна Каренина',
      isPublic: true,
    });

    const mine = await app.inject({
      method: 'GET',
      url: `/api/rooms/search?q=${encodeURIComponent('анна')}`,
      headers: auth(member.token),
    });
    const myHit = mine.json().rooms[0];
    expect(myHit.myRole).toBe('member');
    expect(myHit.memberCount).toBe(2);
    expect(myHit.owner).toMatchObject({ id: owner.user.id, displayName: 'Хозяин' });

    // Постороннему роль не выдаётся, но она и `null`, а не отсутствует: клиент
    // различает «не участник» по ключу, и отсутствующий ключ означал бы, что
    // поле забыли.
    const theirs = await app.inject({
      method: 'GET',
      url: `/api/rooms/search?q=${encodeURIComponent('анна')}`,
      headers: auth(stranger.token),
    });
    const theirHit = theirs.json().rooms[0];
    expect(theirHit.myRole).toBeNull();
    expect('myRole' in theirHit).toBe(true);
    expect(theirHit.myPendingRequest).toBe(false);
    expect(roomId).toBeTruthy();
  });

  it('показывает myPendingRequest только для своей заявки на этой комнате', async () => {
    const owner = await createTestUser();
    const mine = await createTestUser();
    const theirs = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      name: 'Анна Каренина',
      isPublic: true,
    });
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(mine.token),
    });

    const mineSearch = await app.inject({
      method: 'GET',
      url: `/api/rooms/search?q=${encodeURIComponent('анна')}`,
      headers: auth(mine.token),
    });
    expect(mineSearch.json().rooms[0].myPendingRequest).toBe(true);

    // Чужая заявка не должна светиться в чужих глазах.
    const theirsSearch = await app.inject({
      method: 'GET',
      url: `/api/rooms/search?q=${encodeURIComponent('анна')}`,
      headers: auth(theirs.token),
    });
    expect(theirsSearch.json().rooms[0].myPendingRequest).toBe(false);
  });

  it('выдаёт один _count-счёт участников, а не вложенный объект', async () => {
    const owner = await createTestUser();
    await createTestRoom({ ownerId: owner.user.id, name: 'Анна Каренина', isPublic: true });

    const response = await app.inject({
      method: 'GET',
      url: `/api/rooms/search?q=${encodeURIComponent('анна')}`,
      headers: auth(owner.token),
    });
    const hit = response.json().rooms[0];

    // Форма ответа объявлена контрактом: клиент читает `memberCount`. Оставшийся
    // `_count` означал бы, что форма поменялась, а типы в клиенте — нет.
    expect(hit.memberCount).toBe(1);
    expect(hit._count).toBeUndefined();
  });
});

describe('заявки на вступление', () => {
  it('полный путь: заявка → видимость → одобрение → участник', async () => {
    const owner = await createTestUser();
    const candidate = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, name: 'Тихая комната' });

    const requested = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(candidate.token),
    });
    expect(requested.statusCode).toBe(201);

    // Посторонний список заявок не видит.
    const stranger = await createTestUser();
    const hidden = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/join-requests`,
      headers: auth(stranger.token),
    });
    expect(hidden.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/join-requests`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().requests).toHaveLength(1);

    const requestId = list.json().requests[0].id as string;

    const approved = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-requests/${requestId}/approve`,
      headers: auth(owner.token),
    });
    expect(approved.statusCode).toBe(201);

    const member = await testDb.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: candidate.user.id } },
    });
    expect(member?.role).toBe('member');

    const closed = await testDb.joinRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(closed.status).toBe('approved');
    expect(closed.decidedById).toBe(owner.user.id);
    expect(closed.decidedAt).not.toBeNull();
  });

  it('повторная заявка — 409, а не ошибка уникальности', async () => {
    const owner = await createTestUser();
    const candidate = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(candidate.token),
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(candidate.token),
    });

    expect(second.statusCode).toBe(409);
  });

  it('отклонение закрывает заявку и не создаёт участника', async () => {
    const owner = await createTestUser();
    const candidate = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(candidate.token),
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/join-requests`,
      headers: auth(owner.token),
    });
    const requestId = list.json().requests[0].id as string;

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-requests/${requestId}/reject`,
      headers: auth(owner.token),
    });
    expect(rejected.statusCode).toBe(200);

    expect(
      await testDb.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId: candidate.user.id } },
      }),
    ).toBeNull();
    const closed = await testDb.joinRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(closed.status).toBe('rejected');
  });

  it('приглашение от участника пускает сразу, без заявки', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/invite`,
      headers: auth(owner.token),
      payload: { userId: guest.user.id },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().joined).toBe(true);
  });
});

describe('права', () => {
  it('посторонний не видит комнату и её участников', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    expect(
      (await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth(owner.token) }))
        .statusCode,
    ).toBe(200);

    expect(
      (await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth(stranger.token) }))
        .statusCode,
    ).toBe(403);

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/rooms/${roomId}/members`,
          headers: auth(stranger.token),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('правку и удаление делает только владелец', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [member.user.id] });

    expect(
      (await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${roomId}`,
        headers: auth(member.token),
        payload: { name: 'Переименовано' },
      })).statusCode,
    ).toBe(403);

    expect(
      (await app.inject({
        method: 'DELETE',
        url: `/api/rooms/${roomId}`,
        headers: auth(member.token),
      })).statusCode,
    ).toBe(403);

    expect(
      (await app.inject({
        method: 'PATCH',
        url: `/api/rooms/${roomId}`,
        headers: auth(owner.token),
        payload: { name: 'Переименовано' },
      })).statusCode,
    ).toBe(200);
  });

  it('участник не может приглашать в комнату, где его нет', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const target = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/invite`,
      headers: auth(stranger.token),
      payload: { userId: target.user.id },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('выход из комнаты', () => {
  it('уходит обычный участник, комната остаётся', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, memberIds: [member.user.id] });

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: auth(member.token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().roomDeleted).toBe(false);
    expect(await testDb.room.findUnique({ where: { id: roomId } })).not.toBeNull();
  });

  it('уход владельца передаёт владение самому раннему участнику', async () => {
    const owner = await createTestUser();
    const first = await createTestUser();
    const second = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [first.user.id, second.user.id],
    });

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: auth(owner.token),
    });

    const members = await testDb.roomMember.findMany({
      where: { roomId },
      select: { userId: true, role: true, joinedAt: true },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });

    // Роль и колонка ownerId обязаны совпадать, иначе «удалить может только
    // владелец» перестало бы работать.
    const heir = members.find((m) => m.role === 'owner');
    expect(heir?.userId).toBe(first.user.id);

    const room = await testDb.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(room.ownerId).toBe(first.user.id);
  });

  it('уход последнего участника удаляет комнату', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: auth(owner.token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().roomDeleted).toBe(true);
    expect(await testDb.room.findUnique({ where: { id: roomId } })).toBeNull();
  });

  it('выход из чужой комнаты — 409', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/leave`,
      headers: auth(stranger.token),
    });

    expect(response.statusCode).toBe(409);
  });
});