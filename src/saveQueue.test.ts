import { describe, it, expect } from "vitest";
import { SaveQueue } from "./saveQueue";
import type { Entry, SaveEntry } from "./types";
const base: SaveEntry = {
  id: "a",
  title: "a",
  date: "2026-09-11",
  document: { type: "doc" },
  revision: 0,
};
describe("save queue", () => {
  it("serializes edits arriving during a save without overwriting newer text", async () => {
    let resolve!: (e: Entry) => void;
    const sent: SaveEntry[] = [];
    const queue = new SaveQueue(
      async (e) => {
        sent.push(e);
        if (sent.length === 1) return new Promise((r) => (resolve = r));
        return { ...e, revision: e.revision + 1 } as Entry;
      },
      () => {},
      () => {},
    );
    queue.reset(base);
    queue.update(base);
    const p = queue.flush();
    queue.update({ ...base, title: "new" });
    resolve({ ...base, revision: 1 } as Entry);
    await p;
    expect(sent.map((e) => [e.title, e.revision])).toEqual([
      ["a", 0],
      ["new", 1],
    ]);
    expect(queue.dirty).toBe(false);
  });
  it("preserves unsaved content on failure and retries", async () => {
    let fail = true;
    const queue = new SaveQueue(
      async (e) => {
        if (fail) throw Error("disk full");
        return { ...e, revision: 1 } as Entry;
      },
      () => {},
      () => {},
    );
    queue.reset(base);
    queue.update(base);
    await expect(queue.flush()).rejects.toThrow();
    expect(queue.current?.title).toBe("a");
    expect(queue.dirty).toBe(true);
    fail = false;
    await queue.flush();
    expect(queue.dirty).toBe(false);
  });
});
