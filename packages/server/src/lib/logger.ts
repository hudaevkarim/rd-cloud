import { pino } from 'pino';
import { env } from '../env.js';

/**
 * Логи.
 *
 * В development — человекочитаемый вывод с раскраской, в production — JSON,
 * потому что его разбирают машины. Уровень из LOG_LEVEL.
 *
 * Явно выключены `redact`: токен авторизации и пароль из DATABASE_URL не должны
 * осесть в логах. В базе лежит только sha256 токена, но заголовок
 * `Authorization` в логе — это уже готовый доступ ко всем аккаунтам.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.tokenHash'],
    censor: '[скрыто]',
  },
  transport: env.isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
});

export type Logger = typeof logger;