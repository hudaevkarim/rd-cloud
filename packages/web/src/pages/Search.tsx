import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, plural, rooms as roomsApi } from '../api/client.js';
import type { JoinState, RoomSearchHit, WireNotification } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../components/ui/Toast.js';
import { messageOf, useDebounced, useQuery } from '../rooms/room-queries.js';
import { useRoomSocket } from '../rooms/useRoomSocket.js';
import { isMyRequestAnswered } from '../rooms/Notifications.js';

/**
 * Поиск.
 *
 * ─── Две вкладки сразу, вторая пустая ────────────────────────────────────────
 *
 * Вкладка «Книги» появляется в 7.3, но заведена сейчас. Иначе в 7.3 пришлось бы
 * переделывать навигацию: вкладки занимают место в шапке, и человек, привыкший
 * к двум, увидел бы одну и решил бы, что вторая потерялась.
 *
 * ─── Debounce на поле ───────────────────────────────────────────────────────
 *
 * 300 мс — время, за которое допечатывается слово. Без задержки каждый ввод
 * порождал бы запрос, и на медленной сети ответы приходили бы вперемешку: на
 * «ан» мог прийти позже, чем на «анна», и список прыгал бы.
 */
type SearchTab = 'rooms' | 'books';

const TABS: Array<{ id: SearchTab; label: string }> = [
  { id: 'rooms', label: 'Комнаты' },
  { id: 'books', label: 'Книги' },
];

export function SearchPage() {
  const [tab, setTab] = useState<SearchTab>('rooms');
  const [raw, setRaw] = useState('');

  const query = useDebounced(raw.trim(), 300);

  return (
    <div className="page">
      <div className="page__head">
        <Label size="xs" as="p">
          ПОИСК
        </Label>
        <h1 className="page__title">Найти</h1>
      </div>

      <div className="tabs" role="tablist" aria-label="Что ищем">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tabs__tab${tab === t.id ? ' is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Rule />

      {/*
        Поле одно на обе вкладки: то, что человек набрал, имеет смысл для обеих,
        и сброс при переключении означал бы, что вкладку нельзя переключить
        «посмотреть, не потеряв запрос».
      */}
      <Input
        label={tab === 'rooms' ? 'Название комнаты' : 'Название или автор книги'}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={tab === 'rooms' ? 'Классика' : 'Пушкин'}
        autoFocus
      />

      {tab === 'rooms' ? (
        <RoomsResults query={query} />
      ) : (
        <div className="empty">
          <h2 className="empty__title">Скоро</h2>
          <p className="empty__text">
            Поиск по книгам придёт вместе с загрузкой книг в 7.3. Здесь будут
            находиться книги из общего каталога и добавленные в комнаты.
          </p>
        </div>
      )}
    </div>
  );
}

/** Результаты по комнатам. */
function RoomsResults({ query }: { query: string }) {
  const toast = useToast();

  const results = useQuery<RoomSearchHit[]>(
    async () => (query === '' ? [] : roomsApi.search(query)),
    [query],
  );

  /**
   * Ответ на заявку перечитывает выдачу.
   *
   * Без этого человек видел бы вечное «Запрос отправлен» на уже отклонённую
   * заявку — а по `myPendingRequest` в ответе сервера состояние видно сразу.
   */
  const onNotification = useCallback(
    (note: WireNotification) => {
      if (isMyRequestAnswered(note)) results.reload();
    },
    [results],
  );

  useRoomSocket({ onNotification });

  if (query === '') {
    return (
      <div className="empty">
        <h2 className="empty__title">Что ищем?</h2>
        <p className="empty__text">
          Введите название комнаты. Показываются только те, что помечены как
          видимые в поиске; в остальные можно попасть по ссылке-приглашению.
        </p>
      </div>
    );
  }

  if (results.status === 'loading') {
    return (
      <div className="page__center">
        <Spinner size={20} label="Ищем" />
      </div>
    );
  }

  if (results.status === 'error') {
    return (
      <div className="empty">
        <p className="empty__text">{results.error}</p>
        <Button variant="ghost" onClick={results.reload}>
          Попробовать снова
        </Button>
      </div>
    );
  }

  if (results.data.length === 0) {
    return (
      <div className="empty">
        <h2 className="empty__title">Ничего не нашлось</h2>
        <p className="empty__text">
          {`Комнат с названием «${query}» нет. Проверьте раскладку: поиск ищет по названию целиком.`}
        </p>
      </div>
    );
  }

  return (
    <ul className="rows">
      {results.data.map((hit) => (
        <SearchHitRow key={hit.id} hit={hit} onInfo={toast.info} onError={toast.error} />
      ))}
    </ul>
  );
}

/**
 * Строка результата.
 *
 * Отдельным компонентом, а не разметкой в цикле: у строки своё состояние
 * «заявка отправлена», и без отдельного компонента оно было бы общим для всей
 * выдачи — подал заявку у одной комнаты, а надпись сменилась у всех.
 */
function SearchHitRow({
  hit,
  onInfo,
  onError,
}: {
  hit: RoomSearchHit;
  onInfo: (text: string) => void;
  onError: (text: string) => void;
}) {
  const [pending, setPending] = useState(false);
  /**
   * Заявка помечена сразу, а не ждёт перезапроса выдачи.
   *
   * Иначе между нажатием и ответом сервера кнопка оставалась бы «Попроситься»
   * и активной: человек нажал бы ещё раз и получил бы 409 «заявка уже
   * отправлена» — ошибку после успешного действия.
   */
  const [requested, setRequested] = useState(false);

  const state: JoinState =
    hit.myRole !== null
      ? 'joined'
      : hit.myPendingRequest || requested
        ? 'requested'
        : 'can-request';

  /**
   * Кнопка блокируется на время запроса.
   *
   * Без этого двойное нажатие давало бы два запроса, а второй — 409, и человек
   * увидел бы ошибку после успешного первого.
   */
  const request = async (): Promise<void> => {
    setPending(true);
    try {
      await roomsApi.requestJoin(hit.id);
      setRequested(true);
      onInfo('Заявка отправлена');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : messageOf(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="rows__item">
      <div className="hitrow">
        <div className="hitrow__body">
          <span className="hitrow__name">{hit.name}</span>

          {hit.description !== null && hit.description !== '' && (
            <span className="hitrow__desc">{hit.description}</span>
          )}

          <span className="hitrow__meta label label-xs">
            {plural(hit.memberCount, 'участник', 'участника', 'участников')} · {hit.owner.displayName}
          </span>
        </div>

        <span className="hitrow__action">
          {state === 'joined' && (
            <Link className="btn btn--ghost" to={`/rooms/${hit.id}`}>
              Вы уже в комнате
            </Link>
          )}

          {state === 'requested' && (
            <Button variant="ghost" disabled>
              Запрос отправлен
            </Button>
          )}

          {state === 'can-request' && (
            <Button onClick={() => void request()} disabled={pending}>
              {pending ? 'Отправляем…' : 'Попроситься'}
            </Button>
          )}
        </span>
      </div>
    </li>
  );
}