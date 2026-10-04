import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { closeTestApp, createTestApp, createTestUser, resetDb } from './helpers/test-app.js';
import { TOKEN_COOKIE } from '../src/auth/guards.js';

/**
 * Доступ к файлам.
 *
 * Здесь проверяется то, ради чего понадобилась cookie: браузер не умеет вешать
 * `Authorization` на `<img>` и `<audio>`, поэтому статика принимает токен из
 * cookie, а запасным путём — из `?t=`.
 *
 * Файлы пишутся во временный каталог из setup-файла, а не в DATA_DIR
 * пользователя.
 */

const app = await createTestApp();

const DATA_ROOT = process.env.DATA_DIR as string;
const FILE_REL = 'files/testbook/original.epub';

beforeAll(async () => {
  const path = resolve(DATA_ROOT, FILE_REL);
  await mkdir(resolve(DATA_ROOT, 'files/testbook'), { recursive: true });
  await writeFile(path, 'содержимое файла книги');
});

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await closeTestApp();
});

describe('защита /files', () => {
  it('без cookie и без заголовка — 401', async () => {
    const response = await app.inject({ method: 'GET', url: `/files/${FILE_REL}` });
    expect(response.statusCode).toBe(401);
  });

  it('с неверным токеном в cookie — 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/files/${FILE_REL}`,
      headers: { cookie: `${TOKEN_COOKIE}=неверный` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('с валидной cookie — 200 и содержимое файла', async () => {
    const { token } = await createTestUser();

    const response = await app.inject({
      method: 'GET',
      url: `/files/${FILE_REL}`,
      headers: { cookie: `${TOKEN_COOKIE}=${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('содержимое файла книги');
  });

  it('с валидным токеном в ?t= — 200 (запасной путь для img и audio)', async () => {
    const { token } = await createTestUser();

    const response = await app.inject({
      method: 'GET',
      url: `/files/${FILE_REL}?t=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('содержимое файла книги');
  });

  it('с заголовком Bearer тоже работает', async () => {
    const { token } = await createTestUser();

    const response = await app.inject({
      method: 'GET',
      url: `/files/${FILE_REL}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('t= не работает на /api — токен в URL туда не пускаем', async () => {
    // Токен в query попадает в логи сервера, в историю браузера и в Referer
    // при переходе на другой сайт. На статике это приемлемо, на API — нет.
    const { token } = await createTestUser();

    const response = await app.inject({ method: 'GET', url: `/api/auth/me?t=${token}` });
    expect(response.statusCode).toBe(401);
  });

  it('path traversal отбит и с валидным токеном', async () => {
    // Проверка пути стоит до проверки прав, но порядок не должен ослаблять
    // ни то, ни другое: с настоящим токеном обход всё равно не проходит.
    const { token } = await createTestUser();

    for (const attack of [
      '/files/../.env',
      '/files/%2e%2e%2f.env',
      '/files/..%5c.env',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: attack,
        headers: { cookie: `${TOKEN_COOKIE}=${token}` },
      });
      expect([400, 403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('DATABASE_URL');
    }
  });
});