import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { api, errorText } from "./api";
import type { Entry, SaveEntry } from "./types";
import {
  markTransaction,
  removeLink,
  regions,
  type LinkDisplay,
  type TaskLink,
} from "./taskLinks";
import TaskDialog, { type TaskDialogHandle } from "./planner/TaskDialog";
import type { Board, Task } from "./planner/types";

const input = (e: Entry): SaveEntry => ({
  id: e.id,
  date: e.date,
  title: e.title,
  document: e.document,
  revision: e.revision,
});
export function useLinkedTasks(options: {
  entry: Entry | null;
  active: boolean;
  epoch: React.RefObject<number>;
  getEntry: () => Entry | null;
  flushDiary: () => Promise<void>;
  apply: (entry: Entry) => void;
  refresh: () => Promise<void>;
  error: (message: string) => void;
  jump: (source: TaskLink) => Promise<void>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [links, setLinks] = useState<LinkDisplay[]>([]);
  const [opened, setOpened] = useState<{ task: Task; board: Board } | null>(
    null,
  );
  const [toast, setToast] = useState<{ fragment: string; task: Task } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const editing = useRef(false),
    editor = useRef<Editor | null>(null),
    dialog = useRef<TaskDialogHandle>(null);
  const operation = useRef<Promise<void>>(Promise.resolve());
  const reload = async () => {
    const epoch = latest.current.epoch.current;
    const [rows, board] = await Promise.all([
      api("taskLinks", {}),
      api("planner", {}),
    ]);
    if (epoch !== latest.current.epoch.current) return;
    setLinks(
      rows.map((row) => {
        const task = board.tasks.find((t) => t.id === row.taskId);
        const completed = board.stages.some(
          (s) => s.id === task?.stageId && s.completed,
        );
        return {
          ...row,
          title: task?.title || "Задача недоступна",
          completed,
          status: task?.deleted
            ? "В корзине"
            : task?.archived
              ? "В архиве"
              : completed
                ? "Выполнена"
                : "Не выполнена",
        };
      }),
    );
  };
  useEffect(() => {
    if (options.active) void reload().catch((e) => options.error(errorText(e)));
    else {
      setLinks([]);
      setOpened(null);
      setToast(null);
      editor.current = null;
      setBusy(false);
    }
  }, [options.active, options.entry?.id]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 10000);
    return () => clearTimeout(timer);
  }, [toast]);
  const open = async (fragment: string) => {
    const epoch = latest.current.epoch.current;
    try {
      await latest.current.flushDiary();
      const [rows, board] = await Promise.all([
        api("taskLinks", {}),
        api("planner", {}),
      ]);
      if (epoch !== latest.current.epoch.current) return;
      const link = rows.find((l) => l.fragmentId === fragment),
        task = board.tasks.find((t) => t.id === link?.taskId);
      if (!task) throw Error("Задача недоступна");
      setOpened({ task, board });
    } catch (e) {
      if (epoch === latest.current.epoch.current)
        latest.current.error(errorText(e));
    }
  };
  const run = (work: (epoch: number) => Promise<void>) => {
    if (editing.current) return Promise.resolve();
    editing.current = true;
    const epoch = latest.current.epoch.current;
    const pending = work(epoch)
      .catch((e) => {
        if (epoch === latest.current.epoch.current)
          latest.current.error(errorText(e));
      })
      .finally(() => {
        editing.current = false;
        if (epoch === latest.current.epoch.current) setBusy(false);
      });
    operation.current = pending;
    return pending;
  };
  const create = (view: Editor, from: number, to: number) =>
    run(async (epoch) => {
      let bookmark = (
        view.state.selection.from === from && view.state.selection.to === to
          ? view.state.selection
          : TextSelection.create(view.state.doc, from, to)
      ).getBookmark();
      const map = ({
        transaction,
      }: {
        transaction: import("@tiptap/pm/state").Transaction;
      }) => {
        bookmark = bookmark.map(transaction.mapping);
      };
      view.on("transaction", map);
      try {
        await latest.current.flushDiary();
      } finally {
        view.off("transaction", map);
      }
      if (epoch !== latest.current.epoch.current || view.isDestroyed) return;
      const entry = latest.current.getEntry();
      if (!entry || entry.deleted) return;
      setBusy(true);
      view.setEditable(false, false);
      try {
        const range = bookmark.resolve(view.state.doc),
          fragment = crypto.randomUUID();
        const tr = markTransaction(
          view,
          range.from,
          range.to,
          fragment,
          range.ranges.map((r) => ({ from: r.$from.pos, to: r.$to.pos })),
        );
        const result = await api("createLinkedTask", {
          entry: { ...input(entry), document: tr.doc.toJSON() },
          fragment,
          operation: crypto.randomUUID(),
        });
        if (epoch !== latest.current.epoch.current || view.isDestroyed) return;
        tr.setMeta("preventUpdate", true);
        view.view.dispatch(tr);
        latest.current.apply(result.entry);
        setToast({ fragment, task: result.task });
        await reload();
        await latest.current.refresh();
      } finally {
        if (!view.isDestroyed) view.setEditable(true, false);
      }
    });
  const undo = () =>
    run(async (epoch) => {
      await latest.current.flushDiary();
      const entry = latest.current.getEntry(),
        view = editor.current;
      if (
        !entry ||
        !view ||
        !toast ||
        epoch !== latest.current.epoch.current ||
        !regions(view.state.doc).has(toast.fragment)
      )
        throw Error("Связь уже изменилась. Отмена недоступна.");
      setBusy(true);
      view.setEditable(false, false);
      try {
        const tr = removeLink(view, toast.fragment);
        const saved = await api("undoLinkedTask", {
          entry: { ...input(entry), document: tr.doc.toJSON() },
          fragment: toast.fragment,
          revision: toast.task.revision,
        });
        if (epoch !== latest.current.epoch.current || view.isDestroyed) return;
        view.view.dispatch(tr.setMeta("preventUpdate", true));
        latest.current.apply(saved);
        setToast(null);
        await reload();
        await latest.current.refresh();
      } finally {
        if (!view.isDestroyed) view.setEditable(true, false);
      }
    });
  return {
    busy,
    ready: (value: Editor) => {
      editor.current = value;
    },
    flush: async () => {
      await operation.current;
      await dialog.current?.flush();
    },
    actions: { links, create, open: (id: string) => void open(id) },
    ui: (
      <>
        {opened && options.active && (
          <TaskDialog
            ref={dialog}
            key={opened.task.id}
            initial={
              opened.board.draft?.id === opened.task.id
                ? opened.board.draft
                : {
                    id: opened.task.id,
                    title: opened.task.title,
                    document: opened.task.document,
                    deadline: opened.task.deadline,
                    assigneeId: opened.task.assigneeId ?? null,
                    revision: opened.task.revision,
                  }
            }
            recovered={opened.board.draft?.id === opened.task.id}
            readOnly={
              opened.task.archived ||
              opened.task.deleted ||
              (!!opened.board.draft && opened.board.draft.id !== opened.task.id)
            }
            readOnlyReason={
              opened.board.draft && opened.board.draft.id !== opened.task.id
                ? "Открыт другой черновик. Задача доступна только для просмотра."
                : undefined
            }
            onSource={async (source) => {
              await dialog.current?.flush();
              setOpened(null);
              await latest.current.jump(source);
            }}
            onSaved={() => {
              setOpened(null);
              void reload().catch((e) => latest.current.error(errorText(e)));
            }}
            onClose={() => {
              setOpened(null);
              void reload().catch((e) => latest.current.error(errorText(e)));
            }}
          />
        )}
        {toast && options.active && (
          <div className="notice task-created-notice" role="status">
            <span>Задача создана</span>
            <button disabled={busy} onClick={() => void open(toast.fragment)}>
              Открыть задачу
            </button>
            <button
              disabled={
                busy ||
                options.entry?.deleted ||
                !links.some(
                  (l) =>
                    l.fragmentId === toast.fragment &&
                    l.entryId === options.entry?.id,
                )
              }
              onClick={() => void undo()}
            >
              Отменить
            </button>
          </div>
        )}
      </>
    ),
  };
}
