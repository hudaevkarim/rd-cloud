import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog } from '../components/ui/Dialog.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { ApiError, rooms as roomsApi } from '../api/client.js';
import { inviteAlphabetHint, isValidInviteCode } from './invite-code.js';
import { messageOf } from './room-queries.js';

/**
 * Вход по коду приглашения.
 *
 * ─── Код приводится в верхний регистр на лету ─────────────────────────────────
 *
 * Код диктуют по телефону, строчными, и человек набирает `k3mq...`, хотя код
 * был `K3MQ...`. Приводить в разметке — значит показывать ему не то, что он
 * ввёл, и он решит, что ошибся. Сервер регистр не различает.
 *
 * ─── Проверка до запроса — только форма, не существование ─────────────────────
 *
 * Клиент проверяет алфавит и длину: это видно сразу, без сети. Существование
 * комнаты проверить нельзя, и ложная проверка была бы обещанием, которое
 * сервер не сдержит. 404 приходит как текст с сервера.
 */
export function JoinByCodeDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = code.trim();

    if (!isValidInviteCode(trimmed)) {
      setError('Код выглядит неверно');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await roomsApi.joinByCode(trimmed);
      onClose();
      // `replace`: кнопка «назад» после входа вернула бы на лобби, где этой
      // комнаты ещё нет, и человек подумал бы, что вход не сработал.
      navigate(`/rooms/${result.roomId}`, { replace: true });
    } catch (err) {
      // 404 «комната с таким кодом» и 400 «код выглядит неверно» приходят
      // разными текстами, и различать их полезно: в первом случае код верный,
      // но комнаты нет, во втором — опечатка.
      setError(err instanceof ApiError ? err.message : messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Войти по коду"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </Button>
        </>
      }
    >
      <Input
        label="Код приглашения"
        value={code}
        onChange={(e) => {
          setCode(e.target.value.toUpperCase());
          // Ошибка снимается при правке: человек уже исправляет, и старый текст
          // «код выглядит неверно» мешал бы понять, исправлено или нет.
          setError(null);
        }}
        placeholder="K3MQR7WD"
        autoFocus
        disabled={busy}
        error={error ?? undefined}
        hint={inviteAlphabetHint()}
        maxLength={8}
        // Код не автозаполняется: это не пароль, но и не имя, и предложение
        // браузера тут только мешает — оно вставит то, что человек вводил в
        // другие поля.
        autoComplete="off"
        spellCheck={false}
      />
    </Dialog>
  );
}