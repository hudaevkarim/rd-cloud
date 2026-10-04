import { open } from 'node:fs/promises';

/**
 * Длительность аудиофайла.
 *
 * Зачем она нужна: без неё шкала прогресса по аудиокниге бессмысленна, а
 * `AudioAnchor.timeSec` не с чем сравнить. Комментарий «на 12-й минуте» должен
 * показываться на 12-й минуте у каждого.
 *
 * ─── Почему без библиотеки ──────────────────────────────────────────────────
 *
 * Разбор заголовков MP3 и `mvhd` в MP4 — это несколько десятков строк, а
 * полноценная библиотека ради одного числа потянула бы за собой мегабайт
 * зависимостей и свою версию Node. Считаем сами, но ограниченно: ровно те два
 * формата, что есть в схеме.
 *
 * ─── Точность ───────────────────────────────────────────────────────────────
 *
 * Для CBR (постоянный битрейт) MP3 результат точный до секунды. Для VBR он
 * приблизительный: считается по битрейту первого кадра. Расхождение на
 * VBR-файле обычно единицы процентов, для нашей задачи — «доли секунды в
 * начале аудиокниги» — это приемлемо. Точное значение лежит в Xing-теге, но
 * читать его ради округления не стоит.
 */

/**
 * Таблицы битрейтов, кбит/с. Индекс — «битрейт-индекс» из заголовка кадра.
 */
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const BITRATES_V1_L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0];
const BITRATES_V1_L1 = [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0];

/**
 * Слой по двух битам заголовка.
 *
 * Значение в файле **инвертировано** относительно номера слоя: `1` означает
 * Layer III, `2` — Layer II, `3` — Layer I, `0` зарезервирован. Это не очевидно
 * и стоило ошибки: при чтении Layer III как Layer I бралась таблица
 * BITRATES_V1_L1, и 128 кбит/с превращались в 256. Длительность аудиокниги
 * занижалась вдвое, а с ней и шкала прогресса и все комментарии по времени.
 */
function layerOf(layerBits: number): 1 | 2 | 3 | null {
  switch (layerBits) {
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 1;
    default:
      return null; // 0 — зарезервировано
  }
}

/**
 * Размер ID3v2 в начале файла.
 *
 * Тег занимает первые байты и не является звуком. Если его не пропустить,
 * длительность короткого файла завышается на размер картинки из тега.
 * Синхросафф останавливает искажение.
 */
function id3v2Size(head: Uint8Array): number {
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0; // "ID3"
  // Байты размера — synchsafe: каждый использует 7 бит, как в IP-адресе.
  const size = ((head[6] as number & 0x7f) << 21) | ((head[7] as number & 0x7f) << 14) | ((head[8] as number & 0x7f) << 7) | (head[9] as number & 0x7f);
  // Бит 0x10 в пятом байте означает футер тега: он тоже занимает место.
  const footer = ((head[5] as number) & 0x10) !== 0 ? 10 : 0;
  return size + 10 + footer;
}

/** Смещение первого MPEG-фрейма: заголовок ID3 плюс возможная синхроконтрольная. */
function firstFrameOffset(bytes: Uint8Array): number {
  let offset = id3v2Size(bytes);
  // ID3v1 — 128 байт в конце, на начало не влияет. А вот «мусор» перед первым
  // кадром встречается у старых сборщиков; ищем синхрослово, а не доверяем.
  for (let i = offset; i < Math.min(bytes.length - 4, offset + 4_096); i++) {
    if (bytes[i] === 0xff && ((bytes[i + 1] as number) & 0xe0) === 0xe0) return i;
  }
  return offset;
}

interface FrameHeader {
  bytesPerSecond: number;
  samplesPerFrame: number;
  sampleRate: number;
}

