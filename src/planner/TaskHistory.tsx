import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import {
  dateLabel,
  eventTime,
  groupHistory,
  type HistoryCursor,
  type HistoryEvent,
} from "./history";
export default function TaskHistory({
  id,
  saved,
}: {
  id: string;
  saved: boolean;
}) {
  const [events, setEvents] = useState<HistoryEvent[]>([]),
    [cursor, setCursor] = useState<HistoryCursor | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const load = async (next: HistoryCursor | null) => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await api("taskHistory", {
        query: {
          taskId: id,
          from: null,
          to: null,
          assignee: { mode: "all" },
          kinds: ["created", "moved", "baseline"],
          cursor: next,
        },
      });
      if (generation.current === request) {
        setEvents((old) => {
          const combined = next ? [...old, ...result.events] : result.events;
          return [...new Map(combined.map((e) => [e.id, e])).values()];
        });
        setCursor(result.next);
      }
    } catch (e) {
      if (generation.current === request) setError(errorText(e));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  };
  useEffect(() => {
    setEvents([]);
    setCursor(null);
    if (saved) void load(null);
    return () => {
      generation.current++;
    };
  }, [id, saved]);
  if (!saved)
    return (
      <div className="task-history-empty">
        История появится после создания задачи
      </div>
    );
  const baseline = events.find((e) => e.kind === "baseline" && !e.incomplete);
  return (
    <div className="task-history" aria-busy={busy}>
      {baseline && (
        <div className="task-history-baseline">
          <p>
            Полная история переходов ведётся с {dateLabel(baseline.localDate!)}.
          </p>
          <p>Исходное состояние: {baseline.context!.to.name}</p>
        </div>
      )}
      {groupHistory(events).map(([date, groups]) => (
        <section className="history-day" key={date}>
          <h3>{dateLabel(date)}</h3>
          {[...groups].map(([key, group]) => (
            <section className="history-stage" key={key}>
              <h4>{group.stage.name}</h4>
              <ol>
                {group.events.map((e) => (
                  <li key={e.id}>
                    <time
                      dateTime={e.occurredAt}
                      title={`${eventTime(e)} · UTC${(e.utcOffset || 0) >= 0 ? "+" : "−"}${String(Math.floor(Math.abs(e.utcOffset || 0) / 3600)).padStart(2, "0")}:${String(Math.floor((Math.abs(e.utcOffset || 0) % 3600) / 60)).padStart(2, "0")}`}
                    >
                      {eventTime(e).slice(0, 5)}
                    </time>
                    <span>
                      {e.kind === "created"
                        ? "Задача создана"
                        : `Из «${e.context?.from?.name || "Неизвестная стадия"}»`}
                      {e.context!.to.name !== group.stage.name && (
                        <small>В «{e.context!.to.name}»</small>
                      )}
                      {e.reason === "stageSettings" && (
                        <small>При удалении стадии</small>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </section>
      ))}
      {!busy && !error && !events.length && <p>Переходов пока нет.</p>}
      {busy && <p role="status">Загрузка истории…</p>}
      {error && (
        <div role="alert">
          {error}
          <button onClick={() => void load(cursor)}>Повторить</button>
        </div>
      )}
      {cursor && !error && (
        <button disabled={busy} onClick={() => void load(cursor)}>
          Показать ещё
        </button>
      )}
    </div>
  );
}
