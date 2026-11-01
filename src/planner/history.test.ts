import { describe, it, expect } from "vitest";
import { groupHistory, eventTime, type HistoryEvent } from "./history";
function event(
  id: number,
  date: string,
  stage: string,
  name = stage,
): HistoryEvent {
  return {
    id,
    taskId: "task",
    revision: 1,
    occurredAt: date,
    kind: "moved",
    reason: "task",
    payload: {},
    operationId: "op",
    localDate: "2026-10-25",
    utcOffset: 36000,
    incomplete: false,
    context: {
      title: "Task",
      from: { id: null, name: "Входящие" },
      to: { id: stage, name },
      assignee: null,
      previousAssignee: null,
      completed: false,
      archived: false,
      deleted: false,
    },
  };
}
describe("history calendar grouping", () => {
  it("merges repeated visits by stable ID, retains historical names and timestamps", () => {
    const a = event(1, "2026-10-24T23:25:00Z", "work", "В работе");
    const b = event(2, "2026-10-25T04:00:00Z", "review");
    const c = event(3, "2026-10-25T05:40:00Z", "work", "Новое имя");
    const groups = groupHistory([c, b, a])[0][1];
    expect([...groups.keys()]).toEqual(["work", "review"]);
    expect(groups.get("work")!.stage.name).toBe("В работе");
    expect(groups.get("work")!.events.map((e) => e.id)).toEqual([1, 3]);
    expect(eventTime(a)).toBe("09:25:00");
    expect(c.context!.to.name).toBe("Новое имя");
  });
  it("does not invent local dates for old events or show non-transitions", () => {
    const a = event(1, "2026-10-25T00:00:00Z", "work");
    expect(
      groupHistory([
        { ...a, kind: "edited" },
        { ...a, localDate: null, context: null, incomplete: true },
      ]),
    ).toEqual([]);
  });
});
