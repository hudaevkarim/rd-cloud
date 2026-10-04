import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

/**
 * Клиент Prisma.
 *
 * В Prisma 7 движок Rust убран, и клиент работает поверх обычного драйвера.
 * Поэтому нужен адаптер: `PrismaPg` — это мост к `pg`. Настройки пула берутся
 * из `pg` (у него свой таймаут соединения), а не из Prisma.
 *
 * Синглтон: клиент держит пул соединений, и создавать его на каждый запрос
 * означало бы открывать новое соединение каждый раз. Модуль кэшируется сам.
 */
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: env.isProduction ? 10 : 5,
});

export const prisma = new PrismaClient({
  adapter,
  log: env.LOG_LEVEL === 'debug' ? ['warn', 'error'] : ['error'],
});

/**
 * Проверка связи с базой при старте.
 *
 * Без неё сервер поднимется и будет отвечать 200 на `/health`, хотя базы нет,
 * — и отказ обнаружится только когда кто-то попробует открыть комнату.
 */
export async function connectDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  logger.info('база данных доступна');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('соединение с базой закрыто');
}

/**
 * Тип ошибки Prisma для уникальных нарушений.
 *
 * Импорт типа из сгенерированного клиента: иначе пришлось бы сравнивать
 * `code` с магической строкой `'P2002'` в коде маршрутов, где об этом ничего
 * не подсказывает.
 */
export type { Prisma } from '../generated/prisma/client.js';