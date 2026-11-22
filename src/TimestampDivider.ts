import { Node as TiptapNode, type Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { useEffect } from "react";
import { registerContextMenu } from "./contextMenu";

export function validTimestampDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T12:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}
export const timestampLabel = (date: string) =>
  date.split("-").reverse().join(".");
export function localTimestampDate(now = new Date()) {
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export const TimestampDivider = TiptapNode.create({
  name: "timestampDivider",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return { date: { default: null, rendered: false } };
  },
  parseHTML() {
    return [
      {
        tag: "div[data-timestamp-date]",
        getAttrs: (element) => {
          const date = element.getAttribute("data-timestamp-date") || "";
          return validTimestampDate(date) ? { date } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    const date = String(node.attrs.date);
    return [
      "div",
      {
        "data-timestamp-date": date,
        class: "timestamp-divider",
        contenteditable: "false",
      },
      ["time", { datetime: date }, timestampLabel(date)],
      ["span", { "aria-hidden": "true" }],
    ];
  },
  renderText({ node }) {
    return timestampLabel(String(node.attrs.date));
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state, view } = this.editor;
        const selection = state.selection;
        if (
          !selection.empty ||
          selection.$from.parentOffset !== 0 ||
          selection.$from.depth !== 1
        )
          return false;
        const start = selection.$from.before(1),
          previous = state.doc.resolve(start).nodeBefore;
        if (previous?.type.name !== this.name) return false;
        view.dispatch(
          state.tr.setSelection(
            NodeSelection.create(state.doc, start - previous.nodeSize),
          ),
        );
        return true;
      },
    };
  },
});

export function insertTimestampAfter(editor: Editor, position: number) {
  if (!editor.isEditable || editor.isDestroyed) return;
  const block = editor.state.doc.nodeAt(position);
  if (!block) return;
  const end = position + block.nodeSize;
  const next = editor.state.doc.nodeAt(end);
  const divider = editor.schema.nodes.timestampDivider.create({
    date: localTimestampDate(),
  });
  const nodes =
    next?.type.name === "paragraph" && next.content.size === 0
      ? [divider]
      : [divider, editor.schema.nodes.paragraph.create()];
  const tr = closeHistory(editor.state.tr).insert(end, nodes);
  tr.setSelection(
    TextSelection.create(tr.doc, end + divider.nodeSize + 1),
  ).scrollIntoView();
  editor.view.dispatch(tr);
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.view.focus();
}

// A task dialog temporarily owns the same native bridge as the diary. Cleanup
// restores the diary bridge, including when only the history tab is shown.
export function useTimestampMenu(editor: Editor | null, enabled: boolean) {
  useEffect(() => {
    if (!editor || !enabled) return;
    let pending: {
      token: string;
      position: number;
      doc: typeof editor.state.doc;
    } | null = null;
    let keyboard = false;
    const visible = () =>
      !editor.isDestroyed &&
      editor.isEditable &&
      editor.view.dom.getClientRects().length > 0 &&
      !editor.view.dom.closest("[hidden]") &&
      editor.view.dom.closest("dialog") ===
        (Array.from(document.querySelectorAll("dialog[open]")).at(-1) ?? null);
    const key = (event: KeyboardEvent) => {
      keyboard =
        event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    };
    const context = (event: MouseEvent) => {
      const prior = pending;
      pending = null;
      if (
        !visible() ||
        !editor.view.dom.contains(event.target as globalThis.Node)
      ) {
        keyboard = false;
        return;
      }
      const selection = editor.state.selection;
      const at =
        keyboard ||
        !Number.isFinite(event.clientX) ||
        !Number.isFinite(event.clientY)
          ? null
          : editor.view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });
      const inSelection =
        at && at.pos >= selection.from && at.pos <= selection.to;
      let position =
        keyboard || !at || inSelection
          ? Math.max(selection.from, selection.to - (selection.empty ? 0 : 1))
          : at.pos;
      keyboard = false;
      const resolved = editor.state.doc.resolve(position);
      position = resolved.depth
        ? resolved.before(1)
        : Math.min(position, editor.state.doc.content.size);
      if (!editor.state.doc.nodeAt(position) && position > 0) {
        const last = editor.state.doc.lastChild;
        if (last) position = editor.state.doc.content.size - last.nodeSize;
      }
      if (editor.state.doc.nodeAt(position))
        pending = {
          token:
            prior?.position === position && prior.doc === editor.state.doc
              ? prior.token
              : crypto.randomUUID(),
          position,
          doc: editor.state.doc,
        };
    };
    const bridge: NonNullable<Window["__notTaskMenu"]> = {
      prepare: () => {
        const timestamp =
          pending && visible() && pending.doc === editor.state.doc
            ? {
                token: pending.token,
                label: "Timestamp разделитель",
                enabled: true,
                appendWithoutSelectAll: true,
              }
            : null;
        return timestamp;
      },
      run: (token) => {
        if (!pending || pending.token !== token || !bridge.prepare()) return;
        const position = pending.position;
        pending = null;
        insertTimestampAfter(editor, position);
      },
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("contextmenu", context, true);
    const unregister = registerContextMenu(bridge, 20);
    return () => {
      pending = null;
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("contextmenu", context, true);
      unregister();
    };
  }, [editor, enabled]);
}
