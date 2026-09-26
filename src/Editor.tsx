import { useEffect, useState, useRef } from "react";
import { Node, Extension, mergeAttributes } from "@tiptap/core";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import type { Editor as EditorType, JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import Placeholder from "@tiptap/extension-placeholder";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import {
  Plus,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Bold,
  Italic,
  Strikethrough,
  Link,
  Undo2,
  Redo2,
  ImagePlus,
  Heading1,
  Heading2,
  Text,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Minus,
  Table,
  ChevronDown,
} from "lucide-react";
import { api, errorText, native } from "./api";
import { ru } from "./ru";
import type { Attachment } from "./types";
import AttachmentView from "./AttachmentView";
import { HighlightMark, HighlightTools } from "./Highlight";
import { externalUrl, openLink } from "./links";
import { importImage, clipboardFiles } from "./pasteImage";

function imageDropTarget(view: EditorView, x: number, y: number) {
  const coords = view.posAtCoords({ left: x, top: y });
  if (!coords) return null;
  const resolved = view.state.doc.resolve(coords.pos);
  const pos = resolved.depth ? resolved.before(1) : coords.pos;
  const element = view.nodeDOM(pos) as HTMLElement | null;
  const bounds =
    element?.getBoundingClientRect() || view.dom.getBoundingClientRect();
  const canvas = view.dom.getBoundingClientRect();
  return {
    pos,
    layout: x < canvas.left + canvas.width / 2 ? "left" : "right",
    top: bounds.top,
    left: canvas.left,
    width: canvas.width,
  };
}

function attachmentNode(name: "image" | "attachment") {
  return Node.create({
    name,
    group: "block",
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        attachmentId: { default: "" },
        name: { default: "" },
        size: { default: 0 },
        mime: { default: "" },
        ...(name === "image"
          ? { widthPercent: { default: 100 }, layout: { default: "block" } }
          : {}),
      };
    },
    parseHTML() {
      return [];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        "div",
        mergeAttributes(HTMLAttributes, { "data-attachment": name }),
      ];
    },
    addNodeView() {
      return ReactNodeViewRenderer(AttachmentView, {
        attrs: ({ node }): Record<string, string> =>
          name === "image"
            ? {
                "data-image-layout": ["left", "right"].includes(
                  node.attrs.layout,
                )
                  ? node.attrs.layout
                  : "block",
                style: `width: ${Math.max(15, Math.min(100, Number(node.attrs.widthPercent) || 100))}%`,
              }
            : {},
      });
    },
  });
}
export function hasContent(doc: JSONContent): boolean {
  return (
    !!doc.text?.trim() ||
    doc.type === "image" ||
    doc.type === "attachment" ||
    doc.type === "table" ||
    doc.type === "horizontalRule" ||
    (doc.content?.some(hasContent) ?? false)
  );
}
export function wordCount(doc: JSONContent): number {
  return (
    (doc.text?.trim().split(/\s+/u).filter(Boolean).length || 0) +
    (doc.content?.reduce((n, c) => n + wordCount(c), 0) || 0)
  );
}
function blockInfo(editor: EditorType) {
  const { $from } = editor.state.selection;
  if ($from.depth < 1) return null;
  const pos = $from.before(1);
  return { pos, node: $from.node(1), index: $from.index(0) };
}
function moveBlock(editor: EditorType, direction: number) {
  if (!editor.isEditable) return;
  const b = blockInfo(editor);
  if (!b) return;
  const { doc, tr } = editor.state;
  const next = b.index + direction;
  if (next < 0 || next >= doc.childCount) return;
  const target =
    direction < 0
      ? b.pos - doc.child(next).nodeSize
      : b.pos + doc.child(next).nodeSize;
  tr.delete(b.pos, b.pos + b.node.nodeSize);
  tr.insert(target, b.node);
  tr.setSelection(
    TextSelection.near(
      tr.doc.resolve(Math.min(target + 1, tr.doc.content.size)),
    ),
  );
  editor.view.dispatch(closeHistory(tr).scrollIntoView());
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.view.focus();
}
type Props = {
  document: JSONContent;
  editable: boolean;
  onChange: (v: JSONContent) => void;
  onError: (e: string) => void;
  onImport: (task: Promise<void>) => void;
};
export default function JournalEditor({
  document,
  editable,
  onChange,
  onError,
  onImport,
}: Props) {
  const [pasting, setPasting] = useState(0);
  const [menu, setMenu] = useState(false),
    [slash, setSlash] = useState(false),
    [link, setLink] = useState<string | null>(null),
    [, redraw] = useState(0);
  const [dropCue, setDropCue] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const pasteSequence = useRef(0);
  const pasteFiles = (files: Blob[] | Promise<Blob[]>) => {
    const current = editor!;
    let bookmark = current.state.selection.getBookmark();
    const map = ({
      transaction,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      bookmark = bookmark.map(transaction.mapping);
    };
    current.on("transaction", map);
    setPasting((n) => n + 1);
    const task = (async () => {
      try {
        const attachments = [];
        for (const file of await files) {
          if (current.isDestroyed) return;
          attachments.push(
            await importImage(
              file,
              () => !current.isDestroyed && current.isEditable,
            ),
          );
        }
        if (current.isDestroyed || !current.isEditable || !attachments.length)
          return;
        const selection = bookmark.resolve(current.state.doc);
        current
          .chain()
          .command(({ tr }) => {
            closeHistory(tr);
            tr.setSelection(selection);
            return true;
          })
          .insertContent(
            attachments.map((a) => ({
              type: "image",
              attrs: {
                attachmentId: a.id,
                name: a.name,
                size: a.size,
                mime: a.mime,
              },
            })),
          )
          .run();
        current.view.dispatch(closeHistory(current.state.tr));
      } catch (e) {
        if (!current.isDestroyed) onError(errorText(e));
      } finally {
        current.off("transaction", map);
        if (!current.isDestroyed) setPasting((n) => n - 1);
      }
    })();
    onImport(task);
  };
  const editor = useEditor({
    extensions: [
      Extension.create({
        name: "blockMovement",
        addKeyboardShortcuts() {
          return {
            "Mod-Alt-ArrowUp": () => {
              moveBlock(this.editor, -1);
              return true;
            },
            "Mod-Alt-ArrowDown": () => {
              moveBlock(this.editor, 1);
              return true;
            },
          };
        },
      }),
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          HTMLAttributes: {
            target: "_blank",
            rel: "noopener noreferrer",
            tabindex: "0",
            title: ru.openLink,
          },
          autolink: false,
          defaultProtocol: "https",
          protocols: ["http", "https", "mailto"],
        },
      }),
      TaskList,
      HighlightMark,
      TaskItem.configure({
        nested: true,
        // The interactive node view needs this attribute too, not only HTML export.
        HTMLAttributes: { "data-type": "taskItem" },
        a11y: {
          checkboxLabel: (node) =>
            `${ru.checklistItem}: ${node.firstChild?.textContent || ru.checklistEmptyItem}`,
        },
      }),
      TableKit.configure({ table: { resizable: true } }),
      Placeholder.configure({ placeholder: ru.bodyPlaceholder }),
      attachmentNode("image"),
      attachmentNode("attachment"),
    ],
    content: document,
    editable,
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
    onSelectionUpdate: () => redraw((n) => n + 1),
    editorProps: {
      handleDOMEvents: {
        click: (view, event) => {
          const anchor = (event.target as Element).closest?.("a[href]");
          if (!anchor || !view.dom.contains(anchor) || event.button !== 0)
            return false;
          event.preventDefault();
          // A drag selection is for editing, not a request to follow the link.
          if (view.dom.ownerDocument.getSelection()?.isCollapsed !== false)
            void openLink(anchor.getAttribute("href")!).catch((e) =>
              onError(errorText(e)),
            );
          return true;
        },
        keydown: (view, event) => {
          if (
            native &&
            view.editable &&
            event.ctrlKey &&
            !event.shiftKey &&
            event.code === "KeyV"
          ) {
            const sequence = pasteSequence.current;
            pasteFiles(
              (async () => {
                await new Promise((resolve) => setTimeout(resolve, 80));
                if (sequence !== pasteSequence.current) return [];
                const files = await clipboardFiles();
                return sequence === pasteSequence.current ? files : [];
              })(),
            );
          }
          const anchor = event.target as HTMLElement;
          if (
            event.key !== "Enter" ||
            !anchor.matches("a[href]") ||
            !view.dom.contains(anchor)
          )
            return false;
          event.preventDefault();
          void openLink(anchor.getAttribute("href")!).catch((e) =>
            onError(errorText(e)),
          );
          return true;
        },
        dragover: (view, event) => {
          if (
            !view.editable ||
            !event.dataTransfer?.types.includes("application/x-not-image")
          )
            return false;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const target = imageDropTarget(view, event.clientX, event.clientY);
          setDropCue(
            target
              ? {
                  top: target.top,
                  left:
                    target.left +
                    (target.layout === "right" ? target.width / 2 : 0),
                  width: target.width / 2,
                }
              : null,
          );
          return true;
        },
        dragleave: (_view, event) => {
          if (
            !(event.currentTarget as HTMLElement).contains(
              event.relatedTarget as globalThis.Node | null,
            )
          )
            setDropCue(null);
          return false;
        },
        dragend: () => {
          setDropCue(null);
          return false;
        },
      },
      attributes: {
        class: "journal-prose",
        "aria-label": "Текст записи",
        role: "textbox",
        "aria-multiline": "true",
        spellcheck: "false",
      },
      handleKeyDown: (_view, event) => {
        if (
          event.key === "/" &&
          !event.ctrlKey &&
          !event.metaKey &&
          _view.state.selection.$from.parentOffset === 0 &&
          _view.state.selection.$from.parent.textContent === ""
        ) {
          setMenu(true);
          setSlash(true);
        }
        if (event.key === "Escape") {
          setMenu(false);
          setLink(null);
        }
        return false;
      },
      handlePaste: (_view, event) => {
        pasteSequence.current++;
        if (event.clipboardData?.files.length) {
          if (!_view.editable) return true;
          const files = Array.from(event.clipboardData.files);
          if (files.some((f) => !f.type.startsWith("image/"))) {
            onError(ru.pasteImagesOnly);
            return true;
          }
          if (files.length > 8) {
            onError("Вставляйте не больше 8 изображений за раз");
            return true;
          }
          pasteFiles(files);
          return true;
        }
        if (
          native &&
          _view.editable &&
          !event.clipboardData?.getData("text/plain") &&
          !event.clipboardData?.getData("text/html")
        ) {
          pasteFiles(clipboardFiles());
          return true;
        }
        return false;
      },
      handleDrop: (view, event) => {
        setDropCue(null);
        if (!view.editable) return false;
        const imageData = event.dataTransfer?.getData(
          "application/x-not-image",
        );
        if (imageData) {
          event.preventDefault();
          try {
            const { pos: from, id } = JSON.parse(imageData);
            if (
              !Number.isInteger(from) ||
              from < 0 ||
              from >= view.state.doc.content.size
            )
              return true;
            const node = view.state.doc.nodeAt(from);
            const target = imageDropTarget(view, event.clientX, event.clientY);
            if (
              !node ||
              node.type.name !== "image" ||
              node.attrs.attachmentId !== id ||
              !target
            )
              return true;
            const width = Number(node.attrs.widthPercent) || 100;
            const layout = width > 75 ? "block" : target.layout;
            const tr = closeHistory(view.state.tr);
            let to = target.pos;
            if (to === from)
              tr.setNodeMarkup(from, undefined, { ...node.attrs, layout });
            else {
              tr.delete(from, from + node.nodeSize);
              if (to > from) to -= node.nodeSize;
              tr.insert(to, node.type.create({ ...node.attrs, layout }));
            }
            const after = to + node.nodeSize;
            if (tr.doc.nodeAt(after)?.type.name !== "paragraph")
              tr.insert(after, view.state.schema.nodes.paragraph.create());
            tr.setSelection(NodeSelection.create(tr.doc, to));
            view.dispatch(tr.scrollIntoView());
            view.dispatch(closeHistory(view.state.tr));
            view.focus();
          } catch {
            /* Ignore malformed or cross-document drags. */
          }
          return true;
        }
        const position = event.dataTransfer?.getData("application/x-not-block");
        if (!position) return false;
        event.preventDefault();
        const from = Number(position);
        const node = view.state.doc.nodeAt(from);
        const coords = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (!node || !coords) return true;
        const $to = view.state.doc.resolve(coords.pos);
        let to = $to.depth ? $to.before(1) : coords.pos;
        if (to >= from && to <= from + node.nodeSize) return true;
        const tr = view.state.tr.delete(from, from + node.nodeSize);
        if (to > from) to -= node.nodeSize;
        tr.insert(to, node);
        view.dispatch(closeHistory(tr).scrollIntoView());
        view.dispatch(closeHistory(view.state.tr));
        return true;
      },
    },
  });
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  if (!editor) return null;
  const prepare = () => {
    if (slash) {
      const { from } = editor.state.selection;
      if (editor.state.doc.textBetween(Math.max(0, from - 1), from) === "/")
        editor
          .chain()
          .focus()
          .deleteRange({ from: from - 1, to: from })
          .run();
    }
    setSlash(false);
    setMenu(false);
  };
  const run = (fn: (e: EditorType) => void) => {
    prepare();
    fn(editor);
  };
  const addFile = async () => {
    prepare();
    try {
      const a: Attachment | null = await api("addAttachment", {});
      if (a && !editor.isDestroyed)
        editor
          .chain()
          .focus()
          .insertContent({
            type: a.mime.startsWith("image/") ? "image" : "attachment",
            attrs: {
              attachmentId: a.id,
              name: a.name,
              size: a.size,
              mime: a.mime,
            },
          })
          .run();
    } catch (e) {
      onError(errorText(e));
    }
  };
  const blocks = [
    {
      label: ru.text,
      icon: Text,
      action: (e: EditorType) => e.chain().focus().setParagraph().run(),
    },
    {
      label: ru.heading1,
      icon: Heading1,
      action: (e: EditorType) =>
        e.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: ru.heading2,
      icon: Heading2,
      action: (e: EditorType) =>
        e.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: ru.bullet,
      icon: List,
      action: (e: EditorType) => e.chain().focus().toggleBulletList().run(),
    },
    {
      label: ru.ordered,
      icon: ListOrdered,
      action: (e: EditorType) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      label: ru.checklist,
      icon: ListChecks,
      action: (e: EditorType) => e.chain().focus().toggleTaskList().run(),
    },
    {
      label: ru.quote,
      icon: Quote,
      action: (e: EditorType) => e.chain().focus().toggleBlockquote().run(),
    },
    {
      label: ru.divider,
      icon: Minus,
      action: (e: EditorType) => e.chain().focus().setHorizontalRule().run(),
    },
    {
      label: ru.table,
      icon: Table,
      action: (e: EditorType) =>
        e
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
  ];
  return (
    <div className="editor-shell">
      {pasting > 0 && (
        <div className="paste-status" role="status">
          {ru.imagePasting}
        </div>
      )}
      {dropCue && (
        <div
          className="image-drop-cue"
          style={{ ...dropCue, height: 56 }}
          aria-hidden="true"
        />
      )}
      {editable && (
        <div
          className="editor-tools"
          role="toolbar"
          aria-label="Инструменты записи"
        >
          <div className="tool-group">
            <button
              className={menu ? "active" : ""}
              aria-expanded={menu}
              title={ru.blockMenu}
              aria-label={ru.blockMenu}
              onClick={() => {
                setSlash(false);
                setMenu(!menu);
              }}
            >
              <Plus size={17} />
              <ChevronDown size={11} />
            </button>
            <button
              draggable
              title={ru.drag}
              aria-label={ru.drag}
              onDragStart={(e) => {
                const b = blockInfo(editor);
                if (b)
                  e.dataTransfer.setData(
                    "application/x-not-block",
                    String(b.pos),
                  );
              }}
            >
              <GripVertical size={17} />
            </button>
            <button
              title={ru.moveUp}
              aria-label={ru.moveUp}
              onClick={() => moveBlock(editor, -1)}
            >
              <ArrowUp size={16} />
            </button>
            <button
              title={ru.moveDown}
              aria-label={ru.moveDown}
              onClick={() => moveBlock(editor, 1)}
            >
              <ArrowDown size={16} />
            </button>
          </div>
          <span className="tool-separator" />
          <div className="tool-group">
            <button
              className={editor.isActive("taskList") ? "active" : ""}
              title={ru.checklist}
              aria-label={ru.checklist}
              aria-pressed={editor.isActive("taskList")}
              onClick={() =>
                run((e) => e.chain().focus().toggleTaskList().run())
              }
            >
              <ListChecks size={17} />
            </button>
            <button
              className={editor.isActive("bold") ? "active" : ""}
              title={ru.bold}
              aria-label={ru.bold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              <Bold size={16} />
            </button>
            <button
              className={editor.isActive("italic") ? "active" : ""}
              title={ru.italic}
              aria-label={ru.italic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              <Italic size={16} />
            </button>
            <button
              className={editor.isActive("strike") ? "active" : ""}
              title={ru.strike}
              aria-label={ru.strike}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            >
              <Strikethrough size={16} />
            </button>
            <HighlightTools editor={editor} />
            <button
              title={ru.link}
              aria-label={ru.link}
              onClick={() => setLink(editor.getAttributes("link").href || "")}
            >
              <Link size={16} />
            </button>
          </div>
          <span className="tool-separator" />
          <div className="tool-group">
            <button
              title={ru.addFile}
              aria-label={ru.addFile}
              onClick={() => void addFile()}
            >
              <ImagePlus size={17} />
            </button>
            <button
              title={ru.undo}
              aria-label={ru.undo}
              onClick={() => editor.chain().focus().undo().run()}
            >
              <Undo2 size={16} />
            </button>
            <button
              title={ru.redo}
              aria-label={ru.redo}
              onClick={() => editor.chain().focus().redo().run()}
            >
              <Redo2 size={16} />
            </button>
          </div>
          {menu && (
            <div
              className="block-menu glass"
              role="menu"
              aria-label={ru.blockMenu}
            >
              {blocks.map((b) => (
                <button
                  role="menuitem"
                  key={b.label}
                  onClick={() => run(b.action)}
                >
                  <b.icon size={17} />
                  {b.label}
                </button>
              ))}
              <button role="menuitem" onClick={() => void addFile()}>
                <ImagePlus size={17} />
                {ru.addFile}
              </button>
            </div>
          )}
          {link !== null && (
            <form
              className="link-menu glass"
              onSubmit={(e) => {
                e.preventDefault();
                let href: string;
                try {
                  href = externalUrl(link);
                } catch {
                  onError(ru.invalidLink);
                  return;
                }
                editor
                  .chain()
                  .focus()
                  .extendMarkRange("link")
                  .setLink({ href })
                  .run();
                setLink(null);
              }}
            >
              <input
                aria-label={ru.link}
                placeholder={ru.linkPlaceholder}
                value={link}
                onChange={(e) => setLink(e.target.value)}
                autoFocus
              />
              <button type="submit">{ru.apply}</button>
              <button type="button" onClick={() => setLink(null)}>
                ×
              </button>
            </form>
          )}
        </div>
      )}
      {editable && editor.isActive("table") && (
        <div className="table-tools">
          <button onClick={() => editor.chain().focus().addRowAfter().run()}>
            {ru.addRow}
          </button>
          <button onClick={() => editor.chain().focus().addColumnAfter().run()}>
            {ru.addColumn}
          </button>
          <button onClick={() => editor.chain().focus().deleteTable().run()}>
            {ru.deleteTable}
          </button>
        </div>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
