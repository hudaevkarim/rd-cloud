/**
 * Генератор тестовых файлов: минимальный валидный EPUB и настоящий MP3.
 *
 * Нужен для живых проверок и для серверных тестов загрузки. Создаётся кодом, а
 * не кладётся в репозиторий бинарником: файл в несколько килобайт не должен
 * занимать место в истории, а его правильность должна быть видна глазами.
 *
 * Запуск: node scripts/make-fixtures.mjs <каталог>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

/** Минимальный EPUB: контейнер, OPF, две главы. */
function buildEpub() {
  const files = new Map();
  const put = (name, text) => files.set(name, new TextEncoder().encode(text));

  // `mimetype` обязан быть первым и несжатым — этого требует спецификация.
  files.set('mimetype', new TextEncoder().encode('application/epub+zip'));

  put(
    'META-INF/container.xml',
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );

  put(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Проверка загрузки</dc:title>
    <dc:creator>Тестовый Автор</dc:creator>
    <dc:language>ru</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`,
  );

  const chapter = (title, paragraphs) =>
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`;

  put(
    'OEBPS/ch1.xhtml',
    chapter('Глава первая', [
      'Ветер гулял по пустым улицам и не хотел останавливаться.',
      'Он умел ждать.',
      'Дождь начался к вечеру, и город стал тише.',
      'Пушкин написал об этом в одной из своих записных книжек.',
      'Утро пришло рано, как приходит после долгой дороги.',
    ]),
  );

  put(
    'OEBPS/ch2.xhtml',
    chapter('Глава вторая', [
      'Комната была холодной, и в ней пахло старой бумагой.',
      'Кто-то оставил на столе раскрытую книгу.',
      'За окном кто-то перекладывал дрова.',
      'Он закрыл книгу и долго смотрел в стену.',
      'Потом встал и вышел.',
    ]),
  );

  return zipSync(files);
}

/** Сборка zip без сжатия: структура EPUB должна оставаться читаемой. */
function zipSync(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(content) >>> 0;
    const size = content.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // подпись local file header
    lv.setUint16(4, 20, true); // версия
    lv.setUint16(6, 0, true); // флаги
    lv.setUint16(8, 0, true); // метод: без сжатия
    lv.setUint16(10, 0, true); // время
    // Фиксированная дата: 1 января 1996. Не «сейчас», чтобы два прогона давали
    // байт в байт одинаковый файл.
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // подпись central directory
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    locals.push(local, content);
    centrals.push(cd);
    offset += local.length + size;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // подпись end of central directory
  ev.setUint16(8, files.size, true);
  ev.setUint16(10, files.size, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Настоящий MP3: MPEG-1 Layer III, 128 кбит/с, 44.1 кГц.
 *
 * Кадр — 417 байт. При 128 кбит/с это 16 000 байт в секунду, так что 1000
 * кадров дают ровно 26 секунд: длительность можно проверить вручную.
 */
function buildMp3(seconds = 26) {
  const BITRATE = 128_000;
  const SAMPLE_RATE = 44_100;
  const SAMPLES_PER_FRAME = 1152;
  const bytesPerSecond = BITRATE / 8;
  const frameSize = Math.floor((bytesPerSecond * SAMPLES_PER_FRAME) / SAMPLE_RATE);
  const frames = Math.ceil((bytesPerSecond * seconds) / frameSize);

  // 0xFF 0xFB — синхрослово и MPEG-1 Layer III; 0x90 — 128 кбит/с, 44.1 кГц;
  // 0x00 — без паддинга, моно.
  const frame = Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    Buffer.alloc(frameSize - 4),
  ]);
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

const outDir = process.argv[2] ?? '.';
mkdirSync(outDir, { recursive: true });

const epub = buildEpub();
writeFileSync(join(outDir, 'test-book.epub'), epub);

const mp3 = buildMp3();
writeFileSync(join(outDir, 'test-audio.mp3'), mp3);

console.log(`EPUB: ${join(outDir, 'test-book.epub')} — ${epub.length} байт`);
console.log(`MP3 : ${join(outDir, 'test-audio.mp3')} — ${mp3.length} байт (ожидается ~26 с)`);

// Проверяем, что то, что мы собрали, действительно разбирается.
const { parseEpub } = await import('@rd/library/parse');
const book = parseEpub(new Uint8Array(epub));
console.log(`Разбор EPUB: «${book.title}», глав ${book.chapters.length}, блоков ${book.totalBlocks}`);