import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { plural, books as booksApi, rooms as roomsApi } from '../api/client.js';
import type {
  BookSummary,
  JoinRequest,
  Room,
  RoomMember,
  RoomSummary,
  RoomTab,
  WireNotification,
} from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../components/ui/Toast.js';
import { useAuth } from '../auth/auth-context.js';
import { Avatar } from './Avatar.js';
import { messageOf, useQuery, type QueryState } from './room-queries.js';
import { useRoomSocket, type BookAddedPayload } from './useRoomSocket.js';
import { isEvicted, isJoinRequest } from './Notifications.js';
import { BooksTab } from '../books/BooksTab.js';

/**
 * Страница комнаты.
 *
 * ─── Вкладки, а не разделы со ссылками ───────────────────────────────────────
 *
 * Три вкладки живут на одной странице и меняют только содержимое. Свои адреса
 * дали бы истории браузера лишние шаги назад, а состояние пришлось бы хранить в
 * URL — и ссылка «открыть заявки» перестала бы работать во второй вкладке.
 *
 * ─── Почему вход в комнату сокетом, а не запросом ───────────────────────────
 *
 * `room:join` отдаёт список присутствия, и без него страница показала бы «никто
 * не читает», пока остальные не двинули страницу. Выход обязателен и происходит
 * при размонтировании: иначе ушедший остался бы в списке читателей до обрыва
 * сокета, а это может занять минуты.
 */
