import type { AudioAnchor, TextAnchor } from '@rd/library/anchor';

/**
 * Валидация якорей комментариев.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────────
 *
 * Якорь лежит в базе как `Json`, и Prisma не проверяет его содержимое: в
 * колонку Json попадёт буквально что угодно. Без проверки на записи в базе
 * копится мусор, который сломается позже и не там, где был создан: комментарий
 * с `start: -5` или с `anchorType: 'text'` и `kind: 'audio'` нельзя ни найти
 * в книге, ни показать в интерфейсе.
 *
 * Поэтому проверка стоит в двух местах:
 *
 *   - на записи — чтобы мусор вообще не попал в базу;
 *   - на чтении — потому что в базу могли положить его руками, старой версией
 *     кода или миграцией.
 *
 * ─── Про format ──────────────────────────────────────────────────────────────
 *
 * Якоря три: `text`, `audio`, `page`. А `bookFileKind` — только `text` и
 * `audio`. PDF лежит в файле с `kind: 'text'`, но якоря у него `page`, иначе
 * якорь страницы не отличить от якоря абзаца.
 *
 * Поэтому `format` — третий аргумент: без него якорь `page` для PDF
 * отбрасывался бы, а для EPUB проходил бы. Сверка идёт по `format`, когда он
 * передан, и по `bookFileKind`, когда нет.
 */

/**
 * Якорь страницы PDF.
 *
 * Тип живёт здесь, а не в `@rd/library`: разбором PDF занимается клиент
 * (pdf.js), на сервере такой якорь только принимается и хранится. Тащить в
 * библиотеку тип, которым она не пользуется, незачем.
 */
export interface PageAnchor {
  kind: 'page';
  /** Номер страницы, нумерация с 1: так она выглядит в интерфейсе. */
  page: number;
  /** Необязательная цитата, если она у текстового слоя PDF есть. */
  quote?: string;
}

export type AnyAnchor = TextAnchor | AudioAnchor | PageAnchor;

/** Значение `anchorType` в базе. */
export type AnchorType = 'text' | 'timestamp' | 'page';

/**
 * Какой `anchorType` соответствует якорю.
 *
 * Отдельная функция, а не поле в структуре: `anchorType` — это индекс для
 * выборок в базе, а вычисляется он из содержимого `anchor`. Держать одно и то
 * в двух местах — значит однажды они разойдутся.
 */
export function anchorTypeOf(anchor: AnyAnchor): AnchorType {
  switch (anchor.kind) {
    case 'text':
      return 'text';
    case 'audio':
      return 'timestamp';
    case 'page':
      return 'page';
  }
}

/** Ограничения на длины текста в якоре. */
const LIMITS = {
  /** Цитата — фрагмент абзаца. Длиннее не бывает. */
  quote: 2_000,
  /** Контекст слева и справа по 32 символа — ровно CONTEXT_LEN в anchors.ts. */
  context: 200,
  /** Цитата в аудиоякоре — реплика или имя главы. */
  audioQuote: 500,
  /** Смещение внутри блока — границы текста главы. */
  offset: 10_000_000,
  /** Номер страницы. */
  page: 100_000,
  /** Длительность аудио — 1000 часов с запасом. */
  seconds: 3_600_000,
} as const;

