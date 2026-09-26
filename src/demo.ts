// Development-only, opt-in preview. No persistence, encryption claims, or production fallback.
import type { Commands, Entry, Preferences, Summary } from "./types";
import { localDate } from "./api";
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
