import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { Board, Stage } from "./types";
export default function PlannerSettings() {
  const [board, setBoard] = useState<Board | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null),
    [destination, setDestination] = useState("");
  useEffect(() => {
    let alive = true;
    void api("planner", {})
      .then((b) => {
        if (alive) setBoard(b);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  const save = async (stages: Stage[], removed: string | null = null) => {
    if (!board) return;
    setBusy(true);
    setError("");
    try {
      const result = await api("plannerChange", {
        change: {
          action: "stages",
          stages,
          revision: board.revision,
          removed,
          destination: removed ? destination || null : null,
        },
      });
      setBoard(result);
      setRemoving(null);
      setDestination("");
      window.dispatchEvent(new Event("planner-updated"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const update = (id: string, patch: Partial<Stage>) =>
    setBoard(
      (b) =>
        b && {
          ...b,
          stages: b.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        },
    );
  return (
    <section className="settings-section planner-settings">
      <h3>Планер</h3>
      <p>Стадии доски. Завершающая стадия отмечает задачу выполненной.</p>
      {board?.draft && (
        <p>
          Сначала продолжите или удалите черновик в Планере, затем изменяйте
          стадии.
        </p>
      )}
      <fieldset
        className="planner-settings-fields"
        disabled={busy || !!board?.draft}
      >
        {error && <p role="alert">{error}</p>}
        {board?.stages.map((s, i) => (
          <div className="stage-setting" key={s.id}>
            <input
              aria-label={`Название стадии ${i + 1}`}
              value={s.title}
              maxLength={100}
              disabled={busy}
              onChange={(e) => update(s.id, { title: e.target.value })}
            />
            <label title="Завершающая стадия">
              <input
                type="checkbox"
                aria-label={`Завершающая стадия ${i + 1}`}
                checked={s.completed}
                disabled={busy}
                onChange={(e) => update(s.id, { completed: e.target.checked })}
              />
              Готово
            </label>
            <button
              aria-label={`Поднять стадию ${i + 1}`}
              disabled={busy || !i}
              onClick={() => {
                const stages = [...board.stages];
                [stages[i - 1], stages[i]] = [stages[i], stages[i - 1]];
                setBoard({ ...board, stages });
              }}
            >
              ↑
            </button>
            <button
              aria-label={`Опустить стадию ${i + 1}`}
              disabled={busy || i === board.stages.length - 1}
              onClick={() => {
                const stages = [...board.stages];
                [stages[i + 1], stages[i]] = [stages[i], stages[i + 1]];
                setBoard({ ...board, stages });
              }}
            >
              ↓
            </button>
            <button
              aria-label={`Удалить стадию ${i + 1}`}
              disabled={busy}
              onClick={() => {
                setRemoving(s.id);
                setDestination("");
              }}
            >
              ×
            </button>
          </div>
        ))}
        {removing && board && (
          <div className="stage-removal">
            <p>
              Удалить стадию? Все её задачи, включая архив и корзину,
              переместятся в выбранное место.
            </p>
            <select
              aria-label="Куда перенести задачи"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="">Входящие</option>
              {board.stages
                .filter((s) => s.id !== removing)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
            </select>
            <button
              disabled={busy}
              onClick={() =>
                void save(
                  board.stages.filter((s) => s.id !== removing),
                  removing,
                )
              }
            >
              Удалить стадию
            </button>
            <button onClick={() => setRemoving(null)}>Отменить</button>
          </div>
        )}
        {board && (
          <div className="stage-setting-actions">
            <button
              disabled={busy}
              onClick={() =>
                setBoard({
                  ...board,
                  stages: [
                    ...board.stages,
                    {
                      id: crypto.randomUUID(),
                      title: "Новая стадия",
                      completed: false,
                    },
                  ],
                })
              }
            >
              + Добавить стадию
            </button>
            <button
              disabled={busy || board.stages.some((s) => !s.title.trim())}
              onClick={() => void save(board.stages)}
            >
              Сохранить стадии
            </button>
          </div>
        )}
      </fieldset>
    </section>
  );
}