export interface ValidationIssue {
  /** Путь до поля, как его увидит разработчик: `anchor.quote`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; anchor: AnyAnchor; anchorType: AnchorType }
  | { ok: false; issues: ValidationIssue[] };

/**
 * Проверка якоря.
 *
 * Возвращает нормализованный якорь, а не только «да/нет»: лишние поля
 * отбрасываются, числа приводятся к целым. Это важно потому, что результат
 * кладут в `Json`, и в базу не должно попасть ничего, чего там не ожидают.
 */
export function validateAnchor(
  value: unknown,
  bookFileKind: 'text' | 'audio',
  format?: string,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: [{ path: 'anchor', message: 'Якорь должен быть объектом' }] };
  }

  const raw = value as Record<string, unknown>;
  const kind = raw['kind'];

  if (typeof kind !== 'string') {
    return { ok: false, issues: [{ path: 'anchor.kind', message: 'Не указан тип якоря' }] };
  }

  // PDF — текстовый файл с якорями страниц. Формат известен только из записи о
  // файле, поэтому без него якорь страницы считаем недопустимым: иначе `page`
  // проскочил бы в EPUB, где страниц нет.
  const expected: readonly string[] =
    bookFileKind === 'audio'
      ? ['audio']
      : format === 'pdf'
        ? ['page']
        : ['text'];

  if (!expected.includes(kind)) {
    issues.push({
      path: 'anchor.kind',
      message: `Для файла типа «${bookFileKind}»${format ? ` (${format})` : ''} ожидается якорь ${expected
        .map((k) => `«${k}»`)
        .join(' или ')}, а пришёл «${kind}»`,
    });
    return { ok: false, issues };
  }

  switch (kind) {
    case 'text': {
      const chapterIndex = int(raw['chapterIndex'], 'anchor.chapterIndex', 0, LIMITS.offset, issues);
      const blockIndex = int(raw['blockIndex'], 'anchor.blockIndex', 0, LIMITS.offset, issues);
      const start = int(raw['start'], 'anchor.start', 0, LIMITS.offset, issues);
      const end = int(raw['end'], 'anchor.end', 0, LIMITS.offset, issues);
      const quote = str(raw['quote'], 'anchor.quote', LIMITS.quote, issues, false);
      const prefix = str(raw['prefix'], 'anchor.prefix', LIMITS.context, issues, true);
      const suffix = str(raw['suffix'], 'anchor.suffix', LIMITS.context, issues, true);

      // Конец раньше начала — это либо опечатка клиента, либо устаревший якорь.
      // Записывать такое нельзя: `resolveTextAnchor` такой якорь не найдёт, и
      // комментарий навсегда останется «привязанным к неизвестному месту».
      if (start !== undefined && end !== undefined && end <= start) {
        issues.push({ path: 'anchor.end', message: 'Конец выделения должен быть позже начала' });
      }
      if (quote !== undefined && quote.trim() === '') {
        issues.push({ path: 'anchor.quote', message: 'Пустая цитата' });
      }

      if (issues.length > 0) return { ok: false, issues };

      const anchor: TextAnchor = {
        kind: 'text',
        chapterIndex: chapterIndex as number,
        blockIndex: blockIndex as number,
        start: start as number,
        end: end as number,
        quote: quote as string,
        prefix: prefix ?? '',
        suffix: suffix ?? '',
      };
      return { ok: true, anchor, anchorType: 'text' };
    }

    case 'audio': {
      const timeSec = int(raw['timeSec'], 'anchor.timeSec', 0, LIMITS.seconds, issues);
      const quote = str(raw['quote'], 'anchor.quote', LIMITS.audioQuote, issues, true);
      if (issues.length > 0) return { ok: false, issues };

      const anchor: AudioAnchor = { kind: 'audio', timeSec: timeSec as number };
      if (quote !== undefined) anchor.quote = quote;
      return { ok: true, anchor, anchorType: 'timestamp' };
    }

    case 'page': {
      const page = int(raw['page'], 'anchor.page', 1, LIMITS.page, issues);
      const quote = str(raw['quote'], 'anchor.quote', LIMITS.quote, issues, true);
      if (issues.length > 0) return { ok: false, issues };

      const anchor: PageAnchor = { kind: 'page', page: page as number };
      if (quote !== undefined) anchor.quote = quote;
      return { ok: true, anchor, anchorType: 'page' };
    }

    default:
      return {
        ok: false,
        issues: [{ path: 'anchor.kind', message: `Неизвестный тип якоря «${kind}»` }],
      };
  }
}

function int(
  value: unknown,
  path: string,
  min: number,
  max: number,
  issues: ValidationIssue[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    issues.push({ path, message: 'Ожидалось целое число' });
    return undefined;
  }
  if (value < min || value > max) {
    issues.push({ path, message: `Должно быть от ${min} до ${max}` });
    return undefined;
  }
  return value;
}

function str(
  value: unknown,
  path: string,
  max: number,
  issues: ValidationIssue[],
  optional: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (!optional) issues.push({ path, message: 'Обязательное поле' });
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push({ path, message: 'Ожидалась строка' });
    return undefined;
  }
  if (value.length > max) {
    issues.push({ path, message: `Длиннее ${max} символов` });
    return undefined;
  }
  return value;
}

/** Понятный текст для интерфейса: `anchor.start: Должно быть от 0 до …`. */
export function describeIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}