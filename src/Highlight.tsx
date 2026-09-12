import { Mark } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { useEffect, useRef, useState } from "react";
import { Highlighter, Eraser } from "lucide-react";
import { ru } from "./ru";

const colors = ["lavender", "yellow", "green", "pink"] as const;
type HighlightColor = (typeof colors)[number];
const validColor = (value: unknown): value is HighlightColor =>
  colors.includes(value as HighlightColor);

export const HighlightMark = Mark.create({
  name: "highlight",
  inclusive: false,
  addAttributes() {
    return {
      color: {
        default: "lavender",
        parseHTML: (element: HTMLElement) => {
          const color = element.getAttribute("data-highlight");
          return validColor(color) ? color : "lavender";
        },
        renderHTML: () => ({}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "mark" }];
  },
  renderHTML({ mark }) {
    return [
      "mark",
      {
        "data-highlight": validColor(mark.attrs.color)
          ? mark.attrs.color
          : "lavender",
      },
      0,
    ];
  },
});

export function HighlightTools({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        editor.commands.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, editor]);
  const apply = (color?: HighlightColor) => {
    if (editor.state.selection.empty) {
      setOpen(false);
      return;
    }
    editor.view.dispatch(closeHistory(editor.state.tr));
    if (!color || editor.isActive("highlight", { color }))
      editor.chain().focus().unsetMark("highlight").run();
    else editor.chain().focus().setMark("highlight", { color }).run();
    editor.view.dispatch(closeHistory(editor.state.tr));
    setOpen(false);
  };
  const names = {
    lavender: ru.highlightLavender,
    yellow: ru.highlightYellow,
    green: ru.highlightGreen,
    pink: ru.highlightPink,
  };
  return (
    <div className="highlight-tools" ref={ref}>
      <button
        title={ru.highlightHint}
        aria-label={ru.highlight}
        aria-expanded={open}
        className={editor.isActive("highlight") ? "active" : ""}
        disabled={
          editor.state.selection.empty || !editor.can().setMark("highlight")
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <Highlighter size={17} />
      </button>
      {open && (
        <div
          className="highlight-palette glass"
          role="group"
          aria-label={ru.highlightColors}
        >
          {colors.map((color) => (
            <button
              key={color}
              className={`highlight-swatch highlight-${color}`}
              title={names[color]}
              aria-label={names[color]}
              aria-pressed={editor.isActive("highlight", { color })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => apply(color)}
            >
              <span />
            </button>
          ))}
          <button
            title={ru.highlightRemove}
            aria-label={ru.highlightRemove}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => apply()}
          >
            <Eraser size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
