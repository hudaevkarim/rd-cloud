import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, rooms as roomsApi } from '../api/client.js';
import { Button } from '../components/ui/Button.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../components/ui/Toast.js';
import { isValidInviteCode } from '../rooms/invite-code.js';
import { messageOf } from '../rooms/room-queries.js';

/**
 * Вход по ссылке-приглашению.
 *
 * ─── Цепочка для неавторизованного ───────────────────────────────────────────
 *
 * `/join/{код}` стоит под `RequireAuth`, и тот уводит на форму входа, помня адрес
 * в `location.state.from`. После входа `LoginPage` возвращает на этот же адрес,
 * и код применяется здесь. Без возврата человек вошёл бы и оказался в лобби,
 * потеряв приглашение, — а ссылка отправителя ему этого не объясняет.
 *
 * ─── Почему страница, а не один запрос в `RequireAuth` ───────────────────────
 *
 * Войти можно только в комнату, а не «куда угодно»: адрес из ссылки может быть
 * подделан, и без проверки формы человек получил бы 404 на неверном коде вместо
 * понятного сообщения. Здесь код проверяется на форме, а сама комната — сервером.
 *
 * ─── Почему запрос один ──────────────────────────────────────────────────────
 *
 * StrictMode выполняет эффекты дважды: запуск → cleanup → запуск. Два
 * `join-by-code` дали бы первый вход и второй `joined: false`, и человек увидел
 * бы «вы уже присоединились» вместо обычного перехода.
 *
 * ─── Почему нет флага отмены ─────────────────────────────────────────────────
 *
 * Сначала стоял `cancelled` в cleanup, и он же оказался причиной поломки.
 * Вместе с защитой от повтора они работали так:
 *
 *   первый запуск  → `started = true`, уходит запрос
 *   cleanup        → `cancelled = true`
 *   второй запуск  → видит `started` и выходит, ничего не делая
 *   ответ приходит → `cancelled === true`, результат игнорируется
 *
 * Запрос уходил, и навигация не происходила никогда: страница вечно висела на
 * «Входим в комнату». Наблюдалось в живом браузере — и **не ловилось
 * тестами**, потому что в них нет StrictMode. Теперь страница оборачивается в
 * StrictMode в тесте, и поломка возвращается при первом же прогоне.
 *
 * Отменять нечего: единственный запрос обязан довести дело до конца, а
 * компонент не размонтируется сам по себе — переход делает он же.
 */
export function JoinByCode() {
  const { inviteCode = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const valid = isValidInviteCode(inviteCode);

  useEffect(() => {
    if (!valid) {
      setError('Ссылка выглядит неверно: код должен состоять из восьми знаков.');
      return;
    }
    // Второй запуск в StrictMode пропускаем — см. замечание в шапке файла.
    if (started.current) return;
    started.current = true;

    void roomsApi
      .joinByCode(inviteCode)
      .then((result) => {
        toast.info('Вы присоединились к комнате');
        // `replace`: кнопка «назад» после входа вернула бы на эту же ссылку,
        // и она снова попыталась бы войти — то есть «назад» не вернул бы в
        // лобби, а снова бы вошёл в комнату.
        navigate(`/rooms/${result.roomId}`, { replace: true });
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : messageOf(err));
      });
  }, [inviteCode, valid, navigate, toast]);

  if (error !== null) {
    return (
      <div className="page page--center">
        <h1 className="placeholder__title">Не получилось войти</h1>
        <p className="placeholder__hint">{error}</p>

        <div className="empty__actions">
          <Button onClick={() => navigate('/')}>В лобби</Button>
          <Button variant="ghost" onClick={() => navigate('/search')}>
            Поискать комнату
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="page page--center">
      <Label size="xs" as="p">
        ПРИГЛАШЕНИЕ
      </Label>

      <h1 className="placeholder__title">Входим в комнату</h1>

      <Rule />

      <Spinner size={20} label="Проверяем код" />

      <p className="placeholder__hint">
        Код <code>{inviteCode}</code>. Если он ваш, комната откроется сразу.
      </p>

      <Link className="link" to="/">
        Отменить и вернуться в лобби
      </Link>
    </div>
  );
}