import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger as PinoLogger } from 'pino';

/**
 * Тип собранного приложения.
 *
 * Существует из-за одной особенности Fastify: когда в конструктор передаётся
 * `loggerInstance`, тип логгера выводится из аргумента, и `FastifyInstance`
 * без параметров перестаёт быть совместимым с тем, что вернул конструктор.
 *
 * Из-за этого `app`, собранный с pino, нельзя было передать в
 * `registerHealth(app: FastifyInstance)` — ошибка возникала в типах, а не в
 * коде, и выглядела невнятно. Здесь тип объявлен явно.
 *
 * Параметры повторяют то, что выводит конструктор: сервер и запрос —
 * стандартные для Node, а логгер — `PinoLogger<never, boolean>`. Написать
 * `PinoLogger` без параметров нельзя: по умолчанию там `string`, а Fastify
 * выводит `never`, и это расхождение снова ломает совместимость.
 */
export type Logger = PinoLogger<never, boolean>;

export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;