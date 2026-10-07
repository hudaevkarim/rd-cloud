import { describe, expect, it } from 'vitest';
import {
  coverProblem,
  detectBookFile,
  extensionOf,
  humanSize,
  isCoverFile,
  limitFor,
  oversizeMessage,
  titleFromFilename,
  TEXT_LIMIT_BYTES,
  COVER_LIMIT_BYTES,
} from '../src/books/file-kind.js';

/**
 * Определение вида книги по файлу.
 *
 * Здесь решается, узнает ли человек об отказе до отправки файла. Если проверка
 * ошибётся, человек узнаёт через минуту загрузки пятидесяти мегабайт — а это
 * ровно тот случай, ради которого проверка и вынесена наверх.
 */

describe('определение по расширению', () => {
  it('текстовые форматы', () => {
    // Порядок проверок не важен: результат один на каждый формат.
    expect(detectBookFile('Онегин.epub')).toEqual({ kind: 'text', format: 'epub', extension: 'epub' });
    expect(detectBookFile('Книга.fb2')).toEqual({ kind: 'text', format: 'fb2', extension: 'fb2' });
    expect(detectBookFile('Роман.pdf')).toEqual({ kind: 'text', format: 'pdf', extension: 'pdf' });
  });

  it('аудиоформаты', () => {
    expect(detectBookFile('Голос.mp3')).toEqual({ kind: 'audio', format: 'mp3', extension: 'mp3' });
    expect(detectBookFile('Аудиокнига.m4b')).toEqual({ kind: 'audio', format: 'm4b', extension: 'm4b' });
  });

  it('регистр не важен: файл с телефона приходит с заглавной', () => {
    // Телефон присылает «Онегин.EPUB», а сервер сравнивает расширение в нижнем
    // регистре. Без приведения к нему файл отклонили бы с «формат не
    // поддерживается» — и человек не понял бы почему.
    expect(detectBookFile('Онегин.EPUB')?.format).toBe('epub');
    expect(detectBookFile('Книга.Fb2')?.format).toBe('fb2');
    expect(detectBookFile('Голос.MP3')?.format).toBe('mp3');
  });

  it('m4a — тот же контейнер, что и m4b', () => {
    // Сервер хранит файл по расширению из `format`, то есть `.m4b`. Отдавать
    // `.m4a` значило бы записать файл с расширением, которого сервер не знает, и
    // длительность не определилась бы.
    expect(detectBookFile('Книга.m4a')).toEqual({ kind: 'audio', format: 'm4b', extension: 'm4b' });
  });

  it('неизвестный формат и файл без расширения — не книга', () => {
    // `null`, а не исключение: файл выбирают мышью, и «это не похоже на книгу» —
    // состояние формы, а не сбой программы.
    expect(detectBookFile('notes.docx')).toBeNull();
    expect(detectBookFile('Документ без расширения')).toBeNull();
    expect(detectBookFile('')).toBeNull();
  });
});

describe('расширение', () => {
  it('нижний регистр и без точки', () => {
    expect(extensionOf('Книга.EPUB')).toBe('epub');
    expect(extensionOf('а.б.в.pdf')).toBe('pdf');
    expect(extensionOf('без расширения')).toBe('');
    // Точка в начале — не расширение: имя вида «.bashrc» книгой не является.
    expect(extensionOf('.epub')).toBe('epub');
  });
});

