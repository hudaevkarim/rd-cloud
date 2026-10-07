import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, books as booksApi } from '../api/client.js';
import type { BookSummary } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Dialog } from '../components/ui/Dialog.js';
import { Input } from '../components/ui/Input.js';
import { TextArea } from '../components/ui/TextArea.js';
import { Label } from '../components/ui/Label.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../components/ui/Toast.js';
import {
  detectBookFile,
  humanSize,
  limitFor,
  oversizeMessage,
  titleFromFilename,
  type BookKind,
} from './file-kind.js';
import { UploadAborted, uploadWithProgress, type UploadProgress } from './upload.js';

/**
 * Загрузка книги в комнату.
 *
 * ─── Почему проверка лимита здесь, до отправки ───────────────────────────────
 *
 * Сервер тоже проверяет размер, но узнал бы об этом через минуту отправки
 * пятидесяти мегабайт. Человек узнаёт сразу, при выборе файла, и этого хватает,
 * чтобы взять другой, не потратив ни минуты, ни трафика.
 *
 * ─── Порядок частей ──────────────────────────────────────────────────────────
 *
 * `kind` и `format` добавляются в форму первыми: сервер читает multipart одним
 * проходом и узнаёт лимит размера только из полей, пришедших раньше файла.
 *
 * ─── Отмена ──────────────────────────────────────────────────────────────────
 *
 * `xhr.abort()` рвёт соединение, и сервер убирает недописанный файл вместе с его
 * каталогом. То есть отмена не оставляет мусора на диске — это проверено
 * серверными тестами.
 */
