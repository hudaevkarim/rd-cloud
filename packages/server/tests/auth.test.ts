import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApp, createTestApp, createTestUser, resetDb, testDb } from './helpers/test-app.js';
import { TOKEN_COOKIE } from '../src/auth/guards.js';

/**
 * Аутентификация.
 *
 * Проверки rate-limit здесь нет и не должно быть: счётчики @fastify/rate-limit
 * живут в памяти приложения, а оно одно на файл. Пять входов в тестах выше
 * съедали бы квоту, и проверка лимита считала бы не то. Она живёт в
 * `rate-limit.test.ts`, где до неё не доходит ни один другой запрос.
 */

const app = await createTestApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
});

describe('POST /api/auth/login', () => {
  it('пустой запрос даёт 400 с перечнем полей', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('validation_failed');
  });

  it('неверный токен даёт 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'заведомо-не-верный-токен' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('верный токен даёт 200, ставит cookie и возвращает пользователя', async () => {
    const { user, token } = await createTestUser({ username: 'anya', displayName: 'Аня' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token },
    });

    expect(response.statusCode).toBe(200);

    // Токен в ответе не возвращается: клиент его уже знает, и второй
    // независимый канал утечки не нужен.
    const body = response.json();
    expect(body.user.id).toBe(user.id);
    expect(body.user.username).toBe('anya');
    expect(body.user.role).toBe('user');
    expect(body.token).toBeUndefined();

    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain(`${TOKEN_COOKIE}=`);
    expect(String(setCookie)).toContain('HttpOnly');
    expect(String(setCookie)).toContain('SameSite=Lax');
  });

  it('обновляет lastSeenAt при входе', async () => {
    const { user, token } = await createTestUser();
    expect(user.lastSeenAt).toBeNull();

    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });

    const after = await testDb.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.lastSeenAt).not.toBeNull();
  });

  it('не выдаёт cookie с Secure в development', async () => {
    // Secure cookie браузер не примет с http://localhost, и вход в разработке
    // сломался бы целиком. Проверка зафиксирована, чтобы смена NODE_ENV на
    // development не прошла незамеченной.
    const { token } = await createTestUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token },
    });
    expect(String(response.headers['set-cookie'])).not.toContain('Secure');
  });
});

describe('GET /api/auth/me', () => {
  it('без токена даёт 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('с неверным токеном в заголовке даёт 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: 'Bearer неверный' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('с заголовком Bearer даёт 200 и текущего пользователя', async () => {
    const { user, token } = await createTestUser({ displayName: 'Борис' });

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(user.id);
    expect(response.json().user.displayName).toBe('Борис');
  });

  it('с cookie даёт 200 — этим путём ходит статика', async () => {
    const { user, token } = await createTestUser();

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `${TOKEN_COOKIE}=${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.id).toBe(user.id);
  });
});

describe('POST /api/auth/logout', () => {
  it('возвращает ok и сбрасывает cookie', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    expect(String(response.headers['set-cookie'])).toContain(`${TOKEN_COOKIE}=`);
  });
});