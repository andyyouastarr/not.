import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import JournalEditor from "../Editor";
import { api, errorText } from "../api";
import type { Board, Draft } from "./types";
import type { TaskLink } from "../taskLinks";
import { AssigneeDialog, useAssignees } from "./AssigneeSettings";

export interface TaskDialogHandle {
  flush: () => Promise<void>;
}
export default forwardRef<
  TaskDialogHandle,
  {
    initial: Draft;
    recovered?: boolean;
    readOnly?: boolean;
    readOnlyReason?: string;
    onSource?: (source: TaskLink) => Promise<void>;
    onSaved: (board: Board) => void;
    onClose: () => void;
  }
>(function TaskDialog(
  { initial, recovered, readOnly, readOnlyReason, onSource, onSaved, onClose },
  ref,
) {
  const [source, setSource] = useState<TaskLink | null>(null);
  const { items: assignees, error: assigneeError } = useAssignees();
  const [assigneeSettings, setAssigneeSettings] = useState(false);
  const [taskState, setTaskState] = useState<{
    deleted: boolean;
    archived: boolean;
    revision: number;
  } | null>(null);
  const [draft, setDraft] = useState(initial);
  const current = useRef(initial);
  const baseline = useRef(recovered ? "" : JSON.stringify(initial));
  const persisted = useRef(recovered ? JSON.stringify(initial) : "");
  const [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const imports = useRef(new Set<Promise<void>>());
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const outside = useRef(false);
  const enqueue = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = chain.current
      .catch(() => {})
      .then(() => {
        if (!alive.current) throw Error("Окно задачи закрыто");
        return run();
      });
    chain.current = next;
    return next;
  };
  const saveDraft = async () => {
    if (
      readOnly ||
      (JSON.stringify(current.current) === baseline.current &&
        !persisted.current)
    )
      return;
    const snapshot = structuredClone(current.current),
      raw = JSON.stringify(snapshot);
    if (raw === persisted.current) return;
    setStatus("Сохраняется черновик…");
    await enqueue(() =>
      api("plannerChange", { change: { action: "draft", draft: snapshot } }),
    );
    if (alive.current) {
      persisted.current = raw;
      setStatus(
        JSON.stringify(current.current) === raw
          ? "Черновик сохранён"
          : "Несохранённые изменения",
      );
      setError("");
    }
  };
  const flush = async () => {
    if (timer.current) clearTimeout(timer.current);
    while (imports.current.size) await Promise.all([...imports.current]);
    if (!alive.current) return;
    while (alive.current) {
      const snapshot = JSON.stringify(current.current);
      await saveDraft();
      await chain.current;
      if (snapshot === JSON.stringify(current.current)) return;
      if (timer.current) clearTimeout(timer.current);
    }
  };
  useImperativeHandle(ref, () => ({ flush }));
  useEffect(() => {
    alive.current = true;
    void Promise.all([api("taskLinks", {}), api("planner", {})])
      .then(([links, board]) => {
        if (alive.current) {
          setSource(links.find((l) => l.taskId === initial.id) || null);
          setTaskState(board.tasks.find((t) => t.id === initial.id) || null);
        }
      })
      .catch((e) => {
        if (alive.current) setError(errorText(e));
      });
    dialog.current?.showModal();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      dialog.current?.close();
    };
  }, []);
  const update = (patch: Partial<Draft>) => {
    current.current = { ...current.current, ...patch };
    setDraft(current.current);
    setStatus("Несохранённые изменения");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () =>
        void saveDraft().catch((e) => {
          if (alive.current) {
            setError(errorText(e));
            setStatus("Ошибка сохранения черновика");
          }
        }),
      500,
    );
  };
  const cancel = () => {
    if (busy || assigneeSettings) return;
    if (
      JSON.stringify(current.current) !== baseline.current ||
      imports.current.size
    )
      setConfirm(true);
    else if (readOnly) onClose();
    else void discard();
  };
  const discard = async () => {
    setBusy(true);
    setSaving(true);
    if (timer.current) clearTimeout(timer.current);
    try {
      while (imports.current.size)
        await Promise.allSettled([...imports.current]);
      if (timer.current) clearTimeout(timer.current);
      await enqueue(() =>
        api("plannerChange", { change: { action: "draft", draft: null } }),
      );
      if (alive.current) onClose();
    } catch (e) {
      if (alive.current) {
        setError(errorText(e));
        setBusy(false);
        setSaving(false);
      }
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await flush();
      if (!alive.current) return;
      setSaving(true);
      const result = await enqueue(() =>
        api("plannerChange", {
          change: { action: "save", draft: current.current },
        }),
      );
      if (alive.current) onSaved(result);
    } catch (e) {
      if (alive.current) {
        setError(errorText(e));
        setBusy(false);
        setSaving(false);
      }
    }
  };
  return (
    <dialog
      ref={dialog}
      className="modal glass task-dialog"
      aria-label={readOnly ? "Просмотр задачи" : "Задача"}
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        outside.current =
          e.target === e.currentTarget &&
          (e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom);
      }}
      onClick={(e) => {
        if (outside.current && e.target === e.currentTarget) cancel();
        outside.current = false;
      }}
    >
      <header>
        <h2>
          {readOnly
            ? "Просмотр задачи"
            : initial.revision
              ? "Редактирование задачи"
              : "Новая задача"}
        </h2>
        <button aria-label="Закрыть задачу" disabled={busy} onClick={cancel}>
          ×
        </button>
      </header>
      {readOnlyReason && <p>{readOnlyReason}</p>}
      {source &&
        (source.active ? (
          <button
            onClick={() =>
              void (async () => {
                try {
                  await flush();
                  if (alive.current) await onSource?.(source);
                } catch (e) {
                  if (alive.current) setError(errorText(e));
                }
              })()
            }
          >
            Открыть фрагмент в дневнике
          </button>
        ) : (
          <p>Связь с фрагментом разорвана</p>
        ))}
      {(taskState?.deleted || taskState?.archived) && (
        <p>
          {taskState.deleted ? "Задача в корзине" : "Задача в архиве"}
          <button
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  const board = await api("plannerChange", {
                    change: {
                      action: "flag",
                      id: initial.id,
                      revision: taskState.revision,
                      field: taskState.deleted ? "deleted" : "archived",
                      value: false,
                    },
                  });
                  if (alive.current) onSaved(board);
                } catch (e) {
                  if (alive.current) {
                    setError(errorText(e));
                    setBusy(false);
                  }
                }
              })()
            }
          >
            Восстановить задачу
          </button>
        </p>
      )}
      <div className="task-fields">
        <label>
          Название
          <input
            autoFocus
            aria-label="Название задачи"
            value={draft.title}
            disabled={busy || readOnly}
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>
        <label>
          Исполнитель
          <span className="assignee-picker">
            <select
              aria-label="Исполнитель"
              value={draft.assigneeId || ""}
              disabled={busy || readOnly}
              onChange={(e) => update({ assigneeId: e.target.value || null })}
            >
              <option value="">Без исполнителя</option>
              {assignees
                .filter((a) => !a.archived || a.id === draft.assigneeId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.archived ? " · В архиве" : ""}
                  </option>
                ))}
            </select>
            {!readOnly && (
              <button
                title="Добавить исполнителя"
                aria-label="Добавить исполнителя"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      await flush();
                      if (alive.current) setAssigneeSettings(true);
                    } catch (e) {
                      if (alive.current) setError(errorText(e));
                    } finally {
                      if (alive.current) setBusy(false);
                    }
                  })()
                }
              >
                +
              </button>
            )}
          </span>
        </label>
        <label>
          Дедлайн
          <input
            type="date"
            aria-label="Дедлайн"
            value={draft.deadline || ""}
            disabled={busy || readOnly}
            onChange={(e) => update({ deadline: e.target.value || null })}
          />
        </label>
      </div>
      <div className="task-description">
        <JournalEditor
          document={draft.document}
          editable={!saving && !readOnly}
          onChange={(document) => update({ document })}
          onError={setError}
          onImport={(promise) => {
            imports.current.add(promise);
            void promise.then(
              () => imports.current.delete(promise),
              () => imports.current.delete(promise),
            );
          }}
        />
      </div>
      <footer className="task-dialog-footer">
        <div aria-live="polite">
          {error || assigneeError ? (
            <span role="alert">{error || assigneeError}</span>
          ) : (
            status
          )}
        </div>
        {confirm ? (
          <>
            <span>Удалить изменения?</span>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              Продолжить
            </button>
            <button disabled={busy} onClick={() => void discard()}>
              Удалить изменения
            </button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={cancel}>
              {readOnly ? "Закрыть" : "Отменить"}
            </button>
            {!readOnly && (
              <button
                className="primary"
                disabled={busy || !draft.title.trim()}
                onClick={() => void save()}
              >
                Сохранить
              </button>
            )}
          </>
        )}
      </footer>
      {assigneeSettings && (
        <AssigneeDialog
          onClose={() => setAssigneeSettings(false)}
          onCreated={(id) => {
            setAssigneeSettings(false);
            update({ assigneeId: id });
          }}
        />
      )}
    </dialog>
  );
});
