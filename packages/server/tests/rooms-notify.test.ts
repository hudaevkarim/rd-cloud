import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApp, createTestApp, createTestRoom, createTestUser, resetDb, testDb } from './helpers/test-app.js';

/**
 * Уведомления о заявках и исключение из комнаты.
 *
 * Отдельный файл, а не дополнение `rooms.test.ts`: здесь проверяется не форма
 * ответа, а **побочный эффект** — что запись появилась в `Notification` и кому
 * именно. Смешивать с проверками прав легко потерять: прав много, а проверка
 * уведомлений одна и она легко прокрастинируется.
 *
 * Уведомление проверяется по таблице `Notification`, а не по сокету. Эмит в
 * сокет проверяется скриптом `test:socket`, и здесь он был бы лишним: если
 * записи нет, тоста не будет в любом случае, а запись в базе — причина, по
 * которой тост может не появиться (запись упала, а эмит не состоялся).
 */

const app = await createTestApp();

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
});

/** Уведомления пользователя, новые первыми. */
async function notificationsOf(userId: string): Promise<Array<{ type: string; payload: unknown }>> {
  const rows = await testDb.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { type: true, payload: true },
  });
  return rows;
}

describe('уведомление о новой заявке', () => {
  it('доходит до всех участников комнаты, включая владельца', async () => {
    const owner = await createTestUser({ displayName: 'Хозяин' });
    const member = await createTestUser({ displayName: 'Участник' });
    const candidate = await createTestUser({ displayName: 'Претендент' });

    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id],
      name: 'Тихая комната',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(candidate.token),
    });
    expect(response.statusCode).toBe(201);

    // Владелец — тоже участник, и он тоже должен узнать: одобрять может любой,
    // значит и реагировать на новую заявку обязан любой.
    for (const who of [owner, member]) {
      const notes = await notificationsOf(who.user.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.type).toBe('join_request');
      expect(notes[0]?.payload).toMatchObject({
        roomId,
        roomName: 'Тихая комната',
        userId: candidate.user.id,
        userName: 'Претендент',
      });
    }
  });

  it('заявителю не достаётся', async () => {
    const owner = await createTestUser();
    const candidate = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(candidate.token),
    });

    // Человек не должен получать уведомление о том, что сделал сам: тост «новая
    // заявка» в его лобби сбивал бы с толку.
    expect(await notificationsOf(candidate.user.id)).toHaveLength(0);
  });

  it('не достаётся постороннему: он не участник этой комнаты', async () => {
    const owner = await createTestUser();
    const candidate = await createTestUser();
    const stranger = await createTestUser();
    const other = await createTestRoom({ ownerId: owner.user.id });

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${other.roomId}/join-request`,
      headers: auth(candidate.token),
    });

    expect(await notificationsOf(stranger.user.id)).toHaveLength(0);
  });

  it('повторная заявка не создаёт второго уведомления', async () => {
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

    // Два тоста «новая заявка» об одном человеке означали бы, что участники
    // побегут проверять список дважды.
    expect(await notificationsOf(owner.user.id)).toHaveLength(1);
  });

  it('несуществующая комната — 404, а не 500', async () => {
    const candidate = await createTestUser();

    const response = await app.inject({
      method: 'POST',
      url: '/api/rooms/нет-такой/join-request',
      headers: auth(candidate.token),
    });

    // Проверка роли проходит (в комнате никого нет — это «не участник»), и без
    // чтения самой комнаты вставка упала бы на внешнем ключе с 500.
    expect(response.statusCode).toBe(404);
  });
});

describe('ответ на заявку', () => {
  async function submitAndList(roomId: string, candidateToken: string, ownerToken: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-request`,
      headers: auth(candidateToken),
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/join-requests`,
      headers: auth(ownerToken),
    });
    return list.json().requests[0].id as string;
  }

  it('при одобрении заявитель узнаёт, что его приняли', async () => {
    const owner = await createTestUser();
    const candidate = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, name: 'Своя' });

    const requestId = await submitAndList(roomId, candidate.token, owner.token);
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-requests/${requestId}/approve`,
      headers: auth(owner.token),
    });

    const notes = await notificationsOf(candidate.user.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.type).toBe('join_approved');
    expect(notes[0]?.payload).toMatchObject({ roomId, roomName: 'Своя' });
  });

  it('одобрить может обычный участник, а не только владелец', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const candidate = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id],
    });

    const requestId = await submitAndList(roomId, candidate.token, owner.token);

    // Принцип «в комнате все равны»: ждать владельца, который может не заходить
    // неделями, нельзя.
    const approved = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-requests/${requestId}/approve`,
      headers: auth(member.token),
    });
    expect(approved.statusCode).toBe(201);

    const row = await testDb.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: candidate.user.id } },
    });
    expect(row?.role).toBe('member');
  });

  it('при отклонении заявитель узнаёт, и кнопка «Попроситься» снова доступна', async () => {
    const owner = await createTestUser();
    const candidate = await createTestUser();
    // Публичная: иначе комнату не найти поиском, и проверять было бы нечего.
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      name: 'Открытая',
      isPublic: true,
    });

    const requestId = await submitAndList(roomId, candidate.token, owner.token);
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join-requests/${requestId}/reject`,
      headers: auth(owner.token),
    });

    const notes = await notificationsOf(candidate.user.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.type).toBe('join_rejected');

    // Отклонённая заявка не должна висеть: поиск показывает «запрос отправлен»
    // только по `pending`, и человек должен мочь подать новый.
    const search = await app.inject({
      method: 'GET',
      url: '/api/rooms/search?q=' + encodeURIComponent('Открытая'),
      headers: auth(candidate.token),
    });
    const hit = (search.json().rooms as Array<{ id: string; myPendingRequest: boolean }>).find(
      (r) => r.id === roomId,
    );

    // Комната обязана найтись: иначе проверка молча прошла бы на пустом массиве
    // и ничего не сказала бы о состоянии заявки.
    expect(hit).toBeDefined();
    expect(hit?.myPendingRequest).toBe(false);
  });
});

