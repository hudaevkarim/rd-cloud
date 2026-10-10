import type { WireComment } from '../api/types.js';

/**
 * Дерево комментариев: сортировка по месту в тексте и добавление новых.
 *
 * ─── Почему это отдельный модуль, а не часть страницы ────────────────────────
 *
 * Всё здесь — чистые функции над списком. Проверять их в компоненте означало бы
 * каждый раз поднимать React, роутер и три мока сети, чтобы убедиться, что
 * ответ встал на своё место после второго комментария в том же абзаце.
 *
 * ─── Почему сортировка по позиции, а не по времени ───────────────────────────
 *
 * Панель показывает комментарии к главе, и человек ищет в ней «что написали
 * к этому абзацу», а не «кто написал раньше». Порядок по времени для этого
 * вопроса бесполезен: пять комментариев из пяти разных мест перечислялись бы
 * вперемешку с текстом.
 *
 * Порядок по тексту — это же порядок чтения. Открыл панель, читаешь сверху вниз
 * и видишь те же абзацы в том же порядке.
 */

/** Позиция комментария в главе: блок, затем символ внутри блока. */
export function positionOf(comment: WireComment): { block: number; start: number } {
  const anchor = comment.anchor;
  if (typeof anchor !== 'object' || anchor === null) return { block: 0, start: 0 };
  const value = anchor as { blockIndex?: unknown; start?: unknown };
  return {
    block: typeof value.blockIndex === 'number' ? value.blockIndex : 0,
    start: typeof value.start === 'number' ? value.start : 0,
  };
}

/**
 * Корневые комментарии в порядке чтения.
 *
 * Мутирует переданный массив — не гибко, зато один проход и никаких копий на
 * каждом рендере. Вызывается на том массиве, который страница уже создала
 * для фильтра по главе, и копия была бы вторым местом, где живут комментарии.
 */
export function sortByPosition(comments: WireComment[]): WireComment[] {
  return comments.sort((a, b) => {
    const pa = positionOf(a);
    const pb = positionOf(b);
    if (pa.block !== pb.block) return pa.block - pb.block;
    if (pa.start !== pb.start) return pa.start - pb.start;
    // Совпадение позиций бывает при одинаковых координатах из разных правок
    // книги: порядок по времени даёт устойчивый результат, а не «как пришло».
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Добавляет комментарий в дерево.
 *
 * Ответ идёт к своему родителю, корень — в список. Возвращает новый массив:
 * мутация на месте обновила бы только текущий корень, а на панели с ответами
 * требовался бы ещё и новый объект родителя — то есть вложенное копирование.
 */
export function addComment(roots: WireComment[], comment: WireComment): WireComment[] {
  if (comment.parentId === null) return [...roots, comment];

  let found = false;
  const next = roots.map((root) => {
    if (root.id !== comment.parentId) return root;
    found = true;
    // Ответы не сортируются: сервер отдаёт их по времени, и человек читает
    // переписку сверху вниз. Сортировка по времени ещё и означала бы, что
    // правка ответа сдвигала бы его в списке.
    const replies = root.replies ?? [];
    return { ...root, replies: [...replies, comment] };
  });

  /*
    Родителя нет в списке — типичное состояние, а не ошибка.

    Так выходит, когда человек ответил на комментарий из панели, а сам комментарий
    лежит в другой главе или не попал в текущую страницу из-за пагинации. Ответ
    без контекста в панели лучше, чем потерянный ответ: он показан, помечен как
    ответ на отсутствующий, и не исчезает после перезагрузки.
  */
  if (!found) return [...roots, { ...comment, parentId: null }];

  return next;
}

/** Ответы комментария, всегда массивом — в разметке не может быть `undefined`. */
export function repliesOf(comment: WireComment): WireComment[] {
  return comment.replies ?? [];
}