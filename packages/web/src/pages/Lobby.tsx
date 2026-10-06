import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { plural, rooms as roomsApi } from '../api/client.js';
import type { RoomSummary } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { CreateRoomDialog } from '../rooms/CreateRoomDialog.js';
import { JoinByCodeDialog } from '../rooms/JoinByCodeDialog.js';
import { useQuery } from '../rooms/room-queries.js';
import { useRoomSocket } from '../rooms/useRoomSocket.js';
import type { WireNotification } from '../api/types.js';

/**
 * Лобби: мои комнаты.
 *
 * ─── Почему список подписан на сокет ─────────────────────────────────────────
 *
 * Комната появляется у человека не в тот момент, когда он нажимает кнопку, а
 * когда его приняли или добавили по ссылке — и он узнаёт об этом по уведомлению,
 * а комнаты в списке ещё нет. Без перезапроса на уведомление человек увидел бы
 * тост «Вас добавили» и список без этой комнаты, и решил бы, что его обманули.
 * Поэтому событие по комнате перезапрашивает список целиком: список короткий,
 * а выборочно дописать комнату из уведомления нельзя — в уведомлении нет ни
 * названия, ни числа книг.
 *
 * ─── Почему это страница, а не лента событий ──────────────────────────────────
 *
 * Фильтровать события по «моя это комната или нет» нельзя: уведомление приходит
 * человеку, и проверить принадлежность можно только запросом. Единственный
 * честный признак — «уведомление вообще пришло», и он не различает комнаты.
 * Значит перезапрос на любое событие по комнате — единственный вариант, который
 * не врёт.
 */
export function LobbyPage() {
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  const rooms = useQuery<RoomSummary[]>((signal) => roomsApi.list(), []);
  const reload = rooms.reload;

  /**
   * Любое событие по комнате перезапрашивает список.
   *
   * `kicked` здесь же: комнаты надо из списка убрать, а перезапрос уберёт её
   * сам. Отдельной логики удаления не нужно — список приходит с сервера целиком
   * и без неё.
   *
   * Нас интересуют только события, меняющие состав комнат. Реакция на
   * комментарий тоже приходит через `notification:new`, и перезапрос списка на
   * неё был бы лишним запросом на каждое сердечко в книге.
   */
  const onNotification = useCallback(
    (note: WireNotification) => {
      if (
        note.type === 'added' ||
        note.type === 'join_approved' ||
        note.type === 'kicked' ||
        note.type === 'new_book'
      ) {
        reload();
      }
    },
    [reload],
  );

  useRoomSocket({ onNotification });

  return (
    <div className="page">
      <div className="page__head">
        <Label size="xs" as="p">
          МОИ КОМНАТЫ
        </Label>
        <h1 className="page__title">Лобби</h1>

        <div className="page__actions">
          <Button onClick={() => setCreating(true)}>Создать комнату</Button>
          <Button variant="ghost" onClick={() => setJoining(true)}>
            Войти по коду
          </Button>
          <Link className="link" to="/catalog">
            Каталог классики →
          </Link>
        </div>
      </div>

      <Rule />

      {rooms.status === 'loading' && (
        <div className="page__center">
          <Spinner size={20} label="Загружаем комнаты" />
        </div>
      )}

      {rooms.status === 'error' && (
        <div className="empty">
          <p className="empty__text">{rooms.error}</p>
          <Button variant="ghost" onClick={reload}>
            Попробовать снова
          </Button>
        </div>
      )}

      {rooms.status === 'ready' && rooms.data.length === 0 && (
        <div className="empty">
          <h2 className="empty__title">Пока нет ни одной комнаты</h2>
          <p className="empty__text">
            Комната — это общее место для чтения и обсуждения: книги, комментарии и
            присутствие. Создайте свою или войдите по коду приглашения.
          </p>
          <div className="empty__actions">
            <Button onClick={() => setCreating(true)}>Создать комнату</Button>
            <Button variant="ghost" onClick={() => setJoining(true)}>
              Войти по коду
            </Button>
          </div>
        </div>
      )}

      {rooms.status === 'ready' && rooms.data.length > 0 && (
        <ul className="rows">
          {rooms.data.map((room) => (
            <RoomRow key={room.id} room={room} />
          ))}
        </ul>
      )}

      <CreateRoomDialog open={creating} onClose={() => setCreating(false)} />

      {/*
        Вход по коду сам переходит в комнату, поэтому обработчика `onDone` нет:
        после успеха страница уже сменилась, и перезапрашивать список лобби
        не нужно — он и так загрузится заново при возврате.
      */}
      <JoinByCodeDialog open={joining} onClose={() => setJoining(false)} />
    </div>
  );
}

/**
 * Строка списка комнат.
 *
 * Отдельным компонентом, а не разметкой в цикле: у строки своё состояние
 * «скопировано», и без отдельного компонента оно было бы общим для всего
 * списка — скопировали ссылку у одной комнаты, а надпись поменялась у всех.
 */
function RoomRow({ room }: { room: RoomSummary }) {
  return (
    <li className="rows__item">
      <Link className="roomrow" to={`/rooms/${room.id}`}>
        <span className="roomrow__head">
          <span className="roomrow__name">{room.name}</span>
          {room.myRole === 'owner' && <span className="tag">владелец</span>}
        </span>

        {room.description !== null && room.description !== '' && (
          <span className="roomrow__desc">{room.description}</span>
        )}

        <span className="roomrow__meta label label-xs">
          {plural(room._count.members, 'участник', 'участника', 'участников')}
          {' · '}
          {plural(room._count.books, 'книга', 'книги', 'книг')}
        </span>
      </Link>
    </li>
  );
}