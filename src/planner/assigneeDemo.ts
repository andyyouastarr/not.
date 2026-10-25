import type { Assignee, AssigneeChange } from "./types";
let items: Assignee[] = [];
export function assigneePreview(change?: AssigneeChange): Assignee[] {
  if (change) {
    const old = items.find((a) => a.id === change.id);
    if (change.action === "archive") {
      if (!old || old.revision !== change.revision)
        throw Error("Исполнитель изменился");
      old.archived = change.archived;
      old.revision++;
    } else {
      const name = change.name.normalize("NFC").replace(/\s+/gu, " ").trim();
      if (!name || [...name].length > 100)
        throw Error("Введите имя исполнителя (до 100 символов)");
      const key = (s: string) => s.normalize("NFKC").toLocaleLowerCase();
      const duplicate = items.find(
        (a) => a.id !== change.id && key(a.name) === key(name),
      );
      if (duplicate)
        throw Error(
          duplicate.archived
            ? "Такой исполнитель уже в архиве. Покажите архивных и восстановите его."
            : "Исполнитель с таким именем уже существует",
        );
      if (change.action === "rename") {
        if (!old || old.revision !== change.revision)
          throw Error("Исполнитель изменился");
        old.name = name;
        old.revision++;
      } else if (!old) {
        const now = new Date().toISOString();
        items.push({
          id: change.id,
          name,
          revision: 1,
          archived: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
  return structuredClone(items);
}
