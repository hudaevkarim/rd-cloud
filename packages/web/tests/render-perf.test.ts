import { describe, expect, it } from 'vitest';
import { renderChapter } from '@rd/library/render';
import type { BlockKind, XmlText } from '@rd/library/parse';
import type { EpubBlock } from '@rd/library/parse';

/**
 * Замер рендера главы.
 *
 * ─── Зачем это в тестах, а не «просто посмотреть в браузере» ─────────────────
 *
 * Вопрос «успеет ли браузер» относится к железу человека, а не к нашей
 * машине: на ноутбуке разработчика 600 блоков рисуются мгновенно, на телефоне
 * — совсем иначе. Поэтому проверка не «сколько миллисекунд», а «сколько узлов
 * на один блок» и «линейно ли растёт время». Линейность — то, что решает,
 * понадобится ли виртуализация: на 600 блоках можно пожертвовать 300 мс, а на
 * 6000 при том же коэффициенте страница встанет.
 *
 * ─── Почему без React ────────────────────────────────────────────────────────
 *
 * `renderChapter` — чистая функция «блоки → DOM». Оборачивать её в компонент
 * значило бы мерить время рендера React вместо времени рендера главы.
 */

/** Текст правдоподобной длины: короткий текст рисуется быстрее настоящего. */
const SENTENCE =
  'Ветер гулял по пустым улицам и не хотел останавливаться, а в конце концов всё равно стих.';

function textNode(text: string): XmlText {
  return { name: '#text', text, attrs: {}, children: [] };
}

/**
 * Глава из `count` блоков.
 *
 * Разделы имитируются не текстом, а узлами: у настоящей главы смесь заголовков,
 * абзацев и цитат, и замер на одних абзацах был бы слишком одобрительным.
 */
function chapterOf(count: number): EpubBlock[] {
  const blocks: EpubBlock[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind: BlockKind = i % 40 === 0 ? 'h2' : 'p';
    blocks.push({
      index: i,
      kind,
      node: { name: kind, attrs: {}, children: [textNode(`${kind === 'h2' ? 'Глава' : ''} ${SENTENCE}`)] },
      text: SENTENCE,
    });
  }
  return blocks;
}

/** Медиана из нескольких замеров: один замер на фоне сборщика мусора врёт. */
function medianOf(runs: number[]): number {
  const sorted = [...runs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function renderOnce(blocks: EpubBlock[]): number {
  const host = document.createElement('div');
  const started = performance.now();
  host.appendChild(renderChapter({ blocks }));
  const elapsed = performance.now() - started;
  expect(host.childElementCount).toBeGreaterThan(0);
  return elapsed;
}

describe('замер рендера главы', () => {
  it('6, 60 и 600 блоков укладываются в полсекунды', () => {
    const sizes = [6, 60, 600];
    const results: Array<{ blocks: number; ms: number }> = [];

    for (const size of sizes) {
      const blocks = chapterOf(size);
      renderOnce(blocks); // прогрев: первый замер платит за создание кода
      results.push({ blocks: size, ms: medianOf([1, 2, 3, 4, 5].map(() => renderOnce(blocks))) });
    }

    for (const r of results) {
      /*
        Порог взят из требования к подэтапу: 600 блоков дольше половины секунды —
        это уже «страница подвисает». Проверка сработает раньше, чем человек
        заметит, и не даст тихо ухудшиться при следующей правке рендерера.
      */
      expect(r.ms, `${r.blocks} блоков: ${r.ms.toFixed(1)} мс`).toBeLessThan(500);
    }

    // Вывод в ошибке виден при падении и остаётся в истории прогонов.
    console.log(
      'рендер главы:',
      results.map((r) => `${r.blocks} блоков — ${r.ms.toFixed(1)} мс`).join('; '),
    );
  });

  it('время растёт линейно, а не квадратично', () => {
    /*
      Квадратичность означала бы, что каждый блок обходит уже построенные
      блоки — и на 6000 блоках страница встала бы. Линейность здесь не
      гарантия, а измеряемый факт: если тест упадёт, значит регрессия уже есть.
    */
    const small = medianOf([1, 2, 3].map(() => renderOnce(chapterOf(600))));
    const large = medianOf([1, 2, 3].map(() => renderOnce(chapterOf(2400))));

    // Допуск втрое: на доли миллисекунды измерение шумное, а учетверение
    // числа блоков вчетверо увеличивает и работу.
    expect(large, `600 блоков ${small.toFixed(1)} мс, 2400 — ${large.toFixed(1)} мс`).toBeLessThan(
      small * 12,
    );
  });

  it('узлов на абзац — константа, а не число символов', () => {
    /*
      Инвариант, на котором держится и скорость, и якоря: один блок — это
      `createElement` плюс текстовый узел, сколько бы символов в нём ни было.
      Если бы длина текста давала лишние узлы, DOM разросся бы и прокрутка
      начала бы тормозить на длинных абзацах.
    */
    const short = chapterOf(200).map((b) => ({ ...b, text: 'Коротко.', node: { name: 'p', attrs: {}, children: [textNode('Коротко.')] } }));
    const long = chapterOf(200).map((b) => ({ ...b, text: SENTENCE.repeat(20), node: { name: 'p', attrs: {}, children: [textNode(SENTENCE.repeat(20))] } }));

    const countOf = (blocks: EpubBlock[]): number => {
      const host = document.createElement('div');
      host.appendChild(renderChapter({ blocks }));
      return host.getElementsByTagName('*').length;
    };

    expect(countOf(long)).toBe(countOf(short));
  });
});