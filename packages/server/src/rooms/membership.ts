import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

/**
 * Права внутри комнаты.
 *
 * Вынесено отдельно от роутов, потому что правила «кто может что» читаются
 * чаще, чем пишутся, и должны быть в одном месте, а не размазаны по
 * обработчикам.
 *
 * Здесь важно одно решение: проверка прав идёт **по базе**, а не по тому, что
 * пришло в теле запроса. Пользователь может подделать `role` в теле
 * `POST /api/rooms/:id/invite` — но проверяем не переданное значение, а то,
 * что лежит в `RoomMember`.
 */
export type Db = PrismaClient;

/** Участник ли комнаты. */
export async function isMember(db: Db, roomId: string, userId: string): Promise<boolean> {
  const count = await db.roomMember.count({ where: { roomId, userId } });
  return count > 0;
}

/** Владелец ли комнаты. Роль в `RoomMember` — источник правды, не колонка `ownerId`. */
export async function isOwner(db: Db, roomId: string, userId: string): Promise<boolean> {
  const member = await db.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { role: true },
  });
  return member?.role === 'owner';
}

/**
 * Роль участника либо `null`, если человек не в комнате.
 *
 * Роль в базе — строка, а не enum: набор значений расширяем. Поэтому здесь
 * явное сужение до двух известных значений, и всё остальное считается
 * «не участник». Для проверки прав это безопасная сторона: неизвестная роль
 * не должна давать доступ.
 */
export async function memberRole(
  db: Db,
  roomId: string,
  userId: string,
): Promise<'owner' | 'member' | null> {
  const member = await db.roomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { role: true },
  });
  const role = member?.role;
  if (role === 'owner') return 'owner';
  if (role === 'member') return 'member';
  return null;
}

/**
 * Порядок участников комнаты: сначала те, кто пришёл раньше.
 *
 * Порядок важен при передаче владения: следующим владельцем становится самый
 * ранний из оставшихся, а не случайный. Иначе после ухода хозяина комната
 * досталась бы тому, кто пришёл вчера, просто потому, что сейчас его строка
 * оказалась первой в выдаче без сортировки.
 *
 * Второй ключ — `id`. Первый по времени не уникален: несколько участников
 * могут получить одну и ту же метку `joinedAt` в одном запросе, и тогда порядок
 * между ними зависел бы от того, как база вернула строки.
 *
 * Тип задан явно, а не через `as const`: константный массив получается
 * readonly, а Prisma ждёт изменяемый, и подстановка не проходит типизацию.
 */
export const MEMBERS_BY_JOINING: Prisma.RoomMemberOrderByWithRelationInput[] = [
  { joinedAt: 'asc' },
  { id: 'asc' },
];