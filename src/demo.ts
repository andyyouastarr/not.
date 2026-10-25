// Development-only, opt-in preview. No persistence, encryption claims, or production fallback.
import type { Commands, Entry, Preferences, Summary } from "./types";
import { localDate } from "./api";
import { assigneePreview } from "./planner/assigneeDemo";
import { preview } from "./planner/demo";
import type { TaskLink } from "./taskLinks";
let appearance: import("./types").AppearancePreferences = { theme: "dark" };
const taskLinks: TaskLink[] = [];
let preferences: Preferences = {
  opaque: false,
  lastEntry: "demo-1",
  recoveryConfirmed: true,
};
const paragraph = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const now = new Date().toISOString();
let entries: Entry[] = [
  {
    id: "demo-1",
    date: localDate(),
    title: "Замечать простые вещи",
    document: {
      type: "doc",
      content: [
        paragraph("Иногда лучший способ услышать себя — немного замедлиться."),
        paragraph(
          "Сегодня вышел на прогулку без наушников. Город оказался совсем другим: шаги по мокрому асфальту, разговоры за открытыми окнами, тихий шелест деревьев.",
        ),
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Хочу запомнить" }],
        },
        paragraph(
          "Свет в кофейне у окна. Неожиданную встречу. Ощущение, что мне никуда не нужно спешить.",
        ),
        {
          type: "blockquote",
          content: [
            paragraph(
              "Не каждый день должен быть особенным, чтобы в нём было что-то важное.",
            ),
          ],
        },
        paragraph(
          "Вечером оставить немного времени для книги. И, пожалуй, чаще выходить на такие прогулки.",
        ),
      ],
    },
    favorite: true,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  },
  ...[
    "Немного ясности",
    "Планы без спешки",
    "Разговор, который остался со мной",
    "Воскресенье для себя",
  ].map((title, i) => ({
    id: `demo-${i + 2}`,
    title,
    date: localDate(new Date(Date.now() - (i + 1) * 86400000)),
    document: {
      type: "doc",
      content: [paragraph("Маленькие моменты, к которым хочется вернуться.")],
    },
    favorite: i === 2,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  })),
];
const pastedImages = new Map<string, string>();
function text(v: Entry["document"]): string {
  return (v.text || "") + " " + (v.content || []).map(text).join(" ");
}
export async function mock<K extends keyof Commands>(
  type: K,
  args: Commands[K][0],
): Promise<Commands[K][1]> {
  const a = args as Record<string, unknown>;
  let result: unknown = true;
  switch (type) {
    case "appearance":
      result = appearance;
      break;
    case "setAppearance":
      appearance = (args as Commands["setAppearance"][0]).value;
      result = appearance;
      break;
    case "appearanceReady":
      result = true;
      break;
    case "taskLinks":
      result = taskLinks;
      break;
    case "createLinkedTask": {
      const { entry, fragment } = args as Commands["createLinkedTask"][0];
      let title = "";
      const walk = (node: Entry["document"]) => {
        if (
          node.marks?.some(
            (m) => m.type === "taskLink" && m.attrs?.fragmentId === fragment,
          )
        )
          title += node.text || "";
        node.content?.forEach(walk);
        if (node.content || node.type === "hardBreak") title += " ";
      };
      walk(entry.document);
      const oldDraft = preview().draft;
      const id = crypto.randomUUID();
      const board = preview({
        action: "save",
        draft: {
          id,
          title: title.replace(/\s+/gu, " ").trim(),
          document: { type: "doc", content: [{ type: "paragraph" }] },
          deadline: null,
          assigneeId: null,
          revision: 0,
        },
      });
      if (oldDraft) preview({ action: "draft", draft: oldDraft });
      const task = board.tasks.find((t) => t.id === id)!;
      taskLinks.push({
        entryId: entry.id,
        fragmentId: fragment,
        taskId: id,
        active: true,
      });
      result = { task, entry: await mock("save", { entry }) };
      break;
    }
    case "undoLinkedTask": {
      const { entry, fragment, revision } =
        args as Commands["undoLinkedTask"][0];
      const link = taskLinks.find((l) => l.fragmentId === fragment)!;
      preview({
        action: "flag",
        id: link.taskId,
        revision,
        field: "deleted",
        value: true,
      });
      taskLinks.splice(taskLinks.indexOf(link), 1);
      result = await mock("save", { entry });
      break;
    }
    case "assignees":
      result = assigneePreview();
      break;
    case "assigneeChange":
      result = assigneePreview((args as Commands["assigneeChange"][0]).change);
      break;
    case "planner":
      result = preview();
      break;
    case "plannerChange":
      result = preview((args as Commands["plannerChange"][0]).change);
      break;
    case "status":
      result = { exists: true, unlocked: true };
      break;
    case "settings":
      result = preferences;
      break;
    case "setSettings":
      preferences = a.value as Preferences;
      break;
    case "list":
      result = entries
        .filter(
          (e) =>
            e.deleted === (a.filter === "trash") &&
            (a.filter !== "favorites" || e.favorite) &&
            (!a.date || e.date === a.date) &&
            (!a.query ||
              (e.title + text(e.document))
                .toLowerCase()
                .includes(String(a.query).toLowerCase())),
        )
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(Number(a.offset), Number(a.offset) + 60)
        .map(
          (e) =>
            ({
              ...e,
              excerpt: text(e.document).trim().slice(0, 160),
            }) satisfies Summary,
        );
      break;
    case "get": {
      result = entries.find((e) => e.id === a.id);
      if (!result) throw Error("Запись не найдена");
      break;
    }
    case "save": {
      const e = a.entry as Entry;
      const old = entries.find((v) => v.id === e.id);
      result = {
        ...old,
        ...e,
        favorite: old?.favorite ?? false,
        deleted: false,
        createdAt: old?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        revision: (old?.revision || 0) + 1,
      };
      entries = [...entries.filter((v) => v.id !== e.id), result as Entry];
      const marked = (node: Entry["document"], id: string): boolean =>
        !!node.marks?.some(
          (m) => m.type === "taskLink" && m.attrs?.fragmentId === id,
        ) || !!node.content?.some((n) => marked(n, id));
      taskLinks
        .filter((l) => l.entryId === e.id)
        .forEach((l) => {
          l.active = marked(e.document, l.fragmentId);
        });
      break;
    }
    case "toggle":
      entries = entries.map((e) =>
        e.id === a.id
          ? { ...e, [a.field as string]: a.value, revision: e.revision + 1 }
          : e,
      );
      break;
    case "addAttachment":
    case "backup":
    case "restore":
    case "export":
      result = null;
      break;
    case "readAttachment":
      if (pastedImages.has(String(a.id))) {
        result = { data: pastedImages.get(String(a.id)), mime: "image/png" };
        break;
      }
      throw Error("Нет файла");
    case "addPastedImage": {
      const id = crypto.randomUUID();
      pastedImages.set(id, String(a.data));
      result = {
        id,
        name: "Вставленное изображение.png",
        mime: "image/png",
        size: atob(String(a.data)).length,
      };
      break;
    }
  }
  return structuredClone(result) as Commands[K][1];
}