describe('лимиты размера', () => {
  it('ровно те же числа, что на сервере', () => {
    // Показывать лимит надо до отправки, а спрашивать сервер ради одного числа —
    // лишний запрос при каждом открытии формы. Расхождение чисел не привело бы к
    // тихой поломке: сервер всё равно откажет, но человек узнает позже.
    expect(TEXT_LIMIT_BYTES).toBe(50 * 1_024 * 1_024);
    expect(limitFor('audio')).toBe(2 * 1_024 * 1_024 * 1_024);
    expect(limitFor('text')).toBe(TEXT_LIMIT_BYTES);
  });

  it('файл ровно в лимит проходит', () => {
    // Строгое «больше», а не «не меньше»: файл ровно в 50 МБ должен приниматься,
    // иначе человек увидел бы отказ на файле, который сервер бы взял.
    expect(oversizeMessage('text', TEXT_LIMIT_BYTES)).toBeNull();
  });

  it('превышение даёт сообщение с обоими числами', () => {
    const message = oversizeMessage('text', TEXT_LIMIT_BYTES + 1);
    expect(message).not.toBeNull();
    // Человек должен видеть и лимит, и размер своего файла: «слишком большой»
    // без чисел не скажет, насколько уменьшить.
    expect(message).toContain('50 МБ');
    expect(message).toContain('не больше');
  });

  it('у аудио свой лимит и своё сообщение', () => {
    const message = oversizeMessage('audio', 3 * 1_024 * 1_024 * 1_024);
    expect(message).toContain('2 ГБ');
  });
});

describe('обложка', () => {
  it('три формата, которые показывают браузеры', () => {
    expect(isCoverFile('обложка.jpg')).toBe(true);
    expect(isCoverFile('обложка.JPEG')).toBe(true);
    expect(isCoverFile('обложка.png')).toBe(true);
    expect(isCoverFile('обложка.webp')).toBe(true);
  });

  it('HEIC отклоняется с объяснением', () => {
    // Не из списка «так договорились»: HEIC не показывают браузеры, и админ
    // загрузил бы обложку, которой не увидит никто.
    const file = new File([new Uint8Array(16)], 'обложка.heic');
    const problem = coverProblem(file);
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/браузер/i);
  });

  it('слишком большая обложка отклоняется с числом', () => {
    const file = new File([new Uint8Array(6 * 1_024 * 1_024)], 'обложка.png');
    const problem = coverProblem(file);
    expect(problem).not.toBeNull();
    expect(problem).toContain('5 МБ');
  });

  it('подходящая обложка проходит', () => {
    const file = new File([new Uint8Array(1024)], 'обложка.jpg');
    expect(coverProblem(file)).toBeNull();
    expect(COVER_LIMIT_BYTES).toBe(5 * 1_024 * 1_024);
  });
});

describe('название из имени файла', () => {
  it('убирает расширение', () => {
    expect(titleFromFilename('Евгений Онегин.epub')).toBe('Евгений Онегин');
    expect(titleFromFilename('Книга')).toBe('Книга');
  });

  it('подчёркивания — в пробелы', () => {
    // Имя файла почти всегда приходит с подчёркиваниями из архива, и
    // «Евгений_Онегин» в поле названия выглядело бы как опечатка.
    expect(titleFromFilename('Евгений_Онегин.epub')).toBe('Евгений Онегин');
  });

  it('точки внутри имени не теряются', () => {
    // Отрезается только последняя часть после точки: «Том_1.Том_2.epub» — это
    // название с точкой внутри, а не «Том_1.Том_2» с пустым расширением.
    expect(titleFromFilename('Том_1.Том_2.epub')).toBe('Том 1.Том 2');
  });
});

describe('человеческий размер', () => {
  it('три единицы, запятая как разделитель дробной части', () => {
    // Запятая, а не точка: проект русский, и «12.4 МБ» среди русского текста
    // выглядит как опечатка.
    expect(humanSize(512)).toBe('512 Б');
    expect(humanSize(2048)).toBe('2 КБ');
    expect(humanSize(12_345_678)).toBe('11,8 МБ');
  });

  it('целые значения без дробной части', () => {
    // «не больше 50,0 МБ» — машинный вывод. Человек думает о «50 МБ», и
    // сообщение о лимите почти всегда приходится на ровное число.
    expect(humanSize(2 * 1_024 * 1_024 * 1_024)).toBe('2 ГБ');
    expect(humanSize(50 * 1_024 * 1_024)).toBe('50 МБ');
    expect(humanSize(5 * 1_024 * 1_024)).toBe('5 МБ');
  });
});