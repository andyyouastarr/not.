import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import {
  selectedLinks,
  normalizeTitle,
  type DiaryLinkActions,
} from "./taskLinks";
import type { Transaction, Selection } from "@tiptap/pm/state";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";

declare global {
  interface Window {
    __notTaskMenu?: {
      prepare: () => { label: string; token: string; enabled: boolean } | null;
      run: (token: string) => void;
    };
  }
}
export function useDiaryTaskMenu(
  editor: Editor | null,
  actions: DiaryLinkActions | undefined,
  onError: (e: string) => void,
) {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => {
    if (!editor || !actions) return;
    let pending: {
      token: string;
      bookmark: ReturnType<typeof editor.state.selection.getBookmark>;
    } | null = null;
    let eligible = false;
    const selectionInfo = (selection: Selection) => {
      const ranges = [...selection.ranges].sort(
        (a, b) => a.$from.pos - b.$from.pos,
      );
      const title = normalizeTitle(
        ranges
          .map((r) =>
            editor.state.doc.textBetween(r.$from.pos, r.$to.pos, " ", " "),
          )
          .join(" "),
      );
      const links = [
        ...new Set(
          ranges.flatMap((r) =>
            selectedLinks(editor.state.doc, r.$from.pos, r.$to.pos),
          ),
        ),
      ];
      return { title, links };
    };
    const context = (event: MouseEvent) => {
      pending = null;
      eligible =
        editor.isEditable &&
        editor.view.dom.contains(event.target as Node) &&
        !document.querySelector("dialog[open]");
      if (eligible)
        pending = {
          token: crypto.randomUUID(),
          bookmark: editor.state.selection.getBookmark(),
        };
    };
    const map = ({ transaction }: { transaction: Transaction }) => {
      if (pending) pending.bookmark = pending.bookmark.map(transaction.mapping);
    };
    document.addEventListener("contextmenu", context, true);
    editor.on("transaction", map);
    const bridge: NonNullable<Window["__notTaskMenu"]> = {
      prepare() {
        if (
          !eligible ||
          !pending ||
          editor.isDestroyed ||
          !editor.isEditable ||
          !latest.current
        )
          return null;
        const selection = pending.bookmark.resolve(editor.state.doc);
        const { title, links } = selectionInfo(selection);
        if (selection.empty || !title) return null;
        return {
          token: pending.token,
          enabled: links.length < 2,
          label:
            links.length > 1
              ? "Выделение связано с несколькими задачами"
              : links.length
                ? "Открыть задачу"
                : "Создать задачу",
        };
      },
      run(token) {
        if (!pending || pending.token !== token || !bridge.prepare()) return;
        const selection = pending.bookmark.resolve(editor.state.doc);
        const { from, to } = selection;
        pending = null;
        const { title, links } = selectionInfo(selection);
        if (links.length > 1) return;
        if (links.length === 1) {
          latest.current?.open(links[0]);
          return;
        }
        if ([...title].length > 300) {
          onError("Название слишком длинное");
          return;
        }
        editor.view.dispatch(editor.state.tr.setSelection(selection));
        void latest.current
          ?.create(editor, from, to)
          .catch((e) => onError(String(e)));
      },
    };
    window.__notTaskMenu = bridge;
    return () => {
      pending = null;
      eligible = false;
      editor.off("transaction", map);
      document.removeEventListener("contextmenu", context, true);
      if (window.__notTaskMenu === bridge) delete window.__notTaskMenu;
    };
  }, [editor, !!actions]);
}
export function UnlinkConfirmation({
  editor,
  pending,
  close,
}: {
  editor: Editor;
  pending: { transaction: Transaction; count: number };
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal glass"
      aria-label="Разорвать связь с задачей?"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <p>
        {pending.count === 1
          ? "Разорвать связь с задачей? Задача останется в Планере"
          : `Разорвать связи с задачами (${pending.count})? Задачи останутся в Планере`}
      </p>
      <button autoFocus onClick={close}>
        Отменить
      </button>
      <button
        onClick={() => {
          if (
            !editor.isDestroyed &&
            editor.state.doc.eq(pending.transaction.before)
          ) {
            if (!isHistoryTransaction(pending.transaction))
              closeHistory(pending.transaction);
            editor.view.dispatch(
              pending.transaction.setMeta("taskLinkApproved", true),
            );
          }
          close();
          // Focus the current selection after the dialog leaves the top layer.
          // Tiptap's deferred focus command can restore an older selection.
          requestAnimationFrame(() => {
            if (!editor.isDestroyed) editor.view.focus();
          });
        }}
      >
        Разорвать связь
      </button>
    </dialog>
  );
}