export function RoomView({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();

  const [tab, setTab] = useState<RoomTab>('books');

  /**
   * Кто сейчас в комнате.
   *
   * Хранится по `userId`, а не списком: события приходят по одному человеку, и
   * список означал бы поиск по нему на каждое событие. Уход человека удаляет
   * запись, а не помечает её — иначе «ушедшие» копились бы до перезагрузки.
   */
  const [online, setOnline] = useState<Record<string, true>>({});

  const room = useQuery<Room>(async () => roomsApi.get(roomId), [roomId]);
  const reloadRoom = room.reload;

  /*
    Заявки запрашиваются здесь, а не по одному разу во вкладках.

    Раньше список брали и `RoomTabs` для счётчика, и `RequestsTab` для строк —
    два независимых запроса одних и тех же данных. После «Принять» обновлялся
    только тот, к которому относилось нажатие, и счётчик на вкладке оставался с
    прежним числом. Наблюдалось вживую: в списке две заявки, на вкладке «Заявки3».

    Общий запрос — ещё и потому, что на вкладку «Заявки» нужно смотреть, не
    переключаясь на неё: иначе заявка, пришедшая при открытой другой вкладке,
    осталась бы незамеченной.
  */
  const requests = useQuery<JoinRequest[]>(async () => roomsApi.joinRequests(roomId), [roomId]);

  /*
    Книги запрашиваются здесь, а не внутри вкладки.

    Причина та же, что с заявками: список нужен в двух местах — во вкладке и как
    счётчик в шапке, — а два независимых запроса означали бы, что одно из них
    показывает старое. Здесь, кроме того, живёт подписка на `book:added` и
    `book:removed`: внутри вкладки она снималась бы при уходе на «Участники», и
    книга, добавленная в этот момент, осталась бы незамеченной.
  */
  const books = useQuery<BookSummary[]>(async () => booksApi.listInRoom(roomId), [roomId]);

  const onPresenceChanged = useCallback(
    (entry: { roomId: string; userId: string }) => {
      // Чужая комната: события приходят по всем комнатам, где мы состоим, и в
      // словарь попали бы посторонние.
      if (entry.roomId !== roomId) return;
      setOnline((current) => ({ ...current, [entry.userId]: true }));
    },
    [roomId],
  );

  const onPresenceLeft = useCallback(
    (payload: { roomId: string; userId: string }) => {
      if (payload.roomId !== roomId) return;
      setOnline((current) => {
        const next = { ...current };
        delete next[payload.userId];
        return next;
      });
    },
    [roomId],
  );

  /**
   * На исключении уходим в лобби.
   *
   * Открывать комнату после исключения бессмысленно: сервер отдаст 403, и вместо
   * «вас исключил хозяин» человек увидел бы «нет доступа» без причины.
   */
  const onNotification = useCallback(
    (note: WireNotification) => {
      if (isEvicted(note, roomId)) {
        navigate('/', { replace: true });
        return;
      }

      /*
        Новая заявка меняет ровно список заявок, и перезапрашивается именно он.
        Раньше здесь вызывался `reloadRoom`, а сам список обновлялся только при
        нажатии «Принять» — то есть счётчик на вкладке отставал.
      */
      if (isJoinRequest(note, roomId)) requests.reload();
    },
    [roomId, navigate, requests.reload],
  );

  /*
    События книг — сигнал «перечитай список».

    Не вставлять книгу в список по событию: в событии шесть полей, а строке нужны
    ещё формат файла, размер и признак разбора. Без второго запроса строка показала
    бы выдуманные сведения, а по F5 всё встало бы на место — то есть человек видел
    бы разные данные в зависимости от того, обновлял он страницу или нет.
  */
  const onBookAdded = useCallback(
    (payload: BookAddedPayload) => {
      if (payload.roomId !== roomId) return;
      books.reload();
      toast.info(
        payload.source === 'upload'
          ? `${payload.addedBy.displayName} загрузил(а) «${payload.book.title}»`
          : `${payload.addedBy.displayName} добавил(а) «${payload.book.title}» из каталога`,
      );
    },
    [roomId, books.reload, toast],
  );

  const onBookRemoved = useCallback(
    (payload: { roomId: string; bookId: string }) => {
      if (payload.roomId !== roomId) return;
      books.reload();
    },
    [roomId, books.reload],
  );

  const socket = useRoomSocket({
    onNotification,
    onPresenceChanged,
    onPresenceLeft,
    onBookAdded,
    onBookRemoved,
  });

  /**
   * Флаг «мы вошли» живёт в ref, а не в состоянии.
   *
   * Ответ приходит асинхронно, и если между отправкой `room:join` и размонтированием
   * страница успеет уйти, cleanup не знает, посетили ли мы комнату. Отправлять
   * `room:leave` вслепую нельзя: сервер снимет подписку и у другой комнаты, если
   * человек перешёл между ними.
   */
  const joined = useRef(false);

  useEffect(() => {
    if (socket === null || room.status !== 'ready') return;

    joined.current = false;

    /*
      Список присутствия приходит в ответе на вход, а не отдельным событием:
      иначе новичок видел бы «никого не читает», пока остальные не двинули
      страницу. Присутствие обнуляется перед входом, а не после — список
      предыдущей комнаты иначе мелькал бы на новой.
    */
    setOnline({});
    socket.emit('room:join', { roomId }, (result) => {
      joined.current = result.ok;
      if (!result.ok) return;

      /*
        Список от сервера — это «кто ещё читает», и **не включает вошедшего**:
        сервер кладёт человека в карту присутствия только по `presence:update`,
        то есть когда тот двинул страницу книги. Пока этого не случилось, в
        ответе его нет.

        Поэтому вошедший добавляется здесь. Иначе страница показывала бы «0
        человек читает сейчас» человеку, который только что открыл комнату и
        читает прямо сейчас.
      */
      const present: Record<string, true> = user === null ? {} : { [user.id]: true };
      for (const member of result.members ?? []) present[member.userId] = true;
      setOnline(present);
    });

    return () => {
      if (joined.current) socket.emit('room:leave', { roomId });
      joined.current = false;
    };
  }, [socket, roomId, room.status, user?.id]);

  if (room.status === 'loading') {
    return (
      <div className="page page--center">
        <Spinner size={20} label="Открываем комнату" />
      </div>
    );
  }

  if (room.status === 'error') {
    return (
      <div className="page page--center">
        <h1 className="placeholder__title">Комната недоступна</h1>
        <p className="placeholder__hint">{room.error}</p>
        <Button onClick={() => navigate('/')}>В лобби</Button>
      </div>
    );
  }

  const data = room.data;
  const report = toast.info;
  const reportError = toast.error;

  /*
    Онлайн считается по словарю, а не по `data._count.members`: это разные вещи,
    и подставлять одно вместо другого означало бы врать — «3 человека читают»
    там, где читает один.
  */
  const onlineCount = Object.keys(online).length;

  const pendingRequests = requests.status === 'ready' ? requests.data.length : 0;

  return (
    <div className="page">
      <div className="roomhead">
        <Label size="xs" as="p">
          КОМНАТА
        </Label>
        <h1 className="roomhead__name">{data.name}</h1>
        {data.description !== null && data.description !== '' && (
          <p className="roomhead__desc">{data.description}</p>
        )}

        {onlineCount > 0 && (
          /*
            Счётчик онлайна виден без списка участников: человек должен понимать,
            что комната живая, не листая вкладки. И он не нужен, когда никого нет —
            «0 сейчас читает» читалось бы как «комната мертва».
          */
          <p className="roomhead__online label label-xs">
            {plural(onlineCount, 'человек читает', 'человека читают', 'человек читают')} сейчас
          </p>
        )}

        <div className="roomhead__actions">
          <Button variant="ghost" onClick={() => void copyInvite(data, report)}>
            Пригласить
          </Button>
          {data.myRole === 'owner' && (
            <>
              <Button variant="ghost" onClick={() => void renameRoom(data, reloadRoom, reportError)}>
                Переименовать
              </Button>
              <Button
                variant="ghost"
                onClick={() => void editDescription(data, reloadRoom, reportError)}
              >
                Описание
              </Button>
              <Button
                variant="danger"
                onClick={() => void deleteRoom(data, navigate, report)}
              >
                Удалить
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            onClick={() => void leaveRoom(data, navigate, report)}
          >
            Покинуть
          </Button>
        </div>
      </div>

      <RoomTabs active={tab} onChange={setTab} pending={pendingRequests} />

      <Rule />

      {tab === 'books' && <BooksTab room={data} books={books} reloadBooks={books.reload} />}
      {tab === 'members' && <MembersTab room={data} online={online} />}
      {tab === 'requests' && <RequestsTab roomId={roomId} requests={requests} />}
    </div>
  );
}

/**
 * Вкладки комнаты.
 *
 * Счётчик заявок ставится только когда есть что считать: ноль на вкладке
 * «Заявки» читался бы как «проверьте, может что и есть», а человек не знает,
 * надо ли нажимать.
 */
function RoomTabs({
  active,
  onChange,
  pending,
}: {
  active: RoomTab;
  onChange: (tab: RoomTab) => void;
  /** Сколько заявок ждут. Число передаётся, а не запрашивается здесь. */
  pending: number;
}) {
  const tabs: Array<{ id: RoomTab; label: string }> = [
    { id: 'books', label: 'Книги' },
    { id: 'members', label: 'Участники' },
    { id: 'requests', label: 'Заявки' },
  ];

  return (
    <div className="tabs" role="tablist" aria-label="Разделы комнаты">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={`tabs__tab${active === t.id ? ' is-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.id === 'requests' && pending > 0 && (
            <span className="tabs__count">{pending}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Участники.
 *
 * Список строками, а не сетка кружков: кружки нужны как индикатор присутствия,
 * а здесь у каждого человека есть имя и роль, и они читаются в строке. Сетка из
 * безымянных кружков означала бы «люди» без «кто есть кто».
 *
 * Точка на кружке — присутствие из сокета. Она ставится по словарю, который
 * приходит в ответе на `room:join` и пополняется событиями `presence:*`.
 */
function MembersTab({ room, online }: { room: Room; online: Record<string, true> }) {
  const members = useQuery<RoomMember[]>((signal) => roomsApi.members(room.id), [room.id]);
  const reload = members.reload;

  if (members.status === 'loading') {
    return (
      <div className="page__center">
        <Spinner size={20} label="Загружаем участников" />
      </div>
    );
  }
  if (members.status === 'error') {
    return <p className="empty__text">{members.error}</p>;
  }

  const isOwner = room.myRole === 'owner';

  return (
    <ul className="rows">
      {members.data.map((member) => (
        <li className="rows__item" key={member.userId}>
          <div className="memberrow">
            <Avatar name={member.user.displayName} online={online[member.userId] === true} />

            <span className="memberrow__name">{member.user.displayName}</span>

            {member.role === 'owner' && <span className="tag">владелец</span>}

            {/*
              Кнопка есть только у владельца и только для не-владельцев.
              Исключить себя нельзя — сервер откажет с 400, и человек увидел бы
              ошибку на действии, которое сам интерфейс и предложил.
            */}
            {isOwner && member.role !== 'owner' && (
              <button
                type="button"
                className="link link--danger"
                onClick={() =>
                  void removeMember(room.id, member.user.displayName, member.userId, reload)
                }
              >
                Исключить
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Заявки.
 *
 * Видны любому участнику: одобрять может любой, и скрывать список от того, кто
 * имеет право его разбирать, незачем.
 */
function RequestsTab({
  roomId,
  requests,
}: {
  roomId: string;
  requests: QueryState<JoinRequest[]>;
}) {
  const reload = requests.reload;

  if (requests.status === 'loading') {
    return (
      <div className="page__center">
        <Spinner size={20} label="Загружаем заявки" />
      </div>
    );
  }
  if (requests.status === 'error') {
    return <p className="empty__text">{requests.error}</p>;
  }

  if (requests.data.length === 0) {
    return (
      <div className="empty">
        <h2 className="empty__title">Заявок нет</h2>
        <p className="empty__text">
          Поделитесь ссылкой-приглашением — по ней человек попадёт сразу, без заявки.
        </p>
      </div>
    );
  }

  return (
    <ul className="rows">
      {requests.data.map((request) => (
        <li className="rows__item" key={request.id}>
          <div className="requestrow">
            <Avatar name={request.user.displayName} />

            <span className="requestrow__name">{request.user.displayName}</span>

            <span className="label label-xs">{formatDate(request.createdAt)}</span>

            <span className="requestrow__actions">
              <Button onClick={() => void approve(roomId, request.id, reload)}>Принять</Button>
              <Button variant="ghost" onClick={() => void reject(roomId, request.id, reload)}>
                Отклонить
              </Button>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ─── Действия ─────────────────────────────────────────────────────────────── */

/**
 * Ссылка-приглашение.
 *
 * `window.location.origin` вместо жёсткого домена: адрес меняется между
 * localhost, Cloudflare Tunnel и будущим настоящим доменом, а ссылка должна
 * работать везде.
 *
 * `navigator.clipboard` есть только в защищённом контексте. На http его нет, и
 * без запасного пути «Пригласить» молча ничего не сделала бы — хуже, чем
 * показать саму ссылку текстом.
 */
export async function copyInvite(
  room: Pick<RoomSummary, 'inviteCode'>,
  report: (text: string) => void,
): Promise<void> {
  const link = `${window.location.origin}/join/${room.inviteCode}`;

  try {
    await navigator.clipboard.writeText(link);
    report('Ссылка скопирована');
  } catch {
    report(link);
  }
}

async function renameRoom(
  room: RoomSummary,
  reload: () => void,
  fail: (text: string) => void,
): Promise<void> {
  const answer = window.prompt('Новое название', room.name);
  if (answer === null) return;
  const trimmed = answer.trim();
  if (trimmed === '') return;

  try {
    await roomsApi.update(room.id, { name: trimmed });
    reload();
  } catch (err) {
    // `prompt` не умеет показывать ошибку, а молча не сделать хуже: человек
    // увидел бы, что ничего не изменилось, и не понял бы почему.
    fail(messageOf(err));
  }
}

async function editDescription(
  room: RoomSummary,
  reload: () => void,
  fail: (text: string) => void,
): Promise<void> {
  const answer = window.prompt('Описание комнаты', room.description ?? '');
  if (answer === null) return;

  try {
    // Пустая строка — это `null`, а не «»: иначе в лобби висела бы пустая
    // строка вместо отсутствия описания.
    await roomsApi.update(room.id, { description: answer.trim() === '' ? null : answer });
    reload();
  } catch (err) {
    fail(messageOf(err));
  }
}

async function deleteRoom(
  room: RoomSummary,
  navigate: (to: string, options?: { replace?: boolean }) => void,
  report: (text: string) => void,
): Promise<void> {
  // Подтверждение обязательно: удаление уносит состав и заявки, и отменить
  // это нельзя.
  if (!window.confirm(`Удалить комнату «${room.name}»? Отменить будет нельзя.`)) return;

  try {
    await roomsApi.remove(room.id);
    navigate('/', { replace: true });
    report('Комната удалена');
  } catch (err) {
    window.alert(messageOf(err));
  }
}

async function leaveRoom(
  room: RoomSummary,
  navigate: (to: string, options?: { replace?: boolean }) => void,
  report: (text: string) => void,
): Promise<void> {
  try {
    const result = await roomsApi.leave(room.id);
    navigate('/', { replace: true });
    // Разные последствия — разные слова: если комната удалилась вместе с
    // уходом, «вы вышли» звучало бы так, будто она осталась.
    report(
      result.roomDeleted ? 'Вы были последним участником — комната удалена' : 'Вы вышли из комнаты',
    );
  } catch (err) {
    window.alert(messageOf(err));
  }
}

async function removeMember(
  roomId: string,
  name: string,
  userId: string,
  reload: () => void,
): Promise<void> {
  if (!window.confirm(`Исключить «${name}» из комнаты?`)) return;

  try {
    await roomsApi.removeMember(roomId, userId);
    reload();
  } catch (err) {
    window.alert(messageOf(err));
  }
}

async function approve(roomId: string, requestId: string, reload: () => void): Promise<void> {
  try {
    await roomsApi.approveJoin(roomId, requestId);
    reload();
  } catch (err) {
    window.alert(messageOf(err));
  }
}

async function reject(roomId: string, requestId: string, reload: () => void): Promise<void> {
  try {
    await roomsApi.rejectJoin(roomId, requestId);
    reload();
  } catch (err) {
    window.alert(messageOf(err));
  }
}

/**
 * Дата заявки.
 *
 * Год показывается только когда он отличается от текущего: «6 октября» внутри
 * «6 октября 2025 года» — шум, а «6 октября» в январе без года читается как
 * ошибка.
 */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });
}