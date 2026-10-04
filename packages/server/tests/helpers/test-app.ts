import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { buildServer } from '../../src/app.js';
import { generateToken, hashToken } from '../../src/auth/tokens.js';
import type { App } from '../../src/lib/app-type.js';
import type { User } from '../../src/generated/prisma/client.js';

/**
 * Помощники серверных тестов.
 *
 * ─── Отдельный клиент вместо импорта из src/db ──────────────────────────────
 *
 * У `src/db/client.ts` адаптер и пул создаются при импорте, а тесты должны
 * дергать `buildServer` много раз с одним и тем же `DATABASE_URL`. Свой
 * клиент даёт ещё и то, что его можно закрыть в `afterAll` явно: иначе vitest
 * не завершится, потому что пул `pg` держит сокеты.
 *
 * Схема у обоих одна, адаптер тот же — расхождение возможно только если
 * поменяется `prisma.config.ts`, и тогда упадут все серверные тесты.
 */

const adapter = new PrismaPg({
  connectionString: process.env.TEST_DATABASE_URL as string,
  max: 4,
});

export const testDb = new PrismaClient({ adapter, log: ['error'] });

/**
 * Приложение для тестов.
 *
 * Без `listen`: запросы идут через `app.inject()`, то есть по внутреннему пути
 * Fastify. Ни порта, ни сокета — тесты не мешают запущенному серверу и не падают,
 * если порт 3000 занят.
 *
 * Приложение собирается один раз и переиспользуется: `buildServer` регистрирует
 * плагины и rate-limit, а rate-limit хранит счётчики в памяти. Собрать его заново
 * на каждый тест означало бы сбрасывать лимиты между тестами — и проверка
 * rate-limit стала бы проверкой «свежее приложение», а не работающего.
 */
let appPromise: Promise<App> | null = null;

export function createTestApp(): Promise<App> {
  appPromise ??= buildServer();
  return appPromise;
}

/** Закрыть приложение и пул. Вызывается в `afterAll`. */
export async function closeTestApp(): Promise<void> {
  if (appPromise !== null) {
    const app = await appPromise;
    await app.close();
    appPromise = null;
  }
  await testDb.$disconnect();
}

/**
 * Полная очистка между тестами.
 *
 * `TRUNCATE ... CASCADE` вместо `deleteMany` по каждой модели: список таблиц
 * пришлось бы вести руками, и любая забытая таблица привела бы к тому, что
 * тест увидит данные предыдущего. С `CASCADE` Postgres сам разберётся по
 * внешним ключам, и новые таблицы не придётся сюда дописывать.
 *
 * Порядок важен только для читаемости: сначала родители, потом дети.
 */
export async function resetDb(): Promise<void> {
  await testDb.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Reaction",
      "Notification",
      "Presence",
      "Comment",
      "RoomBook",
      "JoinRequest",
      "RoomMember",
      "BookFile",
      "Room",
      "Book",
      "User"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Пользователь с известным токеном.
 *
 * Токен задаётся явно, а не генерируется: тест должен уметь подставить его в
 * заголовок или в cookie, не разбирая ответа. Возвращается и токен, и
 * запись — тестам нужны оба.
 */
export async function createTestUser(
  options: { role?: 'user' | 'admin'; username?: string; displayName?: string } = {},
): Promise<{ user: User; token: string }> {
  const role = options.role ?? 'user';
  const username = options.username ?? `u_${Math.random().toString(36).slice(2, 10)}`;
  const token = generateToken();

  const user = await testDb.user.create({
    data: {
      username,
      displayName: options.displayName ?? username,
      role,
      tokenHash: hashToken(token),
    },
  });

  return { user, token };
}

/**
 * Комната с владельцем и участником.
 *
 * Возвращает токены обоих: почти каждый тест комнат и книг понадобится и
 * «создатель», и «обычный участник».
 */
export async function createTestRoom(options: {
  ownerId: string;
  memberIds?: string[];
  name?: string;
  isPublic?: boolean;
}): Promise<{ roomId: string }> {
  const room = await testDb.room.create({
    data: {
      name: options.name ?? 'Тестовая комната',
      inviteCode: `c_${Math.random().toString(36).slice(2, 12)}`,
      isPublic: options.isPublic ?? false,
      ownerId: options.ownerId,
      members: {
        create: [
          { userId: options.ownerId, role: 'owner' },
          ...(options.memberIds ?? []).map((userId) => ({ userId, role: 'member' as const })),
        ],
      },
    },
    select: { id: true },
  });
  return { roomId: room.id };
}

/** Разбор тела ответа Fastify-инъекции в типизированный вид. */
export async function json<T = unknown>(response: {
  json: () => Promise<unknown>;
  statusCode: number;
}): Promise<T> {
  return (await response.json()) as T;
}

/** Значение cookie из заголовка `set-cookie`. */
export function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  if (setCookie === undefined) return null;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const entry of list) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(entry);
    if (match?.[1] !== undefined) return decodeURIComponent(match[1]);
  }
  return null;
}