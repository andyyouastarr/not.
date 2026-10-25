import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import type { Assignee, AssigneeChange } from "./types";

export function useAssignees() {
  const [items, setItems] = useState<Assignee[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api("assignees", {})
        .then((result) => {
          if (alive) {
            setItems(
              result.sort(
                (a, b) =>
                  a.name.localeCompare(b.name, "ru") ||
                  a.id.localeCompare(b.id),
              ),
            );
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        });
    load();
    window.addEventListener("planner-updated", load);
    return () => {
      alive = false;
      window.removeEventListener("planner-updated", load);
    };
  }, []);
  return { items, error };
}

export default function AssigneeSettings({
  onCreated,
  onDirty,
  onBusy,
  autoFocus = false,
}: {
  onCreated?: (id: string) => void;
  onDirty?: (dirty: boolean) => void;
  onBusy?: (busy: boolean) => void;
  autoFocus?: boolean;
}) {
  const { items, error: loadError } = useAssignees();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Assignee | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [confirm, setConfirm] = useState<Assignee | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    createId = useRef(crypto.randomUUID());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onDirty?.(!!name || busy);
  }, [name, busy, onDirty]);
  const change = async (change: AssigneeChange, created?: string) => {
    if (change.action !== "archive") {
      const normalized = change.name
        .normalize("NFC")
        .replace(/\p{White_Space}+/gu, " ")
        .trim();
      if (!normalized || [...normalized].length > 100) {
        setError("Введите имя исполнителя (до 100 символов)");
        return;
      }
    }
    setBusy(true);
    onBusy?.(true);
    setError("");
    try {
      await api("assigneeChange", { change });
      if (!alive.current) return;
      window.dispatchEvent(new Event("planner-updated"));
      setConfirm(null);
      if (change.action !== "archive") {
        setName("");
        setEditing(null);
        createId.current = crypto.randomUUID();
      }
      if (created) onCreated?.(created);
    } catch (e) {
      if (alive.current) {
        setError(errorText(e));
        window.dispatchEvent(new Event("planner-updated"));
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        onBusy?.(false);
      }
    }
  };
  return (
    <section className="assignee-settings" aria-label="Исполнители">
      <h4>Исполнители</h4>
      <p>Один исполнитель на задачу. Архив сохраняет назначения и историю.</p>
      <div className="assignee-create">
        <input
          autoFocus={autoFocus}
          aria-label="Имя исполнителя"
          placeholder="Имя исполнителя"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          disabled={busy || !name.trim()}
          onClick={() =>
            void change(
              editing
                ? {
                    action: "rename",
                    id: editing.id,
                    revision: editing.revision,
                    name,
                  }
                : { action: "create", id: createId.current, name },
              editing ? undefined : createId.current,
            )
          }
        >
          {editing ? "Сохранить имя" : "Добавить исполнителя"}
        </button>
        {editing && (
          <button
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setName("");
            }}
          >
            Отменить переименование
          </button>
        )}
      </div>
      {(error || loadError) && <p role="alert">{error || loadError}</p>}
      <label className="assignee-archived-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Показать архивных
      </label>
      <div className="assignee-list">
        {items
          .filter((a) => !a.archived || showArchived)
          .map((a) => (
            <div className="assignee-row" key={a.id}>
              <span title={a.name}>
                {a.name}
                {a.archived && <small> · В архиве</small>}
              </span>
              <button
                disabled={busy}
                aria-label={`Переименовать ${a.name}`}
                onClick={() => {
                  setEditing(a);
                  setName(a.name);
                }}
              >
                Переименовать
              </button>
              <button
                disabled={busy}
                aria-label={`${a.archived ? "Восстановить" : "Архивировать"} ${a.name}`}
                onClick={() =>
                  a.archived
                    ? void change({
                        action: "archive",
                        id: a.id,
                        revision: a.revision,
                        archived: false,
                      })
                    : setConfirm(a)
                }
              >
                {a.archived ? "Восстановить" : "В архив"}
              </button>
            </div>
          ))}
      </div>
      {confirm && (
        <div className="assignee-confirm">
          <p>
            Архивировать «{confirm.name}»? Существующие назначения сохранятся.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void change({
                action: "archive",
                id: confirm.id,
                revision: confirm.revision,
                archived: true,
              })
            }
          >
            Архивировать исполнителя
          </button>
          <button disabled={busy} onClick={() => setConfirm(null)}>
            Отменить
          </button>
        </div>
      )}
    </section>
  );
}

export function AssigneeDialog({
  onCreated,
  onClose,
}: {
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dirty, setDirty] = useState(false),
    [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) {
      if (dirty) setConfirm(true);
      else onClose();
    }
  };
  const outside = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
    const el = dialog.current;
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal glass assignee-dialog"
      aria-label="Настройки Планера → Исполнители"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        outside.current =
          e.target === e.currentTarget &&
          (e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (outside.current && e.target === e.currentTarget) close();
        outside.current = false;
      }}
    >
      <header>
        <h2>Настройки Планера → Исполнители</h2>
        <button
          aria-label="Закрыть исполнителей"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
      </header>
      <AssigneeSettings
        autoFocus
        onCreated={onCreated}
        onDirty={setDirty}
        onBusy={setBusy}
      />
      {confirm && (
        <footer>
          <span>Закрыть без сохранения введённого имени?</span>
          <button onClick={() => setConfirm(false)}>Продолжить</button>
          <button disabled={busy} onClick={onClose}>
            Закрыть без сохранения
          </button>
        </footer>
      )}
    </dialog>
  );
}
