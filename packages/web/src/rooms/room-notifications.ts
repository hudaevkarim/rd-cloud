import type { WireNotification } from '../api/types.js';

/**
 * Тексты уведомлений.
 *
 * Единое место, потому что три места читают один и тот же `notification:new`:
 * лобби, страница комнаты и тост. Расхождение между ними выглядело бы как
 * «в лобби написано одно, на странице другое» — при одном и том же событии.
 *
 * Тип уведомления известен из `payload.type`, но это значение приходит с
 * сервера строкой. Неизвестный тип обязан давать нейтральный текст, а не
 * `undefined`: сервер может добавить тип раньше клиента, и тогда человек увидел
 * бы пустой тост вместо понятного сообщения.
 */
export function describeNotification(note: WireNotification): { text: string; tone: 'info' | 'error' } {
  const roomName = note.payload.roomName ?? 'комнату';
  const userName = note.payload.userName ?? 'Кто-то';

  switch (note.type) {
    case 'join_request':
      // Владельцу и участникам приходит одно и то же, и имя комнаты в тексте
      // обязательно: без него при нескольких комнатах непонятно, куда идти.
      return { text: `${userName} просится в «${roomName}»`, tone: 'info' };

    case 'join_approved':
      return { text: `Вас приняли в «${roomName}»`, tone: 'info' };

    case 'join_rejected':
      // Тон «ошибка»: человеку отказали, и это стоит держать дольше и заметнее.
      return { text: `В «${roomName}» вашу заявку отклонили`, tone: 'error' };

    case 'kicked':
      return { text: `Вас исключили из «${roomName}»`, tone: 'error' };

    case 'added':
      return { text: `Вас добавили в «${roomName}»`, tone: 'info' };

    case 'reaction':
      return { text: `${userName} отреагировал на ваш комментарий`, tone: 'info' };

    case 'reply':
      return { text: `${userName} ответил на ваш комментарий`, tone: 'info' };

    case 'new_book':
      return { text: `В «${roomName}» добавили книгу`, tone: 'info' };

    default:
      return { text: 'Новое уведомление', tone: 'info' };
  }
}

/**
 * Комната, к которой относится уведомление.
 *
 * Нужна лобби, чтобы понять, что человек теперь участник: комната появилась в
 * его списке, и без перезапроса он этого не увидит.
 */
export function roomOfNotification(note: WireNotification): string | null {
  return note.payload.roomId ?? null;
}