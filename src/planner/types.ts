import type { JSONContent } from "@tiptap/react";
export interface Stage {
  id: string;
  title: string;
  completed: boolean;
}
export interface Draft {
  id: string;
  title: string;
  document: JSONContent;
  deadline: string | null;
  revision: number;
}
export interface Task extends Draft {
  stageId: string | null;
  position: number;
  archived: boolean;
  deleted: boolean;
  updatedAt: string;
}
export interface Board {
  stages: Stage[];
  tasks: Task[];
  draft: Draft | null;
  revision: number;
}
export type Change =
  | { action: "save"; draft: Draft }
  | { action: "draft"; draft: Draft | null }
  | {
      action: "move";
      id: string;
      revision: number;
      stage: string | null;
      before: string | null;
    }
  | {
      action: "flag";
      id: string;
      revision: number;
      field: "archived" | "deleted";
      value: boolean;
    }
  | {
      action: "stages";
      stages: Stage[];
      revision: number;
      removed: string | null;
      destination: string | null;
    };
export const emptyDocument = () => ({
  type: "doc",
  content: [{ type: "paragraph" }],
});
export function newDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    title: "",
    document: emptyDocument(),
    deadline: null,
    revision: 0,
  };
}
export function excerpt(node: JSONContent): string {
  return [node.text || "", ...(node.content || []).map(excerpt)]
    .join(" ")
    .trim();
}
