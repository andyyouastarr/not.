import { Mark } from "@tiptap/core";
import type { Editor, JSONContent } from "@tiptap/react";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { RemoveMarkStep, ReplaceStep } from "@tiptap/pm/transform";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
export interface TaskLink {
  fragmentId: string;
  entryId: string;
  taskId: string;
  active: boolean;
}
export interface LinkDisplay extends TaskLink {
  title: string;
  completed: boolean;
  status: string;
}
export interface DiaryLinkActions {
  links: LinkDisplay[];
  create: (editor: Editor, from: number, to: number) => Promise<void>;
  open: (fragment: string) => void;
}
export const normalizeTitle = (text: string) =>
  text.replace(/[\s\u0085]+/gu, " ").trim();
export function regions(doc: PMNode) {
  const result = new Map<string, { from: number; to: number }>();
  doc.descendants((node, pos) => {
    for (const mark of node.marks)
      if (mark.type.name === "taskLink") {
        const id = String(mark.attrs.fragmentId),
          previous = result.get(id);
        result.set(id, {
          from: previous?.from ?? pos,
          to: pos + node.nodeSize,
        });
      }
  });
  return result;
}
export function selectedLinks(doc: PMNode, from: number, to: number) {
  const ids = new Set<string>();
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText && pos < to && pos + node.nodeSize > from)
      node.marks.forEach((m) => {
        if (m.type.name === "taskLink") ids.add(String(m.attrs.fragmentId));
      });
  });
  return [...ids];
}
function strip(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) =>
    nodes.push(
      node
        .copy(strip(node.content))
        .mark(node.marks.filter((m) => m.type.name !== "taskLink")),
    ),
  );
  return Fragment.fromArray(nodes);
}
export const linkPluginKey = new PluginKey("diaryTaskLinks");
export function taskLinkExtension(options: {
  actions: () => DiaryLinkActions | undefined;
  confirm: (transaction: Transaction, count: number) => void;
}) {
  return Mark.create({
    name: "taskLink",
    inclusive: false,
    keepOnSplit: false,
    addAttributes: () => ({ fragmentId: { default: null } }),
    // Clipboard HTML deliberately has no identifiers. Stored JSON retains them.
    parseHTML: () => [],
    renderHTML: () => ["span", {}, 0],
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: linkPluginKey,
          state: {
            init: () => new Set<string>(),
            apply: (tr, cancelled: Set<string>) => {
              const id = tr.getMeta("taskLinkCancelled") as string | undefined;
              return id ? new Set([...cancelled, id]) : cancelled;
            },
          },
          filterTransaction(tr, state) {
            if (!tr.docChanged || tr.getMeta("taskLinkApproved")) return true;
            const cancelled = linkPluginKey.getState(state) as Set<string>;
            tr.doc.descendants((node, pos) => {
              node.marks
                .filter(
                  (m) =>
                    m.type.name === "taskLink" &&
                    cancelled.has(String(m.attrs.fragmentId)),
                )
                .forEach((m) => tr.removeMark(pos, pos + node.nodeSize, m));
            });
            const originalSteps = [...tr.steps];
            const before = regions(state.doc);
            // insertText inherits stored marks. Replacing the entire source must
            // still break its identity, even when the replacement inherits it.
            const replacement = tr.steps.length === 1 ? tr.steps[0] : null;
            if (
              replacement instanceof ReplaceStep &&
              !isHistoryTransaction(tr)
            ) {
              for (const [id, range] of before) {
                if (replacement.from > range.from || replacement.to < range.to)
                  continue;
                tr.doc.descendants((node, pos) => {
                  node.marks
                    .filter(
                      (m) =>
                        m.type.name === "taskLink" && m.attrs.fragmentId === id,
                    )
                    .forEach((m) => tr.removeMark(pos, pos + node.nodeSize, m));
                });
              }
            }
            // "Clear formatting" may remove every mark. A task link is metadata,
            // so restore only the ranges explicitly affected by RemoveMarkStep.
            for (const [index, step] of (isHistoryTransaction(tr)
              ? []
              : originalSteps
            ).entries()) {
              if (
                !(step instanceof RemoveMarkStep) ||
                step.mark.type.name !== "taskLink" ||
                cancelled.has(String(step.mark.attrs.fragmentId))
              )
                continue;
              const mapping = tr.mapping.slice(index + 1);
              const from = mapping.map(step.from, 1),
                to = mapping.map(step.to, -1);
              if (from < to) tr.addMark(from, to, step.mark);
            }
            const after = regions(tr.doc);
            const removed = [...before.keys()].filter((id) => !after.has(id));
            if (!removed.length) return true;
            // Do not apply first: cancelling must preserve both document and selection.
            queueMicrotask(() => options.confirm(tr, removed.length));
            return false;
          },
          props: {
            transformCopied: (slice) =>
              new Slice(strip(slice.content), slice.openStart, slice.openEnd),
            transformPasted: (slice) =>
              new Slice(strip(slice.content), slice.openStart, slice.openEnd),
            decorations(state) {
              const actions = options.actions();
              if (!actions) return DecorationSet.empty;
              const widgets: Decoration[] = [];
              state.doc.descendants((node, pos) => {
                if (!node.isText) return;
                for (const mark of node.marks) {
                  if (mark.type.name === "taskLink")
                    widgets.push(
                      Decoration.inline(pos, pos + node.nodeSize, {
                        "data-task-fragment": String(mark.attrs.fragmentId),
                      }),
                    );
                }
              });
              for (const [id, range] of regions(state.doc)) {
                const link = actions.links.find((l) => l.fragmentId === id);
                if (!link) continue;
                widgets.push(
                  Decoration.widget(
                    range.to,
                    () => {
                      const button = document.createElement("button");
                      button.type = "button";
                      button.className = "task-link-icon";
                      button.dataset.fragment = id;
                      button.textContent = link.completed ? "✓" : "▣";
                      button.title = `${link.title} · ${link.status}`;
                      button.setAttribute(
                        "aria-label",
                        `Открыть задачу: ${button.title}`,
                      );
                      button.addEventListener("mousedown", (e) =>
                        e.preventDefault(),
                      );
                      button.addEventListener("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        options.actions()?.open(id);
                      });
                      return button;
                    },
                    {
                      side: -1,
                      key: `${id}:${link.title}:${link.status}`,
                      stopEvent: () => true,
                    },
                  ),
                );
              }
              return DecorationSet.create(state.doc, widgets);
            },
          },
        }),
      ];
    },
  });
}
export function markTransaction(
  editor: Editor,
  from: number,
  to: number,
  fragment: string,
  ranges = [{ from, to }],
) {
  const tr = editor.state.tr;
  for (const { from, to } of ranges)
    editor.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText)
        tr.addMark(
          Math.max(from, pos),
          Math.min(to, pos + node.nodeSize),
          editor.schema.marks.taskLink.create({ fragmentId: fragment }),
        );
    });
  return closeHistory(tr)
    .setMeta("addToHistory", false)
    .setMeta("taskLinkApproved", true);
}
export function removeLink(editor: Editor, fragment: string) {
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    node.marks
      .filter(
        (m) => m.type.name === "taskLink" && m.attrs.fragmentId === fragment,
      )
      .forEach((m) => tr.removeMark(pos, pos + node.nodeSize, m));
  });
  return tr
    .setMeta("taskLinkCancelled", fragment)
    .setMeta("addToHistory", false)
    .setMeta("taskLinkApproved", true);
}
export type LinkDocument = JSONContent;
