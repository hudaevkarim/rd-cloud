import { randomInt } from 'node:crypto';

/**
 * Код приглашения.
 *
 * 8 знаков из 32-символьного алфавита, в котором нет `0`, `O`, `1`, `I` и `l`.
 *
 * Исключения — не украшение. Код читают вслух и переписывают на бумаге, часто
 * по телефону, где «ноль» и «о» звучат одинаково. `1`/`I`/`l` путают при
 * разглядывании, а ошибка в коде стоит чужого времени и не сообщает, что
 * неверна именно она: человек перебирает коды по кругу и думает, что его
 * исключили.
 *
 * 31 символ в 8 позициях даёт около 2^40 вариантов. Для двадцати
 * пользователей и нескольких сотен комнат перебор вслепую бессмысленен, а
 * настоящая защита входа — токен, а не код.
 *
 * Счёт проверен тестом: 23 буквы (все 26 минус I, L, O) плюс 8 цифр. Раньше
 * здесь стояло «32 символа», и это было неверно — цифр не девять, а восемь, и
 * одна девятка выпала бы при добавлении нового знака.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без 0 O 1 I L l
const CODE_LENGTH = 8;

/** Алфавит без неоднозначных символов — по нему и проверяем вход. */
export const INVITE_ALPHABET = ALPHABET;

export function generateInviteCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/**
 * Приводит код к каноническому виду и проверяет алфавит.
 *
 * Регистр не значим: код диктуют по телефону с латинской раскладки, и
 * `abc123` от человека и `ABC123` от системы — это один и тот же код.
 *
 * `I`/`l` превращаем в `1`... нет, `1` в алфавите нет вовсе. Всё, чего в
 * алфавите нет, отвергается: иначе код с `0` или `O` оказался бы в базе и не
 * нашёлся бы по сгенерированному варианту.
 */
export function normalizeInviteCode(raw: string): string | null {
  const upper = raw.trim().toUpperCase();
  if (upper.length !== CODE_LENGTH) return null;
  for (const ch of upper) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return upper;
}

/** Стандартный формат ответа API для комнаты. */
export function isValidInviteCode(value: unknown): value is string {
  return typeof value === 'string' && normalizeInviteCode(value) !== null;
}