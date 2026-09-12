import { useEffect, useRef, useState } from "react";
import { Star, ChevronRight } from "lucide-react";
import type { Summary } from "./types";
import { ru } from "./ru";
import { localDate } from "./api";
export default function EntryList({
  rows,
  currentId,
  onSelect,
  more,
  onMore,
  empty,
  scope,
}: {
  rows: Summary[];
  currentId?: string;
  onSelect: (id: string) => void;
  more: boolean;
  onMore: () => void;
  empty: string;
  scope: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0),
    [height, setHeight] = useState(700);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
    setScroll(0);
  }, [scope]);
  let total = 0;
  const layout = rows.map((row, i) => {
    const month =
      i === 0 || row.date.slice(0, 7) !== rows[i - 1].date.slice(0, 7);
    const top = total;
    const size = 120 + (month ? 36 : 0);
    total += size;
    return { row, month, top, size };
  });
  const visible = layout.filter(
    (r) => r.top + r.size >= scroll - 240 && r.top <= scroll + height + 240,
  );
  return (
    <div
      ref={ref}
      className="entries-scroll"
      onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
    >
      {rows.length ? (
        <div style={{ height: total + (more ? 48 : 0), position: "relative" }}>
          {visible.map(({ row: r, month, top, size }) => (
            <div
              key={r.id}
              style={{
                position: "absolute",
                top,
                left: 0,
                right: 0,
                height: size,
              }}
            >
              {month && (
                <div className="month-label">
                  {new Date(r.date + "T12:00:00").toLocaleDateString("ru-RU", {
                    month: "long",
                    year: "numeric",
                  })}
                </div>
              )}
              <button
                className={`entry-card ${currentId === r.id ? "current" : ""}`}
                onClick={() => onSelect(r.id)}
              >
                <div className="entry-card-meta">
                  <time>
                    {r.date === localDate()
                      ? ru.today
                      : new Date(r.date + "T12:00:00").toLocaleDateString(
                          "ru-RU",
                          { day: "numeric", month: "long" },
                        )}
                  </time>
                  {r.favorite && <Star size={12} fill="currentColor" />}
                </div>
                <h3>{r.title || ru.untitled}</h3>
                <p>{r.excerpt || "…"}</p>
                {currentId === r.id && <span className="selected-bar" />}
              </button>
            </div>
          ))}
          {more && (
            <button
              style={{ position: "absolute", top: total }}
              className="load-more"
              onClick={onMore}
            >
              {ru.more}
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      ) : (
        <div className="list-empty">{empty}</div>
      )}
    </div>
  );
}
