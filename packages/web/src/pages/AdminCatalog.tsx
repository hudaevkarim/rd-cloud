import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, catalog as catalogApi } from '../api/client.js';
import type { BookSummary } from '../api/types.js';
import { Button } from '../components/ui/Button.js';
import { Dialog } from '../components/ui/Dialog.js';
import { Input } from '../components/ui/Input.js';
import { Label } from '../components/ui/Label.js';
import { Rule } from '../components/ui/Rule.js';
import { TextArea } from '../components/ui/TextArea.js';
import { useToast } from '../components/ui/Toast.js';
import { UploadAborted, uploadWithProgress, type UploadProgress } from '../books/upload.js';
import {
  coverProblem,
  detectBookFile,
  humanSize,
  limitFor,
  oversizeMessage,
} from '../books/file-kind.js';
import { BookCover } from '../books/BookCover.js';

/**
 * Админский каталог.
 *
 * ─── Форма: два необязательных файла в одном запросе ─────────────────────────
 *
 * Текст и аудио необязательны по отдельности, но хотя бы один нужен: книга с
 * одним файлом — это книга с одним файлом, а книга без файлов нечего ни читать,
 * ни слушать. Проверка делается здесь, до отправки, и на сервере тоже — потому
 * что здесь её можно показать на кнопке, а не после отправки.
 *
 * Обложка — третье поле в том же запросе. Отдельным маршрутом она была бы вторым
 * шагом, и после первого шага осталась бы книга без обложки: то есть на диске
 * был бы промежуточный результат, который никто не заказывал.
 *
 * ─── Порядок полей ───────────────────────────────────────────────────────────
 *
 * Здесь он не важен, в отличие от загрузки в комнату: вид файла несёт имя поля, а
 * не отдельное поле `kind`, поэтому лимит известен до первого байта каждого
 * файла. Именно поэтому серверный маршрут каталога и не требует «поля раньше
 * файла».
 */
