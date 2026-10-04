import fastifyStatic from '@fastify/static';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { env } from '../env.js';
import type { App } from '../lib/app-type.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { extractToken } from '../auth/guards.js';
import { hashToken } from '../auth/tokens.js';
import { prisma } from '../db/client.js';

const PREFIX = '/files';

/**
 * Раздача файлов из DATA_DIR: книги, аудио, обложки, производные главы.
 *
 * ─── Что здесь закрыто ───────────────────────────────────────────────────────
 *
 * Раздача защищена токеном: cookie `rd_token` либо `?t=<token>`. Cookie нужна
 * потому, что заголовок `Authorization` браузер не умеет вешать на `<img>` и
 * `<audio>`; query-параметр оставлен запасным путём для тех же случаев и
 * включается только здесь — на `/api` он запрещён, потому что токен в URL
 * попадает в логи и в заголовок `Referer`.
 *
 * ─── Защита от path traversal ────────────────────────────────────────────────
 *
 * Проверка идёт ДО того, как `@fastify/static` что-либо отдаст, и состоит из
 * трёх ступеней, потому что одной недостаточно:
 *
 *   1. Схема и разделители. URL — это всегда `/`, независимо от системы. Если
 *      на запрос пришёл `\` или URL-encoded `%2F`, такой запрос отбрасывается:
 *      иначе обход упирается только в то, как `@fastify/static` разберёт путь,
 *      и это не наше решение.
 *   2. Нормализация и `..`. `%2e%2e%2f` декодируется в `../`, и проверка на
 *      сырой строке его не увидит. Поэтому декодируем сами и уже потом ищем
 *      переходы.
 *   3. Итоговый путь обязан лежать внутри DATA_DIR. Это единственная проверка,
 *      которая не может ошибиться: даже если первые две пропустили что-то
 *      новое, путь за пределами каталога всё равно не пройдёт.
 */
export async function registerDataFiles(app: App): Promise<void> {
  const root = resolve(env.DATA_DIR);

  // Каталог создаётся при старте. Без этого `@fastify/static` падает на
  // отсутствующем root, и сервер не поднимается на свежей копии репозитория,
  // где ни одной книги ещё нет. Создавать его должен сервер, а не человек:
  // забытый каталог — это не повод не запускаться.
  await mkdir(root, { recursive: true });

  await app.register(fastifyStatic, {
    root,
    prefix: '/files/',
    index: false,
    dotfiles: 'deny',
    // Не отдавать листинги: неизвестный путь должен давать 404, а не перечень.
    list: false,
    // Range включён по умолчанию, но задаётся явно: без него аудиокнига
    // не перематывается и не запускается с середины.
    acceptRanges: true,
    // Заголовки выставляются для каждого ответа, потому что в файле книги
    // может лежать что угодно, а `nosniff` не даёт браузеру «угадать» тип и
    // выполнить содержимое как скрипт.
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    // Хук висит на корневой области (у @fastify/static своя изоляция есть не
    // всегда, и полагаться на неё нельзя), поэтому он видит ВСЕ запросы и
    // обязан сам ограничить свою область префиксом. Без этой проверки он
    // требовал токен у /api/auth/login и у /health, и вход в систему был
    // невозможен: логин возвращал 401.
    const raw = request.url.split('?')[0] ?? '';
    if (raw !== PREFIX && !raw.startsWith(`${PREFIX}/`)) return;

    const decoded = safeDecode(raw);

    // Сначала проверка пути, потом прав: отказ по пути не должен стоить
    // обращения к базе, а обращение к базе не должно происходить для запроса,
    // который всё равно будет отклонён.
    if (decoded === null) {
      // Нечитаемый percent-encoding — не отвечаем, а логируем: клиент прислал
      // мусор, и это повод посмотреть, не пробует ли кто-то обход.
      logger.warn({ url: raw }, 'нечитаемый путь в запросе файла');
      throw AppError.badRequest('Некорректный путь');
    }

    if (decoded.includes('\0')) throw AppError.badRequest('Некорректный путь');
    if (decoded.includes('\\')) throw AppError.badRequest('Некорректный путь');
    if (decoded.split('/').some((part) => part === '..')) {
      throw AppError.badRequest('Некорректный путь');
    }

    // Третья ступень: проверяем не исходную строку, а итоговый путь.
    const target = resolve(join(root, decoded));
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw AppError.badRequest('Некорректный путь');
    }
    // На Windows разделитель в `relative` — `\`, а в URL — `/`. Сравнение
    // делаем с обоими, иначе проверка на этой платформе ослаблена.
    if (rel.startsWith(`..${sep}`) || rel.startsWith('../')) {
      throw AppError.badRequest('Некорректный путь');
    }

    // Права: нужен действующий токен — cookie или `?t=`.
    //
    // `requireAuth` сам извлекает токен, но `allowQuery` у него выключен по
    // умолчанию. Здесь он включается: только этот префикс и только для статики.
    await requireAuthWithQuery(request, reply);
  });

  logger.info({ root }, 'раздача файлов подключена, требуется токен');
}

/**
 * Проверка прав для статики: токен в cookie или в `?t=`.
 *
 * Отдельная обёртка над `requireAuth`, потому что `extractToken` по умолчанию
 * не смотрит в query — и это правильно для `/api`, но не для `<img>`.
 */
async function requireAuthWithQuery(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractToken(request, { allowQuery: true });
  if (token === null) throw AppError.unauthorized('Требуется токен');

  const user = await prisma.user.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true },
  });
  if (user === null) throw AppError.unauthorized('Неверный токен');
}

/** Декодирование percent-encoding. `null`, если строка нечитаема. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}