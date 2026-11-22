import { useEffect, useRef } from "react";
import { registerContextMenu } from "../contextMenu";
import type { Task } from "./types";

export function useCardContextMenu(
  tasks: Task[],
  blocked: boolean,
  remove: (task: Task) => void,
) {
  const latest = useRef({ tasks, blocked, remove });
  latest.current = { tasks, blocked, remove };
  useEffect(() => {
    let pending: { id: string; revision: number; token: string } | null = null;
    const context = (event: MouseEvent) => {
      pending = null;
      if (document.querySelector("dialog[open]")) return;
      const card = (event.target as Element).closest?.(
        ".planner-card[data-task-id]",
      );
      const task = latest.current.tasks.find(
        (t) => t.id === card?.getAttribute("data-task-id"),
      );
      if (task && !task.deleted)
        pending = {
          id: task.id,
          revision: task.revision,
          token: crypto.randomUUID(),
        };
    };
    const bridge: NonNullable<Window["__notTaskMenu"]> = {
      prepare: () =>
        pending && !document.querySelector("dialog[open]")
          ? {
              label: "В корзину",
              token: pending.token,
              enabled: !latest.current.blocked,
              appendWithoutSelectAll: true,
            }
          : null,
      run: (token) => {
        if (!pending || token !== pending.token || !bridge.prepare()?.enabled)
          return;
        const snapshot = pending;
        pending = null;
        const task = latest.current.tasks.find(
          (t) =>
            t.id === snapshot.id &&
            t.revision === snapshot.revision &&
            !t.deleted,
        );
        if (task) latest.current.remove(task);
      },
    };
    const unregister = registerContextMenu(bridge, 10);
    document.addEventListener("contextmenu", context, true);
    return () => {
      pending = null;
      document.removeEventListener("contextmenu", context, true);
      unregister();
    };
  }, []);
}
