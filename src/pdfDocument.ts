import type { JSONContent } from "@tiptap/core";
import "./pdf.css";

export interface PdfExportSnapshot {
  kind: "diary" | "task";
  title: string;
  metadata: string[];
  document: JSONContent;
}
export type PdfAttachmentLoader = (
  id: string,
) => Promise<{ url: string; dispose?: () => void }>;

export const PDF_CONTENT_WIDTH = (174 * 96) / 25.4;
export const PDF_CONTENT_HEIGHT = (261 * 96) / 25.4;
const nodes = new Set([
  "doc",
  "text",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "blockquote",
  "codeBlock",
  "hardBreak",
  "horizontalRule",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "image",
  "attachment",
  "timestampDivider",
]);
const marks = new Set([
  "bold",
  "italic",
  "strike",
  "underline",
  "code",
  "link",
  "highlight",
  "taskLink",
]);

/** Refuse unknown content rather than silently producing an incomplete PDF. */
export function validatePdfDocument(node: JSONContent, depth = 0): void {
  if (depth > 100 || !node.type || !nodes.has(node.type))
    throw Error("PDF: неподдерживаемый элемент документа");
  if (node.type === "timestampDivider") {
    const date = String(node.attrs?.date ?? "");
    const value = new Date(`${date}T12:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(+value) ||
      value.toISOString().slice(0, 10) !== date
    )
      throw Error("PDF: неверная дата разделителя");
  }
  if (["image", "attachment"].includes(node.type) && !node.attrs?.attachmentId)
    throw Error("PDF: отсутствует идентификатор вложения");
  for (const mark of node.marks ?? [])
    if (!marks.has(mark.type))
      throw Error("PDF: неподдерживаемое форматирование");
  for (const child of node.content ?? []) validatePdfDocument(child, depth + 1);
}

export function pdfImageWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(100, value)
    : 100;
}

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
};

function render(node: JSONContent): Node {
  const attrs = node.attrs ?? {};
  if (node.type === "text") {
    let text: Node = document.createTextNode(node.text ?? "");
    const tags: Record<string, keyof HTMLElementTagNameMap> = {
      bold: "strong",
      italic: "em",
      strike: "s",
      underline: "u",
      code: "code",
      link: "a",
      highlight: "mark",
    };
    for (const mark of node.marks ?? []) {
      if (mark.type === "taskLink") continue;
      const wrapper = element(tags[mark.type]);
      if (mark.type === "link") {
        const href = String(mark.attrs?.href ?? "");
        // Never expose local files, script URLs, or internal app resources.
        if (
          /^(https?:\/\/|mailto:)/i.test(href) &&
          !/[\u0000-\u001f\u007f]/u.test(href)
        )
          wrapper.setAttribute("href", href);
      }
      if (mark.type === "highlight") {
        const color = String(mark.attrs?.color ?? "lavender");
        wrapper.dataset.highlight = [
          "lavender",
          "yellow",
          "green",
          "pink",
        ].includes(color)
          ? color
          : "lavender";
      }
      wrapper.append(text);
      text = wrapper;
    }
    return text;
  }
  if (node.type === "image") {
    const figure = element("figure");
    figure.dataset.pdfImage = String(attrs.attachmentId);
    figure.dataset.side = ["left", "right"].includes(attrs.layout)
      ? attrs.layout
      : "block";
    figure.style.width = `${pdfImageWidth(attrs.widthPercent)}%`;
    const img = element("img");
    img.alt = String(attrs.name ?? "");
    figure.append(img);
    if (attrs.name) figure.append(element("figcaption", String(attrs.name)));
    return figure;
  }
  if (node.type === "attachment") {
    const file = element(
      "p",
      `${String(attrs.name ?? "Файл")} · ${new Intl.NumberFormat("ru").format(Number(attrs.size) || 0)} Б`,
    );
    file.className = "pdf-file";
    return file;
  }
  if (node.type === "timestampDivider") {
    const divider = element("div");
    divider.className = "pdf-timestamp";
    const time = element(
      "time",
      String(attrs.date).split("-").reverse().join("."),
    );
    time.dateTime = attrs.date;
    divider.append(time, element("span"));
    return divider;
  }
  const tags: Record<string, keyof HTMLElementTagNameMap> = {
    doc: "div",
    paragraph: "p",
    bulletList: "ul",
    orderedList: "ol",
    listItem: "li",
    taskList: "ul",
    taskItem: "li",
    blockquote: "blockquote",
    codeBlock: "pre",
    hardBreak: "br",
    horizontalRule: "hr",
    table: "table",
    tableRow: "tr",
    tableCell: "td",
    tableHeader: "th",
  };
  const tag =
    node.type === "heading"
      ? (`h${Math.min(6, Math.max(1, Number(attrs.level) || 1))}` as keyof HTMLElementTagNameMap)
      : tags[node.type!];
  const result = element(tag);
  if (node.type === "doc") result.className = "pdf-body";
  if (node.type === "taskList") result.className = "pdf-checklist";
  if (node.type === "taskItem") {
    result.dataset.checked = String(!!attrs.checked);
    const check = element("span", attrs.checked ? "☑" : "☐");
    check.className = "pdf-check";
    result.append(check);
  }
  if (node.type === "orderedList")
    result.setAttribute("start", String(Number(attrs.start) || 1));
  if (["tableCell", "tableHeader"].includes(node.type!)) {
    result.setAttribute(
      "colspan",
      String(Math.max(1, Number(attrs.colspan) || 1)),
    );
    result.setAttribute(
      "rowspan",
      String(Math.max(1, Number(attrs.rowspan) || 1)),
    );
  }
  for (const child of node.content ?? []) result.append(render(child));
  if (node.type === "paragraph" && !node.content?.length)
    result.append(element("br"));
  if (node.type === "table") {
    const first = result.firstElementChild;
    if (first && [...first.children].every((cell) => cell.tagName === "TH")) {
      const head = element("thead");
      head.append(first);
      result.prepend(head);
    }
    const body = element("tbody");
    for (const row of [...result.children])
      if (row.tagName === "TR") body.append(row);
    result.append(body);
    // Preserve relative user-resized columns while fitting the fixed A4 canvas.
    const widths = (node.content?.[0]?.content ?? []).flatMap((cell) => {
      const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
      return Array.from({ length: span }, (_, index) => {
        const value = Number(cell.attrs?.colwidth?.[index]);
        return Number.isFinite(value) && value > 0 ? value : 100;
      });
    });
    if (widths.length) {
      const columns = element("colgroup");
      const total = widths.reduce((sum, width) => sum + width, 0);
      for (const width of widths) {
        const column = element("col");
        column.style.width = `${(width / total) * 100}%`;
        columns.append(column);
      }
      result.prepend(columns);
    }
  }
  return result;
}

function prepareBreaks(root: HTMLElement) {
  for (const figure of root.querySelectorAll<HTMLElement>(
    "figure[data-pdf-image]",
  )) {
    const image = figure.querySelector("img")!;
    const caption =
      figure.querySelector("figcaption")?.getBoundingClientRect().height ?? 0;
    const maxHeight = PDF_CONTENT_HEIGHT - caption - 36;
    if (image.getBoundingClientRect().height > maxHeight) {
      figure.style.width = `${(maxHeight * image.naturalWidth) / image.naturalHeight}px`;
    }
    if (
      PDF_CONTENT_WIDTH - figure.getBoundingClientRect().width - 18 <
      (45 * 96) / 25.4
    )
      figure.dataset.standalone = "true";
  }
  // Group only top-level floats and the blocks actually alongside them. A tall
  // paragraph is allowed to fragment; it must not force an unprintable group.
  const body = root.querySelector<HTMLElement>(".pdf-body")!;
  for (const figure of [...body.children]) {
    if (
      !(figure instanceof HTMLElement) ||
      figure.tagName !== "FIGURE" ||
      figure.dataset.side === "block" ||
      figure.dataset.standalone === "true"
    )
      continue;
    const bottom = figure.getBoundingClientRect().bottom;
    const group = element("div");
    group.className = "pdf-float-group";
    const siblings: Element[] = [];
    let next = figure.nextElementSibling;
    while (
      next &&
      !["FIGURE", "TABLE", "HR", "PRE"].includes(next.tagName) &&
      next.getBoundingClientRect().top < bottom
    ) {
      siblings.push(next);
      next = next.nextElementSibling;
    }
    figure.before(group);
    group.append(figure, ...siblings);
    if (group.getBoundingClientRect().height <= PDF_CONTENT_HEIGHT - 2)
      group.classList.add("pdf-keep");
  }
  for (const block of root.querySelectorAll<HTMLElement>("li, tr, blockquote"))
    if (block.getBoundingClientRect().height < PDF_CONTENT_HEIGHT - 2)
      block.classList.add("pdf-keep");
}

/** Mount beneath the active dialog (or body) so the native modal layer cannot hide it. */
export async function preparePdfDocument(
  snapshot: PdfExportSnapshot,
  loadAttachment: PdfAttachmentLoader,
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<{ element: HTMLElement; cleanup: () => void }> {
  validatePdfDocument(snapshot.document);
  const root = element("article");
  root.id = "not-pdf-document";
  root.dataset.kind = snapshot.kind;
  root.setAttribute("aria-hidden", "true");
  const disposers: (() => void)[] = [];
  const ancestors: HTMLElement[] = [];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    root.remove();
    for (const dispose of disposers.splice(0)) dispose();
    for (const ancestor of ancestors)
      ancestor.removeAttribute("data-pdf-ancestor");
    signal?.removeEventListener("abort", cleanup);
  };
  const check = () => {
    if (signal?.aborted)
      throw new DOMException("Экспорт отменён", "AbortError");
  };
  try {
    check();
    if (snapshot.title || snapshot.metadata.length) {
      const header = element("header");
      if (snapshot.title) header.append(element("h1", snapshot.title));
      for (const line of snapshot.metadata)
        if (line) header.append(element("p", line));
      root.append(header);
    }
    root.append(render(snapshot.document));
    host.append(root);
    for (
      let ancestor: HTMLElement | null = host;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      ancestors.push(ancestor);
      ancestor.setAttribute("data-pdf-ancestor", "true");
    }
    signal?.addEventListener("abort", cleanup, { once: true });
    // Sequential resolution bounds memory pressure while preserving document order.
    const resources = new Map<string, string>();
    for (const figure of root.querySelectorAll<HTMLElement>(
      "figure[data-pdf-image]",
    )) {
      check();
      const id = figure.dataset.pdfImage!;
      let url = resources.get(id);
      if (!url) {
        const attachment = await loadAttachment(id);
        if (signal?.aborted) {
          attachment.dispose?.();
          check();
        }
        if (attachment.dispose) disposers.push(attachment.dispose);
        url = attachment.url;
        if (!url.startsWith("blob:"))
          throw Error("PDF: недопустимый источник изображения");
        resources.set(id, url);
      }
      const image = figure.querySelector("img")!;
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || !image.naturalHeight)
        throw Error("PDF: изображение не загрузилось");
    }
    await document.fonts.ready;
    check();
    prepareBreaks(root);
    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await frame();
    const height = root.getBoundingClientRect().height;
    await frame();
    check();
    if (
      !Number.isFinite(height) ||
      Math.abs(root.getBoundingClientRect().height - height) > 0.5
    )
      throw Error("PDF: вёрстка ещё изменяется. Повторите экспорт");
    const bounds = root.getBoundingClientRect();
    for (const child of root.querySelectorAll<HTMLElement>("*")) {
      const rect = child.getBoundingClientRect();
      if (
        rect.width &&
        (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
      )
        throw Error("PDF: содержимое выходит за поля страницы");
    }
    return { element: root, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
