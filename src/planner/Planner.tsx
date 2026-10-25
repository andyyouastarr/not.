import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Fragment } from "react";
import { useTaskDrag } from "./useTaskDrag";
import { Plus, Settings, Lock, PanelLeftOpen } from "lucide-react";
import { api, errorText, localDate } from "../api";
import type { Board, Change, Draft, Task } from "./types";
import { excerpt, newDraft } from "./types";
import TaskDialog, { type TaskDialogHandle } from "./TaskDialog";
import "./planner.css";
import { useAssignees } from "./AssigneeSettings";

export interface PlannerHandle {
  flush: () => Promise<void>;
  create: () => void;
}
type Props = {
  onSource: (source: import("../taskLinks").TaskLink) => Promise<void>;
  onDiary: () => void;
  onSettings: () => void;
  onLock: () => void;
  onExpand: () => void;
  collapsed: boolean;
};
export default forwardRef<PlannerHandle, Props>(function Planner(
  { onDiary, onSettings, onLock, onExpand, collapsed, onSource },
  ref,
) {
  const { items: assignees, error: assigneeError } = useAssignees();
  const assigneeNames = new Map(assignees.map((a) => [a.id, a.name]));
  const [board, setBoard] = useState<Board | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [view, setView] = useState("inbox"),
    [editing, setEditing] = useState<Draft | null>(null),
    [readOnly, setReadOnly] = useState(false),
    [recovered, setRecovered] = useState(false);
  const [today, setToday] = useState(localDate());
  const editor = useRef<TaskDialogHandle>(null),
    alive = useRef(true),
    operation = useRef<Promise<unknown>>(Promise.resolve());
  const scroll = useRef<HTMLDivElement>(null),
    edge = useRef<ReturnType<typeof setTimeout> | null>(null),
    frame = useRef(0),
    direction = useRef(0);
  const [pendingMove, setPendingMove] = useState<{
    id: string;
    stage: string | null;
    before: string | null;
  } | null>(null);
  const stopScroll = () => {
    direction.current = 0;
    if (edge.current) clearTimeout(edge.current);
    edge.current = null;
    cancelAnimationFrame(frame.current);
  };
  const edgeScroll = (dir: number) => {
    if (direction.current === dir) return;
    stopScroll();
    direction.current = dir;
    edge.current = setTimeout(() => {
      let previous = performance.now();
      const tick = (now: number) => {
        if (!direction.current) return;
        if (scroll.current)
          scroll.current.scrollLeft +=
            dir * Math.min(now - previous, 40) * 0.45;
        previous = now;
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    }, 350);
  };
  const load = useCallback(async () => {
    try {
      const b = await api("planner", {});
      if (alive.current) {
        setBoard(b);
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    window.addEventListener("planner-updated", load);
    const timer = setInterval(() => setToday(localDate()), 30000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("planner-updated", load);
      stopScroll();
    };
  }, [load]);
  const create = () => {
    if (board && !board.draft && !editing && !busy) {
      setReadOnly(false);
      setRecovered(false);
      setEditing(newDraft());
    }
  };
  useImperativeHandle(ref, () => ({
    create,
    flush: async () => {
      dragControl.cancel();
      await editor.current?.flush();
      await operation.current;
    },
  }));
  const change = async (change: Change) => {
    if (busy || (board?.draft && change.action !== "draft")) return;
    setBusy(true);
    setError("");
    const pending = api("plannerChange", { change });
    // A rejected move leaves the persisted board intact. Wait for settlement
    // on navigation, but do not let an already-reported error block locking.
    operation.current = pending.then(
      () => {},
      () => {},
    );
    try {
      const result = await pending;
      if (alive.current) setBoard(result);
    } catch (e) {
      if (alive.current) {
        setError(errorText(e));
        if (change.action === "move") {
          try {
            const fresh = await api("planner", {});
            if (alive.current) setBoard(fresh);
          } catch {}
        }
      }
    } finally {
      if (alive.current) setPendingMove(null);
      if (alive.current) setBusy(false);
    }
  };
  const move = (
    id: string,
    stage: string | null,
    before: string | null = null,
  ) => {
    const task = board?.tasks.find((t) => t.id === id);
    if (!task || before === id) return;
    if (busy || board?.draft) return;
    const original = list(task.stageId);
    if (
      task.stageId === stage &&
      (original[original.findIndex((t) => t.id === id) + 1]?.id || null) ===
        before
    )
      return;
    setPendingMove({ id, stage, before });
    void change({ action: "move", id, revision: task.revision, stage, before });
  };
  const flag = (task: Task, field: "archived" | "deleted", value: boolean) =>
    void change({
      action: "flag",
      id: task.id,
      revision: task.revision,
      field,
      value,
    });
  const open = (task: Task) => {
    if (busy || board?.draft) return;
    setReadOnly(task.deleted || task.archived);
    setRecovered(false);
    setEditing({
      id: task.id,
      title: task.title,
      document: task.document,
      deadline: task.deadline,
      assigneeId: task.assigneeId ?? null,
      revision: task.revision,
    });
  };
  const list = (stage: string | null) =>
    (board?.tasks || [])
      .filter((t) => t.stageId === stage && !t.archived && !t.deleted)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const dragControl = useTaskDrag(
    (id, target) => move(id, target.stage, target.before),
    busy || !!board?.draft || !!editing || view !== "inbox",
    stopScroll,
  );
  const activeDrag = dragControl.drag;
  const positions = useRef(
    new Map<string, { top: number; parent: Element | null }>(),
  );
  useLayoutEffect(() => {
    const next = new Map<string, { top: number; parent: Element | null }>();
    document
      .querySelectorAll<HTMLElement>("[data-task-list] > [data-task-id]")
      .forEach((el) => {
        if (!activeDrag) el.getAnimations().forEach((a) => a.cancel());
        const id = el.dataset.taskId!,
          top = el.offsetTop,
          parent = el.parentElement;
        const old = positions.current.get(id);
        if (
          activeDrag &&
          old?.parent === parent &&
          old.top !== top &&
          !matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          el.getAnimations().forEach((a) => a.cancel());
          el.animate(
            [
              { transform: `translateY(${old.top - top}px)` },
              { transform: "translateY(0)" },
            ],
            { duration: 120, easing: "ease-out" },
          );
        }
        next.set(id, { top, parent });
      });
    positions.current = next;
  }, [
    activeDrag?.id,
    activeDrag?.target?.stage,
    activeDrag?.target?.before,
    board,
    pendingMove,
  ]);
  const placement = activeDrag
    ? activeDrag.target
      ? { id: activeDrag.id, ...activeDrag.target }
      : {
          id: activeDrag.id,
          stage:
            board?.tasks.find((t) => t.id === activeDrag.id)?.stageId ?? null,
          before:
            list(
              board?.tasks.find((t) => t.id === activeDrag.id)?.stageId ?? null,
            )[
              list(
                board?.tasks.find((t) => t.id === activeDrag.id)?.stageId ??
                  null,
              ).findIndex((t) => t.id === activeDrag.id) + 1
            ]?.id ?? null,
        }
    : pendingMove;
  const renderList = (stage: string | null) => {
    const tasks = list(stage).filter((t) => t.id !== placement?.id);
    const moving = placement && board?.tasks.find((t) => t.id === placement.id);
    const slot =
      moving && placement?.stage === stage ? (
        activeDrag ? (
          <div
            className="task-drop-slot"
            style={{ height: activeDrag.height, width: "100%" }}
            aria-hidden="true"
          />
        ) : (
          card(moving)
        )
      ) : null;
    return (
      <>
        {tasks.map((t) => (
          <Fragment key={t.id}>
            {placement?.before === t.id && slot}
            {card(t)}
          </Fragment>
        ))}
        {(!placement?.before ||
          !tasks.some((t) => t.id === placement.before)) &&
          slot}
      </>
    );
  };
  const card = (task: Task) => {
    const locked = busy || !!board?.draft;
    const completed = board?.stages.some(
      (s) => s.id === task.stageId && s.completed,
    );
    const siblings = list(task.stageId),
      index = siblings.findIndex((t) => t.id === task.id);
    return (
      <article
        key={task.id}
        className={`planner-card ${completed ? "completed" : ""} ${pendingMove?.id === task.id ? "task-saving" : ""}`}
        data-task-id={task.id}
        data-movable={!busy && !task.archived && !task.deleted && !board?.draft}
        onPointerDown={(e) => {
          if (!task.archived && !task.deleted) dragControl.start(e, task.id);
        }}
        onDragStart={(e) => e.preventDefault()}
      >
        <button
          className="planner-card-open"
          disabled={busy || !!board?.draft}
          onClick={() => open(task)}
        >
          <strong>{task.title}</strong>
          <span>{excerpt(task.document).slice(0, 140)}</span>
          {task.assigneeId && (
            <small
              className="task-assignee"
              title={assigneeNames.get(task.assigneeId)}
            >
              {assigneeNames.get(task.assigneeId) || assigneeError || "..."}
            </small>
          )}
          {task.deadline && (
            <time
              className={!completed && task.deadline < today ? "overdue" : ""}
              dateTime={task.deadline}
            >
              {!completed && task.deadline < today ? "Просрочено · " : ""}
              {new Date(task.deadline + "T12:00:00").toLocaleDateString(
                "ru-RU",
              )}
            </time>
          )}
          {completed && <small>✓ Выполнено</small>}
        </button>
        <details className="card-menu">
          <summary aria-label={`Действия: ${task.title}`}>Действия</summary>
          <div>
            {!task.deleted && !task.archived && (
              <>
                <select
                  aria-label={`Стадия: ${task.title}`}
                  value={task.stageId || ""}
                  disabled={locked}
                  onChange={(e) => move(task.id, e.target.value || null)}
                >
                  <option value="">Входящие</option>
                  {board?.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
                <button
                  disabled={locked || index <= 0}
                  onClick={() =>
                    move(task.id, task.stageId, siblings[index - 1].id)
                  }
                >
                  Выше
                </button>
                <button
                  disabled={locked || index === siblings.length - 1}
                  onClick={() =>
                    move(task.id, task.stageId, siblings[index + 2]?.id || null)
                  }
                >
                  Ниже
                </button>
              </>
            )}
            {!task.deleted && (completed || task.archived) && (
              <button
                disabled={locked}
                onClick={() => flag(task, "archived", !task.archived)}
              >
                {task.archived ? "Вернуть из архива" : "В архив"}
              </button>
            )}
            <button
              disabled={locked}
              onClick={() => flag(task, "deleted", !task.deleted)}
            >
              {task.deleted ? "Восстановить" : "В корзину"}
            </button>
          </div>
        </details>
      </article>
    );
  };
  const recovery = board?.draft && !editing && (
    <div className="planner-recovery">
      <strong>Есть черновик задачи</strong>
      <p>Продолжите или удалите черновик, чтобы изменять задачи доски.</p>
      <p>{board.draft.title || "Без названия"}</p>
      <button
        onClick={() => {
          setReadOnly(false);
          setRecovered(true);
          setEditing(board.draft);
        }}
      >
        Продолжить черновик
      </button>
      <button
        disabled={busy}
        onClick={() => void change({ action: "draft", draft: null })}
      >
        Удалить черновик
      </button>
    </div>
  );
  return (
    <>
      <div className="entry-column planner-rail">
        <section className="entry-list">
          <header>
            <div className="mode-tabs">
              {collapsed && (
                <button title="Развернуть навигацию" onClick={onExpand}>
                  <PanelLeftOpen size={16} />
                </button>
              )}
              <button onClick={onDiary}>Дневник</button>
              <h1>Планер</h1>
            </div>
            <button
              className="icon-button"
              aria-label="Новая задача"
              disabled={!board || busy || !!board.draft}
              onClick={create}
            >
              <Plus size={19} />
            </button>
          </header>
          <nav className="planner-filters" aria-label="Раздел Планера">
            {[
              ["inbox", "Входящие"],
              ["archive", "Архив"],
              ["trash", "Корзина"],
            ].map(([id, title]) => (
              <button
                key={id}
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {title}
              </button>
            ))}
          </nav>
          <div
            className="planner-inbox"
            aria-label="Входящие задачи"
            data-task-list={view === "inbox" ? "" : undefined}
          >
            {view === "inbox" ? (
              <>
                {renderList(null)}
                {!list(null).length && (
                  <p className="planner-empty">
                    Новые задачи появятся здесь. Перенесите карточку на стадию
                    доски.
                  </p>
                )}
              </>
            ) : (
              <p className="planner-empty">
                {view === "archive"
                  ? "Завершённые задачи в архиве"
                  : "Удалённые задачи можно восстановить"}
              </p>
            )}
          </div>
          <footer className="planner-rail-footer">
            <button onClick={onSettings}>
              <Settings size={16} />
              Настройки
            </button>
            <button onClick={onLock} aria-label="Заблокировать">
              <Lock size={16} />
            </button>
          </footer>
        </section>
      </div>
      <main className="planner-main">
        <header className="planner-heading">
          <div>
            <p className="eyebrow">ПРОСТРАНСТВО ДЛЯ ДЕЛ</p>
            <h2>
              {view === "inbox"
                ? "Доска задач"
                : view === "archive"
                  ? "Архив"
                  : "Корзина"}
            </h2>
          </div>
          <button onClick={onSettings}>Настроить стадии</button>
        </header>
        {error && (
          <div className="planner-error" role="alert">
            {error}
            <button onClick={() => void load()}>Обновить</button>
          </div>
        )}
        {busy && (
          <p className="planner-transfer-status" role="status">
            Сохраняется… Перемещение временно недоступно.
          </p>
        )}
        {recovery}
        {!board && !error && <p>Загрузка…</p>}
        {view === "inbox" ? (
          <div className="board-viewport">
            <div
              className="kanban-board"
              ref={scroll}
              onWheel={(e) => {
                if (e.shiftKey && scroll.current)
                  scroll.current.scrollLeft += e.deltaY;
              }}
            >
              {board?.stages.map((s) => (
                <section
                  className="kanban-column"
                  key={s.id}
                  aria-label={s.title}
                >
                  <header>
                    <h3>
                      {s.completed && "✓ "}
                      {s.title}
                    </h3>
                    <span>{list(s.id).length}</span>
                  </header>
                  <div className="kanban-cards" data-task-list={s.id}>
                    {renderList(s.id)}
                    {!list(s.id).length && (
                      <p className="planner-empty">Перенесите задачу сюда</p>
                    )}
                  </div>
                </section>
              ))}
              {board && !board.stages.length && (
                <p className="planner-empty">
                  Добавьте стадии в настройках. Задачи остаются во «Входящих».
                </p>
              )}
            </div>
            {[-1, 1].map((dir) => (
              <button
                key={dir}
                className={`board-edge ${dir < 0 ? "left" : "right"}`}
                aria-label={
                  dir < 0 ? "Прокрутить доску влево" : "Прокрутить доску вправо"
                }
                onPointerEnter={() => {
                  if (!activeDrag) edgeScroll(dir);
                }}
                onPointerLeave={stopScroll}
                onClick={() =>
                  scroll.current?.scrollBy({
                    left: dir * 280,
                    behavior: matchMedia("(prefers-reduced-motion: reduce)")
                      .matches
                      ? "instant"
                      : "smooth",
                  })
                }
              >
                {dir < 0 ? "‹" : "›"}
              </button>
            ))}
          </div>
        ) : (
          <div className="planner-collection">
            {board?.tasks
              .filter((t) =>
                view === "trash" ? t.deleted : t.archived && !t.deleted,
              )
              .map(card)}
            {!board?.tasks.some((t) =>
              view === "trash" ? t.deleted : t.archived && !t.deleted,
            ) && <p className="planner-empty">Здесь пока пусто</p>}
          </div>
        )}
      </main>
      {activeDrag && (
        <div
          className="task-drag-overlay"
          aria-hidden="true"
          style={{
            left: activeDrag.x - activeDrag.offsetX,
            top: activeDrag.y - activeDrag.offsetY,
            width: activeDrag.width,
            height: activeDrag.height,
          }}
        >
          <strong>
            {board?.tasks.find((t) => t.id === activeDrag.id)?.title}
          </strong>
          <p>
            {excerpt(
              board?.tasks.find((t) => t.id === activeDrag.id)?.document || {},
            ).slice(0, 140)}
          </p>
        </div>
      )}
      {editing && (
        <TaskDialog
          ref={editor}
          key={editing.id}
          initial={editing}
          recovered={recovered}
          readOnly={readOnly}
          onSource={async (source) => {
            await editor.current?.flush();
            await onSource(source);
          }}
          onSaved={(b) => {
            setBoard(b);
            setEditing(null);
          }}
          onClose={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
});
