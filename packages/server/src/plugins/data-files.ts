import fastifyStatic from '@fastify/static';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { env } from '../env.js';
import type { App } from '../lib/app-type.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Раздача файлов из DATA_DIR: книги, аудио, обложки, производные главы.
 *
 * ─── Ограничение, которое снимется следующим подэтапом ────────────────────────
 *
 * Сейчас эти файлы доступны любому, кто знает путь. Аутентификации ещё нет, и
 * закрыть её здесь нечем: токен проверяется на маршрутах `/api`, а у статики
 * нет места, где он был бы предъявлен. До появления `/api/auth` раздача файлов
 * уязвима по построению, и об этом нужно помнить, а не забыть: файлы лежат под
 * именами вида `files/<bookId>/original.epub`, bookId известен любому, кто был
 * в комнате.
 *
 * Что можно сделать уже сейчас, не дожидаясь аутентификации: проверить путь и
 * не отдавать каталоги. Это делается ниже.
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
    const raw = request.url.split('?')[0] ?? '';
    const decoded = safeDecode(raw);

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
  });

  logger.info({ root }, 'раздача файлов подключена');
}

/** Декодирование percent-encoding. `null`, если строка нечитаема. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}