import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closeTestApp,
  createTestApp,
  createTestRoom,
  createTestUser,
  resetDb,
  testDb,
} from './helpers/test-app.js';

/**
 * Админ-панель.
 *
 * Порядок тестов внутри одного describe имеет значение: rate-limit на входе
 * здесь не проверяется, но приложение общее на все файлы, и лимит считает по
 * адресу. Логина в этом файле всего три, до десяти не доходит.
 */

const app = await createTestApp();

const adminAuth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
});

describe('доступ к /api/admin', () => {
  it('без токена — 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/admin/users' });
    expect(response.statusCode).toBe(401);
  });

  it('обычный пользователь — 403', async () => {
    const { token } = await createTestUser({ role: 'user' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: adminAuth(token),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('forbidden');
  });

  it('админ — 200 и видит список', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin', username: 'boss' });
    await createTestUser({ username: 'anya' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: adminAuth(adminToken),
    });

    expect(response.statusCode).toBe(200);
    const users = response.json().users as Array<{ username: string }>;
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.username).sort()).toEqual(['anya', 'boss']);
  });

  it('в списке пользователей нет ни токенов, ни их хешей', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: adminAuth(adminToken),
    });

    const raw = response.body;
    expect(raw).not.toContain('tokenHash');
    expect(raw).not.toContain(adminToken);
  });
});

describe('создание пользователя', () => {
  it('возвращает токен один раз — при создании', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminAuth(adminToken),
      payload: { username: 'novichok', displayName: 'Новичок' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.username).toBe('novichok');
    expect(body.user.role).toBe('user');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThanOrEqual(40);
  });

  it('созданный пользователь может войти с выданным токеном', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminAuth(adminToken),
      payload: { username: 'novichok', displayName: 'Новичок' },
    });
    const issued = created.json().token as string;

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: issued },
    });

    expect(login.statusCode).toBe(200);
    expect(login.json().user.username).toBe('novichok');
  });

  it('в базе лежит только sha256, а не сам токен', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin' });

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminAuth(adminToken),
      payload: { username: 'novichok', displayName: 'Новичок' },
    });
    const issued = created.json().token as string;

    const stored = await testDb.user.findUniqueOrThrow({ where: { username: 'novichok' } });
    expect(stored.tokenHash).toHaveLength(64);
    expect(stored.tokenHash).not.toBe(issued);
  });

  it('занятое имя даёт 409, а не 500', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin' });
    await createTestUser({ username: 'anya' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminAuth(adminToken),
      payload: { username: 'anya', displayName: 'Ещё одна Аня' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('conflict');
  });

  it('некорректное имя даёт 400', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminAuth(adminToken),
      payload: { username: 'пробел и кириллица', displayName: 'X' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('создание пользователя недоступно обычному', async () => {
    const { token } = await createTestUser({ role: 'user' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: adminAuth(token),
      payload: { username: 'samorod', displayName: 'Самород' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('удаление пользователя', () => {
  it('админ не может удалить себя — 400', async () => {
    const admin = await createTestUser({ role: 'admin' });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${admin.user.id}`,
      headers: adminAuth(admin.token),
    });

    expect(response.statusCode).toBe(400);
    expect(await testDb.user.findUnique({ where: { id: admin.user.id } })).not.toBeNull();
  });

  it('несуществующий — 404', async () => {
    const { token } = await createTestUser({ role: 'admin' });

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/admin/users/несуществующий-id',
      headers: adminAuth(token),
    });

    expect(response.statusCode).toBe(404);
  });

  it('удаляет пользователя и всё связанное каскадом', async () => {
    const { token: adminToken } = await createTestUser({ role: 'admin' });
    const victim = await createTestUser({ username: 'udalyaemy' });
    const bystander = await createTestUser({ username: 'ostavsheesya' });

    const { roomId } = await createTestRoom({ ownerId: victim.user.id });
    await testDb.roomBook.create({
      data: { roomId, bookId: (await testDb.book.create({ data: { title: 'Книга', author: 'Автор' } })).id },
    });
    const comment = await testDb.comment.create({
      data: {
        roomId,
        bookId: (await testDb.book.create({ data: { title: 'Ещё книга', author: 'Автор' } })).id,
        bookFileKind: 'text',
        userId: victim.user.id,
        text: 'Комментарий',
        anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 1, quote: 'я', prefix: '', suffix: '' },
        anchorType: 'text',
      },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/users/${victim.user.id}`,
      headers: adminAuth(adminToken),
    });

    expect(response.statusCode).toBe(200);

    // Сам пользователь, его комната и его комментарий исчезли.
    expect(await testDb.user.findUnique({ where: { id: victim.user.id } })).toBeNull();
    expect(await testDb.room.findUnique({ where: { id: roomId } })).toBeNull();
    expect(await testDb.comment.findUnique({ where: { id: comment.id } })).toBeNull();

    // Чужой пользователь не тронут.
    expect(await testDb.user.findUnique({ where: { id: bystander.user.id } })).not.toBeNull();
  });
});

describe('комнаты и статистика', () => {
  it('список комнат содержит числа участников и книг', async () => {
    const { token, user } = await createTestUser({ role: 'admin' });
    const other = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: user.id, memberIds: [other.user.id] });

    const book = await testDb.book.create({ data: { title: 'Книга', author: 'Автор' } });
    await testDb.roomBook.create({ data: { roomId, bookId: book.id } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/rooms',
      headers: adminAuth(token),
    });

    expect(response.statusCode).toBe(200);
    const rooms = response.json().rooms as Array<{ id: string; _count: { members: number; books: number } }>;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.id).toBe(roomId);
    expect(rooms[0]?._count.members).toBe(2);
    expect(rooms[0]?._count.books).toBe(1);
  });

  it('удаление комнаты обычному пользователю недоступно', async () => {
    const owner = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: owner.user.id });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/admin/rooms/${roomId}`,
      headers: adminAuth(owner.token),
    });

    expect(response.statusCode).toBe(403);
    expect(await testDb.room.findUnique({ where: { id: roomId } })).not.toBeNull();
  });

  it('статистика считает пользователей, комнаты, книги и комментарии', async () => {
    const { token, user } = await createTestUser({ role: 'admin' });
    const member = await createTestUser();
    const { roomId } = await createTestRoom({ ownerId: user.id, memberIds: [member.user.id] });

    const book = await testDb.book.create({ data: { title: 'Книга', author: 'Автор' } });
    await testDb.bookFile.create({
      data: {
        bookId: book.id,
        kind: 'text',
        format: 'epub',
        filePath: 'files/abc/original.epub',
        fileSize: 1234,
        mimeType: 'application/epub+zip',
      },
    });
    await testDb.comment.create({
      data: {
        roomId,
        bookId: book.id,
        bookFileKind: 'text',
        userId: member.user.id,
        text: 'Комментарий',
        anchor: { kind: 'text', chapterIndex: 0, blockIndex: 0, start: 0, end: 1, quote: 'я', prefix: '', suffix: '' },
        anchorType: 'text',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: adminAuth(token),
    });

    expect(response.statusCode).toBe(200);
    const stats = response.json();
    expect(stats.users).toBe(2);
    expect(stats.rooms).toBe(1);
    expect(stats.books).toBe(1);
    expect(stats.comments).toBe(1);
    expect(stats.files).toBe(1);
    expect(stats.totalFileSize).toBe(1234);
  });
});