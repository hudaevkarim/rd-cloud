import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '../components/ui/Dialog.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { ApiError, rooms } from '../api/client.js';
import { messageOf } from './room-queries.js';

/**
 * Создание комнаты.
 *
 * ─── Почему модалка, а не отдельная страница ─────────────────────────────────
 *
 * Комнат создают мало и один раз. Отдельная страница означала бы ещё одно
 * состояние: «создание уже начато», которое пришлось бы хранить, чтобы
 * помешать человеку уйти со страницы с пустой формой. Модалка закрывается
 * тем же Escape, что и любое окно, и ничего не теряет.
 *
 * ─── Валидация до запроса ────────────────────────────────────────────────────
 *
 * Сервер проверяет те же правила и отдаст 400 с текстом. Но проверка на
 * клиенте даёт мгновенный ответ: без неё человек нажимал бы «Создать», ждал
 * сеть и узнавал, что название слишком длинное. Ограничения взяты из zod-
 * схемы сервера, а не выбраны здесь.
 */

/** Границы совпадают со схемой сервера (`createBody`). */
const NAME_MAX = 128;
const DESCRIPTION_MAX = 1000;

export function CreateRoomDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (trimmedName === '') {
      setError('Укажите название');
      return;
    }
    if (trimmedName.length > NAME_MAX) {
      setError(`Название длиннее ${NAME_MAX} символов`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const room = await rooms.create({
        name: trimmedName,
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        isPublic,
      });
      // Переход с `replace`: кнопка «назад» после создания вернула бы на лобби
      // без комнаты, и человек решил бы, что она не создалась.
      onClose();
      navigate(`/rooms/${room.id}`, { replace: true });
    } catch (err) {
      // Текст с сервера полезнее своего: 409 «имя занято» человек поймёт сразу,
      // а «что-то пошло не так» — нет.
      setError(err instanceof ApiError ? err.message : messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Новая комната"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? 'Создаём…' : 'Создать'}
          </Button>
        </>
      }
    >
      <div className="form">
        <Input
          label="Название"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Классика"
          autoFocus
          disabled={busy}
          error={error ?? undefined}
          hint={`До ${NAME_MAX} символов. Видно всем участникам комнаты.`}
        />

        <Input
          label="Описание"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Что читаем и в каком порядке"
          disabled={busy}
          hint="Необязательно."
        />

        <Rule />

        <label className="check">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            disabled={busy}
          />
          <span>
            <span className="check__title">Видна в поиске</span>
            <span className="check__hint label label-xs">
              Посторонние смогут найти комнату по названию и подать заявку.
              Без этого её можно попасть только по ссылке-приглашению.
            </span>
          </span>
        </label>

        <Label size="xs" as="p">
          После создания вы получите ссылку-приглашение.
        </Label>
      </div>
    </Dialog>
  );
}