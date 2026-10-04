import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestApp, createTestApp, resetDb } from './helpers/test-app.js';

/**
 * Rate-limit на входе.
 *
 * Отдельный файл не из-за красоты, а из-за изоляции: счётчики @fastify/rate-limit
 * живут в памяти приложения, а vitest даёт каждому файлу свой экземпляр
 * модулей — значит, здесь счётчик начинается с нуля. В общем файле пять
 * предшествующих проверок входа съедали бы квоту, и проверка лимита считала бы
 * не то, что задумано: она прошла бы и при полностью неработающем лимите.
 *
 * Сценарий: неверные токены — это попытка перебора, и она ограничена.
 */

const app = await createTestApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
});

const tryLogin = () =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { token: 'подбираемый-токен' },
  });

describe('лимит на /api/auth', () => {
  it('одиннадцатый неверный токен подряд даёт 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await tryLogin()).statusCode);
    }

    // Первые десять — обычный отказ «неверный токен», одиннадцатый — 429.
    expect(codes.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(codes[10]).toBe(429);
  });

  it('ответ 429 несёт Retry-After', async () => {
    for (let i = 0; i < 10; i++) await tryLogin();

    const response = await tryLogin();
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
  });

  it('лимит не касается соседних маршрутов', async () => {
    // Исчерпываем квоту входа...
    for (let i = 0; i < 11; i++) await tryLogin();
    expect((await tryLogin()).statusCode).toBe(429);

    // ...и убеждаемся, что /health продолжает отвечать: лимит на входе не
    // должен валить проверку живости, иначе туннель будет считать сервер
    // упавшим из-за чужого перебора паролей.
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('лимит считает по адресу, а не по токену', async () => {
    // Если бы ключом был токен, подбор разными значениями обходил бы счётчик
    // и лимит на перебор не значил бы ничего.
    for (let i = 0; i < 11; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { token: `разный-токен-${i}` },
      });
    }

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'совсем-другой-токен' },
    });
    expect(response.statusCode).toBe(429);
  });
});