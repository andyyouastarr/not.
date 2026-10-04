// Development preview only; real validation and persistence live in Rust.
import type { Board, Change } from "./types";
let board: Board = {
  revision: 0,
  draft: null,
  tasks: [],
  stages: ["К выполнению", "В работе", "Готово"].map((title, i) => ({
    id: crypto.randomUUID(),
    title,
    completed: i === 2,
  })),
};
export function preview(change?: Change): Board {
  if (!change) return structuredClone(board);
  if (change.action === "draft") board.draft = structuredClone(change.draft);
  if (change.action === "save") {
    const old = board.tasks.find((t) => t.id === change.draft.id);
    if (old && old.revision !== change.draft.revision)
      throw Error("Задача изменилась");
    const task = {
      stageId: null,
      position: board.tasks.length,
      archived: false,
      deleted: false,
      ...old,
      ...structuredClone(change.draft),
      revision: change.draft.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    board.tasks = [...board.tasks.filter((t) => t.id !== task.id), task];
    board.draft = null;
  }
  if (change.action === "move") {
    const task = board.tasks.find((t) => t.id === change.id)!;
    task.stageId = change.stage;
    task.revision++;
    const ordered = board.tasks
      .filter(
        (t) =>
          t.id !== task.id &&
          t.stageId === change.stage &&
          !t.deleted &&
          !t.archived,
      )
      .sort((a, b) => a.position - b.position);
    const index = change.before
      ? ordered.findIndex((t) => t.id === change.before)
      : ordered.length;
    ordered.splice(index, 0, task);
    ordered.forEach((t, i) => (t.position = i));
  }
  if (change.action === "flag") {
    const task = board.tasks.find((t) => t.id === change.id)!;
    task[change.field] = change.value;
    task.revision++;
  }
  if (change.action === "stages") {
    board.stages = structuredClone(change.stages);
    if (change.removed)
      board.tasks
        .filter((t) => t.stageId === change.removed)
        .forEach((t) => {
          t.stageId = change.destination;
          t.revision++;
        });
  }
  if (change.action !== "draft") board.revision++;
  return structuredClone(board);
}
