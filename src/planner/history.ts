export interface StageSnapshot {
  id: string | null;
  name: string;
}
export interface HistoryContext {
  title: string;
  from: StageSnapshot | null;
  to: StageSnapshot;
  assignee: { id: string; name: string } | null;
  previousAssignee: { id: string; name: string } | null;
  completed: boolean;
  archived: boolean;
  deleted: boolean;
}
export interface HistoryEvent {
  id: number;
  taskId: string;
  revision: number;
  occurredAt: string;
  kind: string;
  reason: string;
  payload: Record<string, unknown>;
  operationId: string | null;
  localDate: string | null;
  utcOffset: number | null;
  context: HistoryContext | null;
  incomplete: boolean;
}
export interface HistoryCursor {
  epochMs: number;
  id: number;
  throughId: number;
}
export interface HistoryQuery {
  taskId: string | null;
  from: string | null;
  to: string | null;
  assignee: { mode: "all" } | { mode: "none" } | { mode: "person"; id: string };
  kinds: string[];
  cursor: HistoryCursor | null;
}
export interface HistoryPage {
  events: HistoryEvent[];
  next: HistoryCursor | null;
}
export function groupHistory(events: HistoryEvent[]) {
  const days = new Map<
    string,
    Map<string, { stage: StageSnapshot; events: HistoryEvent[] }>
  >();
  for (const event of [...events].sort(
    (a, b) =>
      Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id - b.id,
  )) {
    if (
      !event.localDate ||
      !event.context ||
      !["created", "moved"].includes(event.kind)
    )
      continue;
    let day = days.get(event.localDate);
    if (!day) {
      day = new Map();
      days.set(event.localDate, day);
    }
    const stage = event.context.to,
      key = stage.id || "inbox";
    let group = day.get(key);
    if (!group) {
      group = { stage, events: [] };
      day.set(key, group);
    }
    group.events.push(event);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b));
}
export function eventTime(e: HistoryEvent) {
  return new Date(Date.parse(e.occurredAt) + (e.utcOffset || 0) * 1000)
    .toISOString()
    .slice(11, 19);
}
export function dateLabel(date: string) {
  return new Date(date + "T12:00:00Z").toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
