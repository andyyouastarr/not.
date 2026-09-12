import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent, KeyboardEvent } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { File, Download, ImagePlus } from "lucide-react";
import { api, errorText } from "./api";
import { ru } from "./ru";

type Layout = "block" | "left" | "right";
const clamp = (value: number) => Math.max(15, Math.min(100, Math.round(value)));

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
  } | null>(null);
  const image = node.type.name === "image";
  const width = clamp(Number(node.attrs.widthPercent) || 100);
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
    if (outer) {
      outer.style.width = `${previewWidth ?? width}%`;
      outer.dataset.imageLayout =
        previewWidth === null
          ? layout
          : previewWidth > 75
            ? "block"
            : layout === "right"
              ? "right"
              : "left";
    }
  }, [previewWidth, width, layout]);

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
  const writeBeside = () => {
    const pos = getPos();
    if (!editor.isEditable || typeof pos !== "number") return;
    const current = editor.state.doc.nodeAt(pos);
    if (!current) return;
    const after = pos + current.nodeSize;
    const tr = editor.state.tr;
    if (tr.doc.nodeAt(after)?.type.name !== "paragraph")
      tr.insert(after, editor.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    editor.view.dispatch(tr.scrollIntoView());
    editor.view.focus();
  };
  const resize = (value: number) => {
    const next = clamp(value);
    commit({
      widthPercent: next,
      layout: next > 75 ? "block" : layout === "right" ? "right" : "left",
    });
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
      writeBeside();
    }
    setPreviewWidth(null);
  };
  const resizeKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    resize(
      event.key === "Home"
        ? 15
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
                draggable={editor.isEditable}
                title={ru.imageDragHint}
                onDragStart={(event) => {
                  const pos = getPos();
                  if (!editor.isEditable || typeof pos !== "number") {
                    event.preventDefault();
                    return;
                  }
                  event.stopPropagation();
                  event.dataTransfer.clearData();
                  event.dataTransfer.setData(
                    "application/x-not-image",
                    JSON.stringify({ pos, id: node.attrs.attachmentId }),
                  );
                  event.dataTransfer.effectAllowed = "move";
                }}
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
                      aria-valuemin={15}
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
