import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { prisma, disconnectDatabase } from '../db/client.js';

/**
 * Первый администратор.
 *
 * Скрипт идемпотентен: если пользователь с таким именем уже есть — ничего не
 * делает и выходит. Это позволяет запускать его повторно, не опасась, что
 * перезапишет пароль работающей учётной записи.
 *
 * Токен в базу не кладётся. Кладётся только sha256: дамп базы не должен выдавать
 * доступ ко всем аккаунтам. Сравнение при входе — по хешу, поэтому утечка базы
 * сама по себе бесполезна.
 */

// Отдельная схема вместо импорта `../env.js`: seed нужен только когда база уже
// пуста, и требовать от него WEB_ORIGIN или LOG_LEVEL незачем — из-за отсутствия
// второстепенной переменной скрипт первичной настройки падать не должен.
loadEnv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)), quiet: true });

const envSchema = z.object({
  ADMIN_USERNAME: z.string().min(1).default('admin'),
  /** Пусто — значит сгенерировать и показать один раз. */
  ADMIN_TOKEN: z.string().default(''),
});

/** sha256 от токена: hex, в базе хранится он. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Токен выдаётся в base64url: 32 байта энтропии и алфавит без символов,
 * которые пришлось бы вырезать при вставке в буфер обмена.
 */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Сравнение хешей за постоянное время.
 *
 * На практике утечка по времени здесь почти не читается — сравниваются хеши, а не
 * токены, и по сети их не угадать. Но сравнение строк наивным `===` здесь
 * стоило бы написать один раз и потом забыть, а так оно выглядит правильно.
 */
export function tokensMatch(candidate: string, expectedHash: string): boolean {
  const a = Buffer.from(hashToken(candidate), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Некорректные переменные ADMIN_*:\n${lines.join('\n')}`);
  }
  const { ADMIN_USERNAME: username, ADMIN_TOKEN: provided } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing !== null) {
    console.log(`Пользователь «${username}» уже есть (id=${existing.id}, роль=${existing.role}).`);
    console.log('Ничего не изменено. Токен показывается только при создании.');
    return;
  }

  const generated = provided === '';
  const token = generated ? generateToken() : provided;
  const tokenHash = hashToken(token);

  const user = await prisma.user.create({
    data: {
      username,
      displayName: username,
      tokenHash,
      role: 'admin',
    },
    select: { id: true, username: true, displayName: true, role: true, createdAt: true },
  });

  console.log('Администратор создан.');
  console.log(`  id          : ${user.id}`);
  console.log(`  username    : ${user.username}`);
  console.log(`  displayName : ${user.displayName}`);
  console.log(`  role        : ${user.role}`);
  console.log(`  sha256(токен): ${tokenHash}`);

  if (generated) {
    console.log('');
    console.log('  ТОКЕН (показывается один раз, сохраните его):');
    console.log('');
    console.log(`    ${token}`);
    console.log('');
    console.log('  Войти: открыть приложение и вставить токен. Токен не истекает.');
    console.log('  Чтобы задать свой, удалите пользователя и запустите seed с ADMIN_TOKEN.');
  } else {
    console.log('');
    console.log('  Токен взят из ADMIN_TOKEN. В базе лежит только его sha256.');
  }
}

main()
  .catch((error: unknown) => {
    console.error('Не удалось создать администратора:');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectDatabase();
  });