export function AdminCatalogPage() {
  const toast = useToast();
  const [adding, setAdding] = useState(false);

  const catalog = useCatalogList();

  const remove = async (book: BookSummary): Promise<void> => {
    // Подтверждение здесь обязательно: действие необратимо для книги, которой
    // нет ни в одной комнате, — вместе с файлами.
    if (!window.confirm(`Убрать «${book.title}» из каталога?`)) return;
    try {
      const result = await catalogApi.removeFromCatalog(book.id);
      toast.info(
        result.deleted
          ? 'Книга удалена из каталога вместе с файлами'
          : 'Убрана из каталога: в комнатах она осталась',
      );
      catalog.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Не удалось убрать из каталога');
    }
  };

  return (
    <div className="page">
      <div className="page__head">
        <Label size="xs" as="p">
          АДМИНИСТРИРОВАНИЕ
        </Label>
        <h1 className="page__title">Каталог</h1>
        <p className="page__hint">
          Книги, доступные всем. Убирание из каталога не трогает копии в комнатах:
          там книга останется, пока её не уберут оттуда отдельно.
        </p>
      </div>

      <div className="page__actions">
        <Button onClick={() => setAdding(true)}>Добавить книгу в каталог</Button>
      </div>

      <Rule />

      {catalog.status === 'loading' && (
        <div className="page__center">
          <SpinnerLike label="Открываем каталог" />
        </div>
      )}

      {catalog.status === 'error' && <p className="empty__text">{catalog.error}</p>}

      {catalog.status === 'ready' && catalog.data.length === 0 && (
        <div className="empty">
          <h2 className="empty__title">Каталог пуст</h2>
          <p className="empty__text">
            Добавьте первую книгу — после этого её сможет взять любой участник
            любой комнаты, не загружая файл к себе.
          </p>
        </div>
      )}

      {catalog.status === 'ready' && catalog.data.length > 0 && (
        <ul className="rows">
          {catalog.data.map((book) => (
            <li className="rows__item" key={book.id}>
              <div className="catrow">
                <BookCover coverUrl={book.coverUrl} author={book.author} title={book.title} />
                <div className="catrow__body">
                  <span className="catrow__title">{book.title}</span>
                  <span className="catrow__author">{book.author}</span>
                  <span className="catrow__badges">
                    {book.hasText && <span className="badge">Текст</span>}
                    {book.hasAudio && <span className="badge">Аудио</span>}
                  </span>
                </div>
                <div className="catrow__action">
                  <Button variant="danger" onClick={() => void remove(book)}>
                    Убрать
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CatalogUploadDialog
        open={adding}
        onClose={() => setAdding(false)}
        onUploaded={() => {
          catalog.reload();
          setAdding(false);
        }}
      />
    </div>
  );
}

/** Список каталога. Отдельная функция, чтобы страница читалась как страница. */
function useCatalogList() {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: BookSummary[] }
  >({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const books = await catalogApi.list();
        if (!cancelled) setState({ status: 'ready', data: books });
      } catch (error) {
        if (!cancelled) {
          setState({ status: 'error', error: error instanceof ApiError ? error.message : 'Каталог не открылся' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { ...state, reload };
}

function SpinnerLike({ label }: { label: string }) {
  return (
    <div className="page__center">
      <span className="spinner" role="status" aria-label={label} />
    </div>
  );
}

/**
 * Форма пополнения каталога.
 *
 * Отдельный компонент, а не разметка в `AdminCatalogPage`: у формы своё состояние
 * — выбранные файлы, прогресс, отказ, — и в странице оно жило бы рядом со
 * списком, к которому отношения не имеет.
 */
function CatalogUploadDialog({
  open,
  onClose,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const toast = useToast();

  const [text, setText] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [authorBio, setAuthorBio] = useState('');
  const [language, setLanguage] = useState('');
  const [year, setYear] = useState('');

  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const handle = useRef<{ abort: () => void } | null>(null);
  const busy = progress !== null;

  const reset = useCallback(() => {
    setText(null);
    setAudio(null);
    setCover(null);
    setProblem(null);
    setTitle('');
    setAuthor('');
    setDescription('');
    setAuthorBio('');
    setLanguage('');
    setYear('');
    setProgress(null);
    setFailure(null);
  }, []);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    return () => {
      handle.current?.abort();
      handle.current = null;
    };
  }, [open]);

  /*
    Файл кладётся в поле, если он подходит по виду и размеру.

    Отказ виден в поле, а не в тосте: он относится к конкретному выбору и должен
    остаться на месте, пока человек не выберет другой файл.
  */
  const accept = (
    target: 'text' | 'audio' | 'cover',
    file: File | null,
  ): void => {
    setProblem(null);
    if (file === null) {
      if (target === 'text') setText(null);
      if (target === 'audio') setAudio(null);
      if (target === 'cover') setCover(null);
      return;
    }

    if (target === 'cover') {
      const issue = coverProblem(file);
      if (issue !== null) {
        setCover(null);
        setProblem(issue);
        return;
      }
      setCover(file);
      return;
    }

    const found = detectBookFile(file.name);
    if (found === null) {
      if (target === 'text') setText(null);
      if (target === 'audio') setAudio(null);
      setProblem(
        target === 'text'
          ? 'Текст: нужен .epub, .fb2 или .pdf.'
          : 'Аудио: нужен .mp3 или .m4b.',
      );
      return;
    }

    // Вид поля должен совпадать с видом файла: .epub в поле аудио — это опечатка
    // человека, а сервер принял бы книгу с аудио, которого нет.
    if (found.kind !== target) {
      if (target === 'text') setText(null);
      if (target === 'audio') setAudio(null);
      setProblem(
        found.kind === 'text'
          ? 'Это текстовый файл. Для аудио нужен .mp3 или .m4b.'
          : 'Это аудиофайл. Для текста нужен .epub, .fb2 или .pdf.',
      );
      return;
    }

    const tooBig = oversizeMessage(found.kind, file.size);
    if (tooBig !== null) {
      if (target === 'text') setText(null);
      if (target === 'audio') setAudio(null);
      setProblem(tooBig);
      return;
    }

    if (target === 'text') setText(file);
    else setAudio(file);

    /*
      Название подставляется от любого книжного файла, а не только от текста.
      Книга без текста — обычное дело, и заставлять администратора вбивать
      название вручную, когда оно уже написано в имени файла, незачем.
      Обложка сюда не годится: `cover.jpg` названием книги не является.

      Поле заполняется, только пока пустое: человек, начавший писать название до
      выбора файла, не должен терять написанное.
    */
    setTitle((current) => (current === '' ? stripExtension(file.name) : current));
  };

  const send = async (): Promise<void> => {
    if (text === null && audio === null) {
      setProblem('Нужен хотя бы один файл: текст или аудио.');
      return;
    }
    if (title.trim() === '' || author.trim() === '') {
      setFailure('Нужны название и автор.');
      return;
    }

    setProblem(null);
    setFailure(null);
    setProgress({ loaded: 0, total: totalSize(text, audio, cover), ratio: 0, phase: 'sending' });

    const form = new FormData();
    form.append('title', title.trim());
    form.append('author', author.trim());
    if (description.trim() !== '') form.append('description', description.trim());
    if (authorBio.trim() !== '') form.append('authorBio', authorBio.trim());
    if (language.trim() !== '') form.append('language', language.trim());
    if (year.trim() !== '') form.append('year', year.trim());
    // Поля-файлы по именам: вид несёт имя, и порядок частей не важен.
    if (text !== null) form.append('text', text, text.name);
    if (audio !== null) form.append('audio', audio, audio.name);
    if (cover !== null) form.append('cover', cover, cover.name);

    const upload = uploadWithProgress({
      url: '/api/admin/catalog',
      form,
      onProgress: setProgress,
    });
    handle.current = upload;

    try {
      await upload.promise;
      toast.info('Книга добавлена в каталог');
      reset();
      onUploaded();
    } catch (error) {
      if (error instanceof UploadAborted) {
        reset();
        return;
      }
      setProgress(null);
      setFailure(error instanceof ApiError ? error.message : 'Загрузка не удалась');
    } finally {
      handle.current = null;
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (busy) {
          handle.current?.abort();
          return;
        }
        onClose();
      }}
      title="Добавить книгу в каталог"
      footer={
        busy ? (
          <>
            <Button variant="ghost" onClick={() => handle.current?.abort()}>
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
            <Button
              onClick={() => void send()}
              disabled={(text === null && audio === null) || problem !== null}
            >
              Добавить в каталог
            </Button>
          </>
        )
      }
    >
      <FileField
        label="Текст (необязательно)"
        formats=".epub · .fb2 · .pdf"
        limit={limitFor('text')}
        file={text}
        disabled={busy}
        onPick={(file) => accept('text', file)}
        onClear={() => accept('text', null)}
      />

      <FileField
        label="Аудио (необязательно)"
        formats=".mp3 · .m4b"
        limit={limitFor('audio')}
        file={audio}
        disabled={busy}
        onPick={(file) => accept('audio', file)}
        onClear={() => accept('audio', null)}
      />

      <FileField
        label="Обложка (необязательно)"
        formats=".jpg · .png · .webp"
        limit={5 * 1_024 * 1_024}
        file={cover}
        disabled={busy}
        onPick={(file) => accept('cover', file)}
        onClear={() => accept('cover', null)}
        hint="HEIC не принимается: браузеры его не показывают."
      />

      {problem !== null && (
        <p className="formproblem" role="alert">
          {problem}
        </p>
      )}

      {failure !== null && (
        <p className="formproblem" role="alert">
          {failure}
        </p>
      )}

      {busy && progress !== null && (
        <div className="progress">
          <div
            className="progress__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((progress.ratio ?? 0) * 100)}
            aria-label="Загрузка в каталог"
          >
            <span className="progress__fill" style={{ transform: `scaleX(${progress.ratio ?? 0})` }} />
          </div>
          <p className="progress__text label label-xs">
            {progress.phase === 'processing'
              ? 'Разбираем на сервере'
              : `${humanSize(progress.loaded)} из ${humanSize(progress.total ?? 0)}`}
          </p>
        </div>
      )}

      <Input label="Название" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} required />
      <Input label="Автор" value={author} onChange={(e) => setAuthor(e.target.value)} disabled={busy} required />
      <TextArea label="Описание" value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
      <TextArea label="Биография автора" value={authorBio} onChange={(e) => setAuthorBio(e.target.value)} disabled={busy} />
      <Input label="Язык" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="ru" disabled={busy} />
      <Input label="Год" value={year} onChange={(e) => setYear(e.target.value)} placeholder="1869" disabled={busy} />
    </Dialog>
  );
}

/** Суммарный размер — нужен для шкалы, пока `total` от потока ещё неизвестен. */
function totalSize(...files: Array<File | null>): number {
  return files.reduce((sum, f) => sum + (f?.size ?? 0), 0);
}

/** Имя файла без расширения — для предзаполнения названия. */
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = dot === -1 ? filename : filename.slice(0, dot);
  return base.replace(/_+/g, ' ').trim();
}

/**
 * Поле выбора файла.
 *
 * Настоящая метка на скрытом `input`, а не кнопка с обработчиком: у метки есть
 * встроенное поведение — открыть выбор, принять перетаскивание, показать
 * курсор, — и подменять его своим значило бы потерять часть из них.
 */
function FileField({
  label,
  formats,
  limit,
  file,
  disabled,
  hint,
  onPick,
  onClear,
}: {
  label: string;
  formats: string;
  limit: number;
  file: File | null;
  disabled: boolean;
  hint?: string;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const id = `file-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className="field">
      <span className="label field__label" id={`${id}-label`}>
        {label}
      </span>

      <label className={`filefield${file === null ? '' : ' is-set'}`} htmlFor={id}>
        <input
          id={id}
          type="file"
          className="filefield__input"
          // `accept` со списком расширений, а не по типу MIME: браузер сверяет и то
          // и другое, но имя файла у mp4 внутри m4b остаётся `.m4b`, и по типу он
          // отфильтровывается.
          accept={formats.split(' · ').map((f) => f).join(',')}
          disabled={disabled}
          onChange={(event) => {
            const picked = event.target.files?.[0];
            if (picked !== undefined) onPick(picked);
          }}
        />

        {file === null ? (
          <span className="filefield__hint">
            Нажмите, чтобы выбрать
            <span className="filefield__formats">{formats} · до {humanSize(limit)}</span>
          </span>
        ) : (
          <span className="filefield__file">
            <span className="filefield__name">{file.name}</span>
            <span className="filefield__meta label label-xs">{humanSize(file.size)}</span>
          </span>
        )}
      </label>

      {file !== null && !disabled && (
        <button type="button" className="filefield__clear" onClick={onClear}>
          Убрать файл
        </button>
      )}

      {hint !== undefined && <p className="field__hint label label-xs">{hint}</p>}
    </div>
  );
}