import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { demo, native } from "./api";
import { keyboardRows } from "./keyboardLayout";
import type { KeyboardLayout } from "./keyboardLayout";
import { ru } from "./ru";

interface KeyboardState {
  layout: KeyboardLayout | "unsupported";
  id: string;
  capsLock: boolean;
}
export default function KeyboardGuide({
  height,
  onHeight,
  width,
  onWidth,
  onClose,
}: {
  height: number;
  onHeight: (height: number) => void;
  width: number;
  onWidth: (width: number) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<KeyboardState | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [liveHeight, setLiveHeight] = useState(height);
  const [liveWidth, setLiveWidth] = useState(width);
  const panel = useRef<HTMLElement>(null);
  const widthDrag = useRef<{
    x: number;
    width: number;
    direction: number;
    latest: number;
  } | null>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => setLiveHeight(height), [height]);
  useEffect(() => setLiveWidth(width), [width]);
  useEffect(() => {
    const workspace = panel.current?.closest<HTMLElement>(".workspace");
    workspace?.style.setProperty("--keyboard-dock-width", `${liveWidth}px`);
  }, [liveWidth]);
  useEffect(() => {
    const keepCaretVisible = () => {
      const selection = window.getSelection();
      const scroll = document.querySelector(".document-scroll");
      if (
        !scroll ||
        !selection?.rangeCount ||
        !scroll.contains(selection.anchorNode)
      )
        return;
      const caret = selection.getRangeAt(0).getBoundingClientRect();
      const bounds = scroll.getBoundingClientRect();
      if (caret.bottom > bounds.bottom - 24)
        scroll.scrollTop += caret.bottom - bounds.bottom + 24;
    };
    const frame = requestAnimationFrame(keepCaretVisible);
    window.addEventListener("resize", keepCaretVisible);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", keepCaretVisible);
    };
  }, [liveHeight]);
  useEffect(() => {
    if (demo) {
      setState({ layout: "en-US", id: "demo", capsLock: false });
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let pending = false;
    const poll = async () => {
      if (stopped || pending) return;
      clearTimeout(timer);
      if (
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        native
      ) {
        pending = true;
        try {
          const next = await invoke<KeyboardState | null>("keyboard_state");
          if (!stopped) {
            setState((previous) =>
              JSON.stringify(previous) === JSON.stringify(next)
                ? previous
                : next,
            );
            setUnavailable(false);
          }
        } catch {
          if (!stopped) {
            setState(null);
            setUnavailable(true);
          }
        } finally {
          pending = false;
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 75);
    };
    const wake = () => void poll();
    const blur = () => setState(null);
    window.addEventListener("focus", wake);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", wake);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", wake);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  // Modifier events belong to this editor; never install a global key hook.
  useEffect(() => {
    const updateCaps = (event: KeyboardEvent) => {
      const capsLock = event.getModifierState("CapsLock");
      setState((s) => (s && s.capsLock !== capsLock ? { ...s, capsLock } : s));
    };
    window.addEventListener("keydown", updateCaps);
    window.addEventListener("keyup", updateCaps);
    return () => {
      window.removeEventListener("keydown", updateCaps);
      window.removeEventListener("keyup", updateCaps);
    };
  }, []);
  const clamp = (n: number) =>
    Math.round(Math.max(170, Math.min(340, window.innerHeight * 0.45, n)));
  const finish = () => {
    if (!drag.current) return;
    drag.current = null;
    onHeight(liveHeight);
  };
  const layout = state?.layout;
  const clampWidth = (value: number) =>
    Math.round(Math.max(300, Math.min(520, window.innerWidth * 0.45, value)));
  const finishWidth = () => {
    if (!widthDrag.current) return;
    const latest = widthDrag.current.latest;
    widthDrag.current = null;
    onWidth(latest);
  };
  return (
    <section
      ref={panel}
      id="keyboard-guide"
      className="keyboard-guide glass"
      aria-label={ru.keyboardGuide}
      style={
        {
          "--keyboard-height": `${liveHeight}px`,
          "--keyboard-width": `${liveWidth}px`,
        } as CSSProperties
      }
    >
      {[-1, 1].map((direction) => (
        <div
          key={direction}
          className={`keyboard-width-resize ${direction === 1 ? "keyboard-resize-right" : "keyboard-resize-left"}`}
          role={direction === 1 ? "separator" : undefined}
          tabIndex={direction === 1 ? 0 : undefined}
          aria-hidden={direction === -1 ? true : undefined}
          aria-label={direction === 1 ? ru.keyboardWidth : undefined}
          aria-orientation={direction === 1 ? "vertical" : undefined}
          aria-valuemin={direction === 1 ? 300 : undefined}
          aria-valuemax={direction === 1 ? 520 : undefined}
          aria-valuenow={direction === 1 ? liveWidth : undefined}
          title={ru.keyboardWidthHint}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const actualWidth = panel.current!.getBoundingClientRect().width;
            widthDrag.current = {
              x: e.clientX,
              width: actualWidth,
              direction,
              latest: liveWidth,
            };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const drag = widthDrag.current;
            if (!drag) return;
            drag.latest = clampWidth(
              drag.width + (e.clientX - drag.x) * 2 * drag.direction,
            );
            setLiveWidth(drag.latest);
          }}
          onPointerUp={finishWidth}
          onLostPointerCapture={finishWidth}
          onPointerCancel={() => {
            widthDrag.current = null;
            setLiveWidth(width);
          }}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            const actualWidth = panel.current!.getBoundingClientRect().width;
            const next = clampWidth(
              e.key === "Home"
                ? 300
                : e.key === "End"
                  ? 520
                  : actualWidth + (e.key === "ArrowRight" ? 20 : -20),
            );
            setLiveWidth(next);
            onWidth(next);
          }}
        >
          <span />
        </div>
      ))}
      <div
        className="keyboard-resize"
        role="separator"
        tabIndex={0}
        aria-label={ru.keyboardResize}
        aria-orientation="horizontal"
        aria-valuemin={170}
        aria-valuemax={340}
        aria-valuenow={liveHeight}
        title={ru.keyboardResizeHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          drag.current = { y: e.clientY, height: liveHeight };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setLiveHeight(
              clamp(drag.current.height + drag.current.y - e.clientY),
            );
        }}
        onPointerUp={finish}
        onLostPointerCapture={finish}
        onPointerCancel={() => {
          drag.current = null;
          setLiveHeight(height);
        }}
        onKeyDown={(e) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const next = clamp(
            e.key === "Home"
              ? 170
              : e.key === "End"
                ? 340
                : liveHeight + (e.key === "ArrowUp" ? 10 : -10),
          );
          setLiveHeight(next);
          onHeight(next);
        }}
      >
        <span />
      </div>
      <div className="keyboard-heading">
        <span>{ru.keyboardGuide}</span>
        <span className="keyboard-layout" role="status">
          {demo
            ? ru.keyboardDemo
            : layout === "ru-RU"
              ? "РУС"
              : layout === "en-US"
                ? "ENG · US"
                : "—"}
        </span>
        {state?.capsLock && <span className="keyboard-caps">Caps Lock</span>}
        <button
          className="icon-button"
          title={ru.keyboardHide}
          aria-label={ru.keyboardHide}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            onClose();
            if (e.detail === 0)
              document
                .querySelector<HTMLElement>(".tiptap")
                ?.focus({ preventScroll: true });
          }}
        >
          <X size={15} />
        </button>
      </div>
      {layout && layout !== "unsupported" ? (
        <div
          className="keyboard-overflow"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div
            className="keyboard-keys"
            role="img"
            aria-label={
              layout === "ru-RU" ? ru.keyboardRussian : ru.keyboardEnglish
            }
          >
            {keyboardRows(layout).map((row, r) => (
              <div className="keyboard-row" key={r} aria-hidden="true">
                {row.map((k, i) => (
                  <div
                    key={i}
                    className={`guide-key zone-${k.zone} ${k.home ? "home-key" : ""}`}
                    style={{ flex: `${k.width} 1 0` }}
                  >
                    {k.shifted && <small>{k.shifted}</small>}
                    <span>{k.label}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="keyboard-message">
          {unavailable
            ? ru.keyboardUnavailable
            : layout === "unsupported"
              ? `${ru.keyboardUnsupported} (${state?.id})`
              : ru.keyboardWaiting}
        </div>
      )}
    </section>
  );
}