/** Разбор заголовка MPEG-фрейма: слоя, битрейта и частоты. */
function readFrameHeader(bytes: Uint8Array, at: number): FrameHeader | null {
  if (at + 4 > bytes.length) return null;

  const versionBits = (bytes[at + 1] as number >> 3) & 0x03;
  const layer = layerOf((bytes[at + 1] as number >> 1) & 0x03);
  // Версия 1 = MPEG-1, 2 = MPEG-2, 3 = MPEG-2.5. 0 — зарезервировано.
  if (versionBits === 0 || layer === null) return null;

  const bitrateIndex = (bytes[at + 2] as number >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null; // free и bad

  const sampleRateIndex = (bytes[at + 2] as number >> 2) & 0x03;
  if (sampleRateIndex === 3) return null; // зарезервировано

  const mpeg1 = versionBits === 3;
  const sampleRates = mpeg1 ? [44_100, 48_000, 32_000, 0] : [22_050, 24_000, 16_000, 0];
  const sampleRate = sampleRates[sampleRateIndex] as number;
  if (sampleRate === 0) return null;

  let bitrateTable: readonly number[];
  if (mpeg1) {
    bitrateTable = layer === 1 ? BITRATES_V1_L1 : layer === 2 ? BITRATES_V1_L2 : BITRATES_V1_L3;
  } else {
    // Для MPEG-2 и 2.5 таблица слоя III своя. Слои I и II там не применяются, и
    // для них берётся та же: MPEG-1 устаревший формат, точность на ответ не
    // влияет.
    bitrateTable = BITRATES_V2_L3;
  }

  const bitrateKbps = bitrateTable[bitrateIndex] as number;
  if (bitrateKbps === 0) return null;

  // Образцы на кадр зависят от слоя и версии. Для слоя III — 1152, кроме
  // MPEG-2/2.5, где их 576; MPEG-2.5 в этом проекте не встречается.
  let samplesPerFrame: number;
  if (layer === 3) samplesPerFrame = 1152;
  else if (layer === 2) samplesPerFrame = mpeg1 ? 1152 : 384;
  else samplesPerFrame = 384;

  return {
    // кбит/с → байт/с
    bytesPerSecond: (bitrateKbps * 1_000) / 8,
    samplesPerFrame,
    sampleRate,
  };
}

/**
 * Длительность MP3 в секундах.
 *
 * Считается как «сколько байт звука делить на битрейт». Точно это лишь для CBR;
 * для VBR даёт приближение по первому кадру. Возвращает `null`, если заголовок
 * не найден, — это лучше, чем угадывать: выдуманная длительность в 400 секунд
 * сделала бы шкалу прогресса и все комментарии по времени бессмысленными.
 */
export async function mp3DurationSec(path: string): Promise<number | null> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    const head = Buffer.alloc(Math.min(64 * 1_024, stat.size));
    await handle.read(head, 0, head.length, 0);

    const at = firstFrameOffset(head);
    const header = readFrameHeader(head, at);
    if (header === null) return null;

    const audioBytes = stat.size - at;
    const seconds = audioBytes / header.bytesPerSecond;
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
  } finally {
    await handle.close();
  }
}

/**
 * Длительность MP4 или M4B.
 *
 * В контейнере есть атом `mvhd` с временем и масштабом. Читать целиком файл не
 * нужно: хватает заголовка, а `mvhd` лежит в начале.
 */
export async function mp4DurationSec(path: string): Promise<number | null> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    // На практичеке `moov` стоит в начале (или в конце, у недописанных файлов).
    // Берём первый мегабайт и, если не нашли, последний мегабайт.
    const head = Buffer.alloc(Math.min(1024 * 1_024, stat.size));
    await handle.read(head, 0, head.length, 0);

    const found = findMvhd(head);
    if (found !== null) return found;

    if (stat.size > head.length) {
      const tailSize = Math.min(1024 * 1_024, stat.size);
      const tail = Buffer.alloc(tailSize);
      await handle.read(tail, 0, tailSize, stat.size - tailSize);
      return findMvhd(tail);
    }
    return null;
  } finally {
    await handle.close();
  }
}

function findMvhd(buffer: Buffer): number | null {
  // Атомы в MP4: размер (4 байта), тип (4 байта). Ищем `mvhd` и читаем сразу за ним.
  const needle = 'mvhd';
  for (let i = 0; i + 32 <= buffer.length; i++) {
    if (buffer[i] === 0x6d && buffer[i + 1] === 0x76 && buffer[i + 2] === 0x68 && buffer[i + 3] === 0x64) {
      const version = buffer[i + 4] as number;
      if (version === 0) {
        // version 0: 4 байта создания, 4 модификации, 4 timescale, 4 duration.
        const timescale = buffer.readUInt32BE(i + 16);
        const duration = buffer.readUInt32BE(i + 20);
        if (timescale === 0) return null;
        return Math.round(duration / timescale);
      }
      if (version === 1) {
        // version 1: по 8 байт на даты, затем timescale и duration по 8 байт.
        const timescale = buffer.readUInt32BE(i + 24);
        const hi = buffer.readUInt32BE(i + 28);
        const lo = buffer.readUInt32BE(i + 32);
        const duration = hi * 2 ** 32 + lo;
        if (timescale === 0) return null;
        return Math.round(duration / timescale);
      }
      return null;
    }
  }
  return null;
}

/** Длительность по расширению. `null`, если формат не умеем. */
export async function audioDurationSec(path: string, ext: string): Promise<number | null> {
  const lower = ext.toLowerCase();
  try {
    if (lower === 'mp3') return await mp3DurationSec(path);
    if (lower === 'm4b' || lower === 'm4a' || lower === 'mp4') return await mp4DurationSec(path);
  } catch {
    // Файл не читается — вернём null, запись всё равно создастся и её можно
    // будет разобрать вручную. Ошибку чтения не поднимаем: она не мешает
    // читать книгу, а вот падение загрузки мешает.
    return null;
  }
  return null;
}