import { Extension } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";

export const imageWidth = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(100, n) : 100;
};
export function applyImageGeometry(
  element: HTMLElement,
  width: number,
  side: string,
  canvas: number,
) {
  element.style.width = `${width}%`;
  element.dataset.imageLayout = side;
  element.dataset.wrapBelow = String(
    canvas - Math.max(Math.min(32, canvas), (canvas * width) / 100) - 22 < 180,
  );
}

type Preview = { from: number; to: number; side: string; dom: HTMLElement };
const key = new PluginKey<Preview | null>("imageInteraction");

function scrollParent(element: HTMLElement) {
  let parent = element.parentElement;
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
    parent = parent.parentElement;
  }
  return document.scrollingElement as HTMLElement;
}

// The document is untouched throughout a gesture. Only decorations change.
class ImageController {
  private drag: {
    from: number;
    pointer: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    active: boolean;
    side: string;
    to: number;
    source: HTMLElement;
    preview: HTMLElement;
    scroller: HTMLElement;
    scroll: number;
    boundaries: { pos: number; mid: number }[];
    valid: boolean;
    edge: number;
    edgeSince: number;
    lastFrame: number;
  } | null = null;
  private frame = 0;
  private suppressClick = false;
  constructor(private view: EditorView) {
    view.dom.addEventListener("pointerdown", this.down, true);
    view.dom.addEventListener("click", this.click, true);
    window.addEventListener("pointermove", this.move, true);
    window.addEventListener("pointerup", this.up, true);
    window.addEventListener("pointercancel", this.cancel);
    view.dom.addEventListener("lostpointercapture", this.cancel);
    window.addEventListener("blur", this.cancel);
    window.addEventListener("keydown", this.keyboard, true);
  }
  private click = (event: MouseEvent) => {
    if (this.suppressClick) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.suppressClick = false;
    }
  };
  private down = (event: PointerEvent) => {
    this.suppressClick = false;
    if (!this.view.editable || event.button !== 0 || this.drag) return;
    const img = (event.target as Element).closest(".node-image img");
    const source = img?.closest<HTMLElement>(".node-image");
    if (!source || !this.view.dom.contains(source)) return;
    let from = -1;
    this.view.state.doc.descendants((node, pos) => {
      if (node.type.name === "image" && this.view.nodeDOM(pos) === source)
        from = pos;
    });
    if (from < 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.view.focus();
    this.view.dispatch(
      this.view.state.tr.setSelection(
        NodeSelection.create(this.view.state.doc, from),
      ),
    );
    const scroller = scrollParent(this.view.dom);
    const boundaries: { pos: number; mid: number }[] = [];
    this.view.state.doc.forEach((node, pos) => {
      if (pos === from) return;
      const el = this.view.nodeDOM(pos) as HTMLElement | null;
      if (el?.getBoundingClientRect) {
        const box = el.getBoundingClientRect();
        boundaries.push({ pos, mid: box.top + box.height / 2 });
      }
    });
    const preview = source.cloneNode(true) as HTMLElement;
    preview.className = "node-image image-preview";
    preview.removeAttribute("style");
    preview
      .querySelectorAll("button,[id]")
      .forEach((el) =>
        el.tagName === "BUTTON" ? el.remove() : el.removeAttribute("id"),
      );
    preview.contentEditable = "false";
    preview.setAttribute("aria-hidden", "true");
    this.drag = {
      from,
      pointer: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
      side:
        this.view.state.doc.nodeAt(from)!.attrs.layout === "right"
          ? "right"
          : "left",
      to: from,
      source,
      preview,
      scroller,
      scroll: scroller.scrollTop,
      boundaries,
      valid: true,
      edge: 0,
      edgeSince: 0,
      lastFrame: 0,
    };
    this.view.dom.setPointerCapture(event.pointerId);
  };
  private move = (event: PointerEvent) => {
    const d = this.drag;
    if (!d || d.pointer !== event.pointerId) return;
    d.x = event.clientX;
    d.y = event.clientY;
    if (!d.active && Math.hypot(d.x - d.startX, d.y - d.startY) < 6) return;
    event.preventDefault();
    d.active = true;
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  };
  private updateTarget() {
    const d = this.drag;
    if (!d) return;
    const box = this.view.dom.getBoundingClientRect();
    const scrollBox = d.scroller.getBoundingClientRect();
    const hit = document.elementFromPoint(d.x, d.y);
    d.valid =
      d.x >= box.left &&
      d.x <= box.right &&
      d.y >= Math.max(box.top, scrollBox.top) &&
      d.y <= Math.min(box.bottom, scrollBox.bottom) &&
      !!hit &&
      this.view.dom.contains(hit);
    if (!d.valid) {
      this.preview(null);
      return;
    }
    const middle = box.left + box.width / 2;
    if (d.x < middle - 12) d.side = "left";
    if (d.x > middle + 12) d.side = "right";
    // Freeze neutral-layout boundaries during a gesture: reflow itself must not change the target.
    const y = d.y + d.scroller.scrollTop - d.scroll;
    d.to =
      d.boundaries.find((b) => y < b.mid)?.pos ??
      this.view.state.doc.content.size;
    const node = this.view.state.doc.nodeAt(d.from)!;
    applyImageGeometry(
      d.preview,
      imageWidth(node.attrs.widthPercent),
      d.side,
      box.width,
    );
    this.preview({ from: d.from, to: d.to, side: d.side, dom: d.preview });
  }
  private preview(value: Preview | null) {
    const old = key.getState(this.view.state);
    if (!value && !old) return;
    if (value && old?.to === value.to && old.side === value.side) return;
    this.view.dispatch(
      this.view.state.tr.setMeta(key, value).setMeta("addToHistory", false),
    );
  }
  private tick = (time: number) => {
    this.frame = 0;
    const d = this.drag;
    if (!d?.active) return;
    if (!this.view.editable || !this.view.dom.getClientRects().length) {
      this.cancel();
      return;
    }
    this.updateTarget();
    const box = d.scroller.getBoundingClientRect();
    const insideX = d.x >= box.left && d.x <= box.right;
    const direction =
      insideX && d.y >= box.top && d.y <= box.bottom
        ? d.y < box.top + 40
          ? -1
          : d.y > box.bottom - 40
            ? 1
            : 0
        : 0;
    if (direction !== d.edge) {
      d.edge = direction;
      d.edgeSince = time;
    }
    if (direction && time - d.edgeSince >= 350) {
      const depth =
        direction < 0
          ? (box.top + 40 - d.y) / 40
          : (d.y - box.bottom + 40) / 40;
      const before = d.scroller.scrollTop;
      d.scroller.scrollTop +=
        (direction *
          Math.min(1, depth) *
          600 *
          Math.min(32, time - (d.lastFrame || time))) /
        1000;
      if (before !== d.scroller.scrollTop) this.updateTarget();
    }
    d.lastFrame = time;
    this.frame = requestAnimationFrame(this.tick);
  };
  private up = (event: PointerEvent) => {
    const d = this.drag;
    if (!d || event.pointerId !== d.pointer) return;
    if (d.active) {
      d.x = event.clientX;
      d.y = event.clientY;
      this.updateTarget();
    }
    const node = this.view.state.doc.nodeAt(d.from);
    this.cleanup();
    if (!d.active) return;
    this.suppressClick = true;
    event.preventDefault();
    if (!d.valid || !node || !this.view.editable) return;
    if (
      (d.to === d.from || d.to === d.from + node.nodeSize) &&
      node.attrs.layout === d.side
    )
      return;
    const tr = closeHistory(this.view.state.tr);
    tr.delete(d.from, d.from + node.nodeSize);
    const to = tr.mapping.map(d.to, -1);
    tr.insert(to, node.type.create({ ...node.attrs, layout: d.side }));
    const after = to + node.nodeSize;
    if (after === tr.doc.content.size)
      tr.insert(after, this.view.state.schema.nodes.paragraph.create());
    tr.setSelection(NodeSelection.create(tr.doc, to));
    this.view.dispatch(tr);
    this.view.dispatch(closeHistory(this.view.state.tr));
    this.view.focus();
  };
  private keyboard = (event: KeyboardEvent) => {
    if (this.drag && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.cancel();
    }
  };
  private cancel = () => this.cleanup();
  private cleanup() {
    const d = this.drag;
    this.drag = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (d && this.view.dom.hasPointerCapture(d.pointer))
      this.view.dom.releasePointerCapture(d.pointer);
    this.preview(null);
  }
  update(view: EditorView, previous: import("@tiptap/pm/state").EditorState) {
    // Async paste or another edit invalidates the captured neutral geometry; cancel safely.
    if (this.drag && (!view.editable || previous.doc !== view.state.doc))
      this.cancel();
  }
  destroy() {
    const d = this.drag;
    this.drag = null;
    cancelAnimationFrame(this.frame);
    if (d && this.view.dom.hasPointerCapture(d.pointer))
      this.view.dom.releasePointerCapture(d.pointer);
    this.view.dom.removeEventListener("pointerdown", this.down, true);
    this.view.dom.removeEventListener("click", this.click, true);
    window.removeEventListener("pointermove", this.move, true);
    window.removeEventListener("pointerup", this.up, true);
    window.removeEventListener("pointercancel", this.cancel);
    this.view.dom.removeEventListener("lostpointercapture", this.cancel);
    window.removeEventListener("blur", this.cancel);
    window.removeEventListener("keydown", this.keyboard, true);
  }
}

export const ImageInteraction = Extension.create({
  name: "imageInteraction",
  addProseMirrorPlugins() {
    return [
      new Plugin<Preview | null>({
        key,
        state: {
          init: () => null,
          apply: (tr, previous) =>
            tr.docChanged
              ? null
              : tr.getMeta(key) !== undefined
                ? tr.getMeta(key)
                : previous,
        },
        props: {
          decorations(state) {
            const p = key.getState(state);
            if (!p) return null;
            const node = state.doc.nodeAt(p.from);
            if (!node) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(p.from, p.from + node.nodeSize, {
                class: "image-drag-source",
                style: "display:none",
              }),
              Decoration.widget(p.to, () => p.dom, {
                side: -1,
                key: `image-preview-${p.to}-${p.side}`,
                ignoreSelection: true,
              }),
            ]);
          },
        },
        view: (view) => new ImageController(view),
      }),
    ];
  },
});