export function BookUploadDialog({
  roomId,
  open,
  onClose,
  onUploaded,
}: {
  roomId: string;
  open: boolean;
  onClose: () => void;
  onUploaded: (book: BookSummary) => void;
}) {
  const toast = useToast();

  const [file, setFile] = useState<File | null>(null);
  const [detected, setDetected] = useState<{ kind: BookKind; format: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');

  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // Ссылка на текущую загрузку нужна и кнопке «Отменить», и очистке при закрытии
  // окна: без неё закрытие во время отправки оставило бы запрос в фоне.
  const handle = useRef<{ abort: () => void } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const busy = progress !== null;

  /** Сброс формы. Вызывается и при открытии, и после успеха. */
  const reset = useCallback(() => {
    setFile(null);
    setDetected(null);
    setProblem(null);
    setTitle('');
    setAuthor('');
    setDescription('');
    setProgress(null);
    setFailure(null);
  }, []);

  // При открытии окна форма чистая: состояние прошлой попытки, оставшееся после
  // закрытия, читалось бы как «уже выбрано не то».
  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  // Закрытие во время отправки обрывает запрос. Иначе человек закрыл окно, а
  // сервер ещё минуту дописывал файл, который никто уже не ждёт.
  useEffect(() => {
    if (!open) return;
    return () => {
      handle.current?.abort();
      handle.current = null;
    };
  }, [open]);

  const choose = useCallback((candidate: File | null): void => {
    setFailure(null);
    if (candidate === null) {
      setFile(null);
      setDetected(null);
      setProblem(null);
      return;
    }

    const found = detectBookFile(candidate.name);
    if (found === null) {
      setFile(null);
      setDetected(null);
      setProblem('Такой файл сервер не читает. Нужен .epub, .fb2, .pdf, .mp3 или .m4b.');
      return;
    }

    const tooBig = oversizeMessage(found.kind, candidate.size);
    if (tooBig !== null) {
      setFile(null);
      setDetected(null);
      setProblem(tooBig);
      return;
    }

    setFile(candidate);
    setDetected({ kind: found.kind, format: found.format });
    setProblem(null);
    // Название подставляется, только если поле ещё пусто: человек, начавший
    // писать название до выбора файла, не должен потерять написанное.
    setTitle((current) => (current === '' ? titleFromFilename(candidate.name) : current));
  }, []);

  const send = async (): Promise<void> => {
    if (file === null || detected === null) return;
    if (title.trim() === '' || author.trim() === '') {
      setFailure('Нужны название и автор.');
      return;
    }

    setFailure(null);
    setProgress({ loaded: 0, total: file.size, ratio: 0, phase: 'sending' });

    const form = booksApi.buildUploadForm(file, {
      kind: detected.kind,
      format: detected.format,
      title: title.trim(),
      author: author.trim(),
      ...(description.trim() === '' ? {} : { description: description.trim() }),
    });

    const upload = uploadWithProgress({
      url: `/api/rooms/${roomId}/books/upload`,
      form,
      onProgress: setProgress,
    });
    handle.current = upload;

    try {
      const response = await upload.promise;
      const body = (await response.json()) as { book: BookSummary };
      toast.info('Книга загружена');
      onUploaded(body.book);
      reset();
      onClose();
    } catch (error) {
      if (error instanceof UploadAborted) {
        // Отмена — это решение человека, а не сбой. Тост об ошибке здесь был бы
        // враньём, и человек решил бы, что что-то сломалось.
        reset();
        return;
      }
      setProgress(null);
      setFailure(error instanceof ApiError ? error.message : 'Загрузка не удалась');
    } finally {
      handle.current = null;
    }
  };

  const cancel = (): void => {
    handle.current?.abort();
    handle.current = null;
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        // Во время отправки закрытие мимо «Отменить» означало бы, что запрос
        // продолжается. Отменяем явно и остаёмся на месте.
        if (busy) {
          cancel();
          return;
        }
        onClose();
      }}
      title="Загрузить книгу"
      footer={
        busy ? (
          <>
            <Button variant="ghost" onClick={cancel}>
              Отменить загрузку
            </Button>
            <Button variant="ghost" disabled>
              {progress.phase === 'processing' ? 'Разбираем на сервере…' : 'Отправляем…'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button onClick={() => void send()} disabled={file === null || problem !== null}>
              Загрузить
            </Button>
          </>
        )
      }
    >
      {/*
        Зона для файла — настоящая метка на скрытом `input`. Кликом по метке
        открывается выбор, а с `drag-and-drop` сюда можно перетащить файл прямо
        из проводника. Отдельная кнопка «Выбрать файл» была бы лишним шагом для
        человека, который и так кликает по рамке.
      */}
      <label
        className={`dropzone${dragging ? ' is-dragging' : ''}${file === null && problem !== null ? ' is-bad' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          choose(event.dataTransfer.files[0] ?? null);
        }}
      >
        <input
          ref={fileInput}
          type="file"
          className="dropzone__input"
          accept=".epub,.fb2,.pdf,.mp3,.m4b,.m4a"
          disabled={busy}
          onChange={(event) => choose(event.target.files?.[0] ?? null)}
        />
        {file === null ? (
          <span className="dropzone__hint">
            Перетащите файл сюда или нажмите, чтобы выбрать
            <span className="dropzone__formats">.epub · .fb2 · .pdf · .mp3 · .m4b</span>
          </span>
        ) : (
          <span className="dropzone__file">
            <span className="dropzone__name">{file.name}</span>
            <span className="dropzone__meta label label-xs">
              {humanSize(file.size)} · {detected?.kind === 'audio' ? 'аудио' : 'текст'} · лимит{' '}
              {humanSize(limitFor(detected?.kind ?? 'text'))}
            </span>
          </span>
        )}
      </label>

      {/*
        Отказ виден под зоной, а не в тосте: он относится к конкретному полю и
        должен остаться на месте, пока человек не выберет другой файл. Тост
        исчезает через несколько секунд, и человек остался бы с формой, где
        ничего не изменилось.
      */}
      {problem !== null && (
        <p className="formproblem" role="alert">
          {problem}
        </p>
      )}

      {busy && progress !== null && (
        <div className="progress">
          {/*
            Полоса, а не проценты: проценты на файле в два гигабайта не двигаются
            по минуте, и человек решил бы, что загрузка стоит.
          */}
          <div
            className="progress__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((progress.ratio ?? 0) * 100)}
            aria-label="Загрузка книги"
          >
            <span
              className="progress__fill"
              style={{ transform: `scaleX(${progress.ratio ?? 0})` }}
            />
          </div>
          <p className="progress__text label label-xs">
            {progress.phase === 'processing' ? (
              <>
                <Spinner size={12} /> Разбираем на сервере
              </>
            ) : (
              `${humanSize(progress.loaded)} из ${humanSize(progress.total ?? file?.size ?? 0)}`
            )}
          </p>
        </div>
      )}

      {failure !== null && (
        <p className="formproblem" role="alert">
          {failure}
        </p>
      )}

      <div className="form">
        <Input
          label="Название"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={busy}
          required
        />
        <Input
          label="Автор"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          disabled={busy}
          required
        />
        <TextArea
          label="Описание"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          disabled={busy}
          rows={3}
        />

        <p className="form__hint label label-xs">
          <Label size="xs" as="span">
            ЧТО ПОДДЕРЖИВАЕТСЯ
          </Label>
          Текст: .epub, .fb2, .pdf до {humanSize(limitFor('text'))}. Аудио: .mp3, .m4b до{' '}
          {humanSize(limitFor('audio'))}. Книгу из общего каталога можно добавить без загрузки.
        </p>
      </div>
    </Dialog>
  );
}