describe('исключение участника', () => {
  it('владелец исключает участника, участник получает уведомление kicked', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id],
      name: 'Своя',
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/members/${member.user.id}`,
      headers: auth(owner.token),
    });

    expect(response.statusCode).toBe(200);
    expect(
      await testDb.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId: member.user.id } },
      }),
    ).toBeNull();

    const notes = await notificationsOf(member.user.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.type).toBe('kicked');
    // Название в уведомлении обязательно: «Вас исключили» без указания откуда
    // заставило бы человека гадать, где он это сделал.
    expect(notes[0]?.payload).toMatchObject({ roomId, roomName: 'Своя' });
  });

  it('исключённый получает 403 при попытке открыть комнату', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id],
    });

    await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/members/${member.user.id}`,
      headers: auth(owner.token),
    });

    // Страница комнаты показывает «вы больше не участник», а не «доступ
    // запрещён» без причины.
    const opened = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}`,
      headers: auth(member.token),
    });
    expect(opened.statusCode).toBe(403);
    expect(opened.json().error.message).toContain('участник');
  });

  it('не-владелец исключить не может, даже если он участник', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const victim = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id, victim.user.id],
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/members/${victim.user.id}`,
      headers: auth(member.token),
    });

    expect(response.statusCode).toBe(403);
    expect(
      await testDb.roomMember.findUnique({
        where: { roomId_userId: { roomId, userId: victim.user.id } },
      }),
    ).not.toBeNull();
  });

  it('владелец не может исключить себя: для этого есть «Покинуть»', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/members/${owner.user.id}`,
      headers: auth(owner.token),
    });

    // Исключение себя оставило бы комнату без участника, но с владельцем в
    // трупе: удалить её было бы уже некому, а `ownerId` указывал бы в пустоту.
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('Покинуть');
  });

  it('повторное исключение — 404, а не 200', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { roomId } = await createTestRoom({
      ownerId: owner.user.id,
      memberIds: [member.user.id],
    });

    await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/members/${member.user.id}`,
      headers: auth(owner.token),
    });
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${roomId}/members/${member.user.id}`,
      headers: auth(owner.token),
    });

    // Идемпотентный 200 выглядел бы как успех, хотя человек ушёл не из-за этого
    // клика: интерфейс показал бы «исключён» человеку, которого уже нет.
    expect(again.statusCode).toBe(404);
  });

  it('несуществующий участник и чужая комната — 404', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });
    const other = await createTestRoom({ ownerId: owner.user.id });

    expect(
      (await app.inject({
        method: 'DELETE',
        url: `/api/rooms/${roomId}/members/${stranger.user.id}`,
        headers: auth(owner.token),
      })).statusCode,
    ).toBe(404);

    expect(
      (await app.inject({
        method: 'DELETE',
        url: `/api/rooms/${other.roomId}/members/${stranger.user.id}`,
        headers: auth(owner.token),
      })).statusCode,
    ).toBe(404);
  });
});

describe('добавление по приглашению', () => {
  it('приглашённый узнаёт, что он в комнате', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id, name: 'Своя' });

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/invite`,
      headers: auth(owner.token),
      payload: { userId: guest.user.id },
    });

    const notes = await notificationsOf(guest.user.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.type).toBe('added');
    expect(notes[0]?.payload).toMatchObject({ roomId, roomName: 'Своя' });
  });

  it('повторное приглашение не создаёт второго уведомления', async () => {
    const owner = await createTestUser();
    const guest = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/invite`,
      headers: auth(owner.token),
      payload: { userId: guest.user.id },
    });
    const again = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/invite`,
      headers: auth(owner.token),
      payload: { userId: guest.user.id },
    });
    expect(again.statusCode).toBe(200);

    expect(await notificationsOf(guest.user.id)).toHaveLength(1);
  });
});