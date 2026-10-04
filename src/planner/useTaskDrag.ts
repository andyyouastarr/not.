import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
export type Destination = { stage: string | null; before: string | null };
type Drag = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  target: Destination | null;
};
type Session = Drag & {
  pointer: number;
  startX: number;
  startY: number;
  active: boolean;
};
const inside = (r: DOMRect, x: number, y: number) =>
  x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
export function useTaskDrag(
  commit: (id: string, destination: Destination) => void,
  disabled: boolean,
  stopHover: () => void,
) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const session = useRef<Session | null>(null),
    options = useRef({ commit, disabled, stopHover });
  options.current = { commit, disabled, stopHover };
  const suppress = useRef(0);
  const cancel = useRef<() => void>(() => {});
  useEffect(() => {
    let frame = 0,
      previous = 0;
    const zones = new Map<
      string,
      { element: HTMLElement; sign: number; since: number }
    >();
    const finish = () => {
      const s = session.current;
      session.current = null;
      cancelAnimationFrame(frame);
      zones.clear();
      previous = 0;
      if (s?.active) suppress.current = performance.now() + 400;
      if (s && document.documentElement.hasPointerCapture(s.pointer))
        document.documentElement.releasePointerCapture(s.pointer);
      document.body.classList.remove("task-dragging");
      setDrag(null);
    };
    cancel.current = finish;
    const detect = (s: Session) => {
      const board = document.querySelector<HTMLElement>(".kanban-board");
      const containers = [
        ...document.querySelectorAll<HTMLElement>("[data-task-list]"),
      ];
      return containers.find(
        (el) =>
          inside(el.getBoundingClientRect(), s.x, s.y) &&
          (!el.closest(".kanban-board") ||
            (board && inside(board.getBoundingClientRect(), s.x, s.y))),
      );
    };
    const target = (s: Session, el?: HTMLElement): Destination | null => {
      if (!el) return null;
      const stage = el.dataset.taskList || null;
      const gap = el.querySelector<HTMLElement>(".task-drop-slot");
      if (
        gap &&
        inside(gap.getBoundingClientRect(), s.x, s.y) &&
        s.target?.stage === stage
      )
        return s.target;
      const cards = [
        ...el.querySelectorAll<HTMLElement>(":scope > [data-task-id]"),
      ];
      const before =
        cards
          .filter((c) => c.dataset.taskId !== s.id)
          .find((c) => {
            const r = c.getBoundingClientRect();
            const transform = getComputedStyle(c).transform;
            const shift =
              transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
            return s.y < r.top - shift + r.height / 2;
          })?.dataset.taskId || null;
      return { stage, before };
    };
    const scrollAxis = (
      el: HTMLElement | undefined,
      axis: "x" | "y",
      point: number,
      dt: number,
      now: number,
    ) => {
      if (!el) {
        zones.delete(axis);
        return;
      }
      const r = el.getBoundingClientRect(),
        low = axis === "x" ? r.left : r.top,
        high = axis === "x" ? r.right : r.bottom;
      const velocity =
        point < low + 40
          ? -Math.min(1, Math.max(0, (low + 40 - point) / 40))
          : point > high - 40
            ? Math.min(1, (point - high + 40) / 40)
            : 0;
      if (!velocity) {
        zones.delete(axis);
        return;
      }
      const sign = Math.sign(velocity),
        old = zones.get(axis);
      if (!old || old.element !== el || old.sign !== sign) {
        zones.set(axis, { element: el, sign, since: now });
        return;
      }
      if (now - old.since < 350) return;
      if (axis === "x") el.scrollLeft += (velocity * 600 * dt) / 1000;
      else el.scrollTop += (velocity * 600 * dt) / 1000;
    };
    const tick = (now: number) => {
      const s = session.current;
      if (!s?.active) return;
      const dt = Math.min(40, now - (previous || now));
      previous = now;
      const el = detect(s),
        board = document.querySelector<HTMLElement>(".kanban-board");
      const viewport = board?.parentElement?.getBoundingClientRect();
      scrollAxis(
        board && viewport && inside(viewport, s.x, s.y) ? board : undefined,
        "x",
        s.x,
        dt,
        now,
      );
      scrollAxis(el, "y", s.y, dt, now);
      s.target = target(s, detect(s));
      setDrag({ ...s });
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      const s = session.current;
      if (!s || s.pointer !== e.pointerId) return;
      s.x = e.clientX;
      s.y = e.clientY;
      if (!s.active && Math.hypot(s.x - s.startX, s.y - s.startY) >= 6) {
        s.active = true;
        options.current.stopHover();
        document.documentElement.setPointerCapture(e.pointerId);
        document.body.classList.add("task-dragging");
        window.getSelection()?.removeAllRanges();
        frame = requestAnimationFrame(tick);
      }
      if (s.active) e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      const s = session.current;
      if (!s || s.pointer !== e.pointerId) return;
      s.x = e.clientX;
      s.y = e.clientY;
      const destination = s.active ? target(s, detect(s)) : null;
      const id = s.id;
      finish();
      if (destination && !options.current.disabled)
        options.current.commit(id, destination);
    };
    const click = (e: MouseEvent) => {
      if (performance.now() < suppress.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    const newGesture = () => {
      suppress.current = 0;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && session.current) {
        e.preventDefault();
        finish();
      }
    };
    const hidden = () => {
      if (document.hidden) finish();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    window.addEventListener("lostpointercapture", finish);
    window.addEventListener("keydown", key, true);
    window.addEventListener("click", click, true);
    window.addEventListener("pointerdown", newGesture, true);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      finish();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      window.removeEventListener("lostpointercapture", finish);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("click", click, true);
      window.removeEventListener("pointerdown", newGesture, true);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    if (disabled) cancel.current();
  }, [disabled]);
  const start = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (
      options.current.disabled ||
      e.button !== 0 ||
      !e.isPrimary ||
      session.current
    )
      return;
    if (
      (e.target as HTMLElement).closest(
        "details, input, select, textarea, a, button:not(.planner-card-open)",
      )
    )
      return;
    const r = e.currentTarget.getBoundingClientRect();
    session.current = {
      id,
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: e.clientX - r.left,
      offsetY: e.clientY - r.top,
      width: r.width,
      height: r.height,
      target: null,
      active: false,
    };
  };
  return { drag, start, cancel: () => cancel.current() };
}
