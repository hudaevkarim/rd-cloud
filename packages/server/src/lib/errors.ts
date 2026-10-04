/**
 * Ошибки приложения и ответ клиенту.
 *
 * Разделение на два уровня:
 *
 *   - `AppError` — ошибка, которую мы знаем и хотим показать: «комната не
 *     найдена», «нет доступа», «поле заполнено неверно». Клиент получает её
 *     `message` как есть.
 *   - всё остальное — внутренняя ошибка. Клиент получает только код и
 *     нейтральный текст, а подробности уходят в лог.
 *
 * Если отдавать наружу сообщение любой ошибки, то SQL из Prisma с названиями
 * таблиц и колонок уедет к тому, кто запросил 404. Поэтому граница проходит
 * по типу ошибки, а не по флажку.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Дополнительные поля, безопасные для показа: `{ field: '...' }`. */
  readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static notFound(what = 'Ресурс'): AppError {
    return new AppError(404, 'not_found', `${what} не найден`);
  }

  static forbidden(message = 'Нет доступа'): AppError {
    return new AppError(403, 'forbidden', message);
  }

  static unauthorized(message = 'Требуется вход'): AppError {
    return new AppError(401, 'unauthorized', message);
  }

  static badRequest(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(400, 'bad_request', message, details);
  }

  static conflict(message: string): AppError {
    return new AppError(409, 'conflict', message);
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}