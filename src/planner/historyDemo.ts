import type { Board } from "./types";
import type { HistoryEvent, HistoryQuery, HistoryPage } from "./history";
const events: HistoryEvent[] = [];
export function recordPreview(before: Board, after: Board) {
  const date = new Date(),
    offset = -date.getTimezoneOffset() * 60,
    local = new Date(date.getTime() + offset * 1000).toISOString().slice(0, 10);
  const stage = (b: Board, id: string | null) => ({
    id,
    name: id
      ? b.stages.find((s) => s.id === id)?.title || "Неизвестная стадия"
      : "Входящие",
  });
  const op = crypto.randomUUID();
  for (const t of after.tasks) {
    const old = before.tasks.find((p) => p.id === t.id);
    const kind = !old ? "created" : old.stageId !== t.stageId ? "moved" : null;
    if (!kind) continue;
    events.push({
      id: events.length + 1,
      taskId: t.id,
      revision: t.revision,
      occurredAt: date.toISOString(),
      kind,
      reason: "task",
      payload: {},
      operationId: op,
      localDate: local,
      utcOffset: offset,
      incomplete: false,
      context: {
        title: t.title,
        from: old ? stage(before, old.stageId) : null,
        to: stage(after, t.stageId),
        assignee: null,
        previousAssignee: null,
        completed: after.stages.some((s) => s.id === t.stageId && s.completed),
        archived: t.archived,
        deleted: t.deleted,
      },
    });
  }
}
export function historyPreview(q: HistoryQuery): HistoryPage {
  const through = q.cursor?.throughId ?? events.length;
  const all = events.filter(
    (e) =>
      e.id <= through &&
      (!q.taskId || e.taskId === q.taskId) &&
      (!q.kinds.length || q.kinds.includes(e.kind)) &&
      (!q.from || e.localDate! >= q.from) &&
      (!q.to || e.localDate! <= q.to) &&
      (!q.cursor || e.id > q.cursor.id),
  );
  const page = all.slice(0, 200),
    last = page.at(-1);
  return structuredClone({
    events: page,
    next:
      all.length > 200 && last
        ? {
            id: last.id,
            epochMs: Date.parse(last.occurredAt),
            throughId: through,
          }
        : null,
  });
}
