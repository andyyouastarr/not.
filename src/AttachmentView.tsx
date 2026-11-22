import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { File, Download, ImagePlus } from "lucide-react";
import { api, errorText } from "./api";
import { ru } from "./ru";
import { imageWidth, applyImageGeometry } from "./imageInteraction";

type Layout = "block" | "left" | "right";

export default function AttachmentView({
  node,
  selected,
  editor,
  getPos,
}: NodeViewProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    width: number;
    container: number;
    sign: number;
    value: number;
    pointer: number;
    handle: HTMLButtonElement;
  } | null>(null);
  const image = node.type.name === "image";
  const width = imageWidth(node.attrs.widthPercent);
  const minimum = () =>
    Math.min(100, 3200 / Math.max(1, editor.view.dom.clientWidth));
  const clamp = (value: number) => Math.max(minimum(), Math.min(100, value));
  const layout: Layout = ["left", "right"].includes(node.attrs.layout)
    ? node.attrs.layout
    : "block";

  useEffect(() => {
    let live = true;
    let objectUrl = "";
    setUrl("");
    setError("");
    if (image)
      void api("readAttachment", { id: node.attrs.attachmentId })
        .then(({ data, mime }) => {
          if (!live) return;
          const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
          bytes.fill(0);
          setUrl(objectUrl);
        })
        .catch((e) => {
          if (live) setError(errorText(e));
        });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [node.attrs.attachmentId, image]);

  useLayoutEffect(() => {
    const outer = frame.current?.closest<HTMLElement>(".node-image");
    if (!outer) return;
    const update = () =>
      applyImageGeometry(
        outer,
        previewWidth ?? width,
        previewWidth !== null && layout === "block" ? "left" : layout,
        editor.view.dom.clientWidth,
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(editor.view.dom);
    return () => observer.disconnect();
  }, [previewWidth, width, layout, editor]);

  useEffect(() => {
    const cancel = () => {
      const current = drag.current;
      drag.current = null;
      if (current?.handle.hasPointerCapture(current.pointer))
        current.handle.releasePointerCapture(current.pointer);
      setPreviewWidth(null);
    };
    const key = (event: globalThis.KeyboardEvent) => {
      if (drag.current && event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    const transaction = ({
      transaction,
    }: {
      transaction: import("@tiptap/pm/state").Transaction;
    }) => {
      if (transaction.docChanged && drag.current) cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    editor.on("transaction", transaction);
    return () => {
      const current = drag.current;
      drag.current = null;
      if (current?.handle.hasPointerCapture(current.pointer))
        current.handle.releasePointerCapture(current.pointer);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      editor.off("transaction", transaction);
    };
  }, [editor]);
  useEffect(() => {
    if (!editor.isEditable) {
      drag.current = null;
      setPreviewWidth(null);
    }
  });

  const commit = (attrs: Record<string, unknown>) => {
    const pos = getPos();
    if (!editor.isEditable || editor.isDestroyed || typeof pos !== "number")
      return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current) return;
    const tr = closeHistory(editor.state.tr).setNodeMarkup(pos, undefined, {
      ...current.attrs,
      ...attrs,
    });
    editor.view.dispatch(tr);
    editor.view.dispatch(closeHistory(editor.state.tr));
  };
  const resize = (value: number) => {
    const next = clamp(value);
    const side = layout === "block" ? "left" : layout;
    if (next === width && side === layout) return;
    const pos = getPos();
    if (!editor.isEditable || editor.isDestroyed || typeof pos !== "number")
      return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "image") return;
    const tr = closeHistory(editor.state.tr).setNodeMarkup(pos, undefined, {
      ...current.attrs,
      widthPercent: next,
      layout: side,
    });
    const after = pos + current.nodeSize;
    if (tr.doc.nodeAt(after)?.type.name !== "paragraph")
      tr.insert(after, editor.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    editor.view.dispatch(tr);
    editor.view.dispatch(closeHistory(editor.state.tr));
  };
  const startResize = (
    event: PointerEvent<HTMLButtonElement>,
    sign: number,
  ) => {
    if (!editor.isEditable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const outer = frame.current?.closest<HTMLElement>(".node-image");
    if (!outer?.parentElement) return;
    drag.current = {
      x: event.clientX,
      width: outer.getBoundingClientRect().width,
      container: outer.parentElement.clientWidth,
      sign,
      value: width,
      pointer: event.pointerId,
      handle: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    current.value = clamp(
      ((current.width + (event.clientX - current.x) * current.sign) /
        current.container) *
        100,
    );
    setPreviewWidth(current.value);
  };
  const finishResize = (
    event: PointerEvent<HTMLButtonElement>,
    cancel = false,
  ) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancel) {
      resize(current.value);
      editor.view.focus();
    }
    setPreviewWidth(null);
  };
  const resizeKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) editor.commands.redo();
      else editor.commands.undo();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    resize(
      event.key === "Home"
        ? minimum()
        : event.key === "End"
          ? 100
          : width + (event.key === "ArrowLeft" ? -5 : 5),
    );
  };
  const replaceImage = async () => {
    setBusy(true);
    try {
      const a = await api("addAttachment", {});
      if (!a || editor.isDestroyed) return;
      if (!a.mime.startsWith("image/")) throw Error(ru.chooseImage);
      commit({ attachmentId: a.id, name: a.name, mime: a.mime, size: a.size });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <NodeViewWrapper
      className={`attachment-node ${selected ? "selected" : ""}`}
      contentEditable={false}
    >
      {image ? (
        <figure>
          <div ref={frame} className="image-frame">
            {url && !error ? (
              <img
                src={url}
                alt={node.attrs.name || ""}
                draggable={false}
                title={ru.imageDragHint}
                onError={() => setError(ru.imageDecodeError)}
              />
            ) : (
              <div
                className="image-placeholder"
                role={error ? "alert" : "status"}
              >
                <ImagePlus size={24} />
                <span>{error || ru.loading}</span>
              </div>
            )}
            {editor.isEditable && (
              <>
                {!error &&
                  url &&
                  [-1, 1].map((sign) => (
                    <button
                      key={sign}
                      className={`image-resize-handle ${sign < 0 ? "left" : "right"}`}
                      role="slider"
                      aria-label={
                        sign < 0 ? ru.imageResizeLeft : ru.imageResizeRight
                      }
                      aria-valuemin={minimum()}
                      aria-valuemax={100}
                      aria-valuenow={previewWidth ?? width}
                      aria-valuetext={`${previewWidth ?? width}%`}
                      title={ru.imageResizeHint}
                      onPointerDown={(e) => startResize(e, sign)}
                      onPointerMove={moveResize}
                      onPointerUp={(e) => finishResize(e)}
                      onPointerCancel={(e) => finishResize(e, true)}
                      onLostPointerCapture={() => {
                        drag.current = null;
                        setPreviewWidth(null);
                      }}
                      onKeyDown={resizeKey}
                    />
                  ))}
              </>
            )}
          </div>
          <figcaption>{node.attrs.name}</figcaption>
          {error && editor.isEditable && (
            <button
              className="image-repair"
              disabled={busy}
              onClick={() => void replaceImage()}
            >
              {ru.imageReplace}
            </button>
          )}
        </figure>
      ) : (
        <div className="file-card">
          <File size={23} />
          <div>
            <strong>{node.attrs.name}</strong>
            <small>{Math.ceil((node.attrs.size || 0) / 1024)} КБ</small>
          </div>
          <button
            title={ru.download}
            aria-label={ru.download}
            onClick={() =>
              void api("saveAttachment", { id: node.attrs.attachmentId }).catch(
                (e) => setError(errorText(e)),
              )
            }
          >
            <Download size={17} />
          </button>
          {error && <small role="alert">{error}</small>}
        </div>
      )}
    </NodeViewWrapper>
  );
}
