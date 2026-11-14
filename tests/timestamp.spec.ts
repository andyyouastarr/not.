import { test, expect, type Page, type Locator } from "@playwright/test";
import os from "node:os";
import path from "node:path";

async function open(page: Page) {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  await dialog.getByLabel("Название задачи").fill("Timestamp test");
  return {
    dialog,
    editor: dialog.getByRole("textbox", { name: "Текст записи" }),
  };
}
async function insert(page: Page, editor: Locator) {
  await editor.dispatchEvent("keydown", { key: "F10", shiftKey: true });
  await editor.dispatchEvent("contextmenu", { button: 2 });
  const item = await page.evaluate(() => window.__notTaskMenu?.prepare());
  expect(item?.label).toBe("Timestamp разделитель");
  await page.evaluate(
    (token) => window.__notTaskMenu?.run(token!),
    item!.token,
  );
}
test("timestamp typing, deletion, undo, clipboard, tabs and saved reopen", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { dialog, editor } = await open(page);
  await editor.fill("До разделителя");
  await insert(page, editor);
  const node = editor.locator(".timestamp-divider");
  await expect(node).toHaveCount(1);
  const date = await node.getAttribute("data-timestamp-date");
  await expect(node).toHaveText(date!.split("-").reverse().join("."));
  await page.clock.setFixedTime(new Date(2030, 0, 2, 0, 1));
  await page.keyboard.type("After divider");
  await expect(editor.locator("p").last()).toHaveText("After divider");
  await editor.press("Home");
  await editor.press("Backspace");
  await expect(node).toHaveClass(/ProseMirror-selectednode/);
  await editor.press("Backspace");
  await expect(node).toHaveCount(0);
  await editor.press("Control+z");
  await expect(node).toHaveCount(1);
  expect(await node.getAttribute("data-timestamp-date")).toBe(date);
  // Tiptap's real clipboard serializer must include both semantic HTML and date text.
  const clip = await editor.evaluate((root) => {
    const e = (root as any).editor;
    const data = e.view.serializeForClipboard(e.state.selection.content());
    return { text: data.text, html: data.dom.innerHTML };
  });
  expect(clip.text).toContain(date!.split("-").reverse().join("."));
  expect(clip.html).toContain("data-timestamp-date");
  await dialog.getByRole("tab", { name: "История", exact: true }).click();
  expect(
    await page.evaluate(() => window.__notTaskMenu?.prepare() ?? null),
  ).toBeNull();
  await dialog.getByRole("tab", { name: "Новая задача", exact: true }).click();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.locator(".planner-card-open").click();
  await expect(node).toHaveAttribute("data-timestamp-date", date!);
  await page.screenshot({
    path: path.join(os.tmpdir(), "not-timestamp-dark.png"),
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await expect(node).toHaveCSS("color", "rgb(80, 81, 91)");
  await expect(
    dialog.getByRole("tab", { name: "Редактирование задачи" }),
  ).toHaveCSS("color", "rgb(17, 17, 19)");
  await page.screenshot({
    path: path.join(os.tmpdir(), "not-timestamp-light.png"),
  });
  await page.setViewportSize({ width: 720, height: 840 });
  await expect(node).toBeInViewport();
  expect(errors).toEqual([]);
});

test("tables, quotes, multi-block selection, paste and block movement preserve date", async ({
  page,
}) => {
  const { editor } = await open(page);
  for (const type of ["table", "blockquote"]) {
    await editor.evaluate((root, type) => {
      const p = {
        type: "paragraph",
        content: [{ type: "text", text: "Nested text" }],
      };
      const block =
        type === "table"
          ? {
              type,
              content: [
                {
                  type: "tableRow",
                  content: [{ type: "tableCell", content: [p] }],
                },
              ],
            }
          : { type, content: [p] };
      const e = (root as any).editor;
      e.commands.setContent({
        type: "doc",
        content: [block, { type: "paragraph" }],
      });
      e.commands.setTextSelection(type === "table" ? 5 : 2);
    }, type);
    await insert(page, editor);
    expect(
      await editor.evaluate((root) =>
        (root as any).editor.getJSON().content.map((n: any) => n.type),
      ),
    ).toEqual([type, "timestampDivider", "paragraph"]);
  }
  await editor.evaluate((root) => {
    const e = (root as any).editor;
    e.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "AAA" }] },
        { type: "paragraph", content: [{ type: "text", text: "BBB" }] },
        { type: "paragraph", content: [{ type: "text", text: "CCC" }] },
      ],
    });
    e.commands.setTextSelection({ from: 2, to: 8 });
  });
  await insert(page, editor);
  expect(
    await editor.evaluate((root) =>
      (root as any).editor.getJSON().content.map((n: any) => n.type),
    ),
  ).toEqual([
    "paragraph",
    "paragraph",
    "timestampDivider",
    "paragraph",
    "paragraph",
  ]);
  await expect(editor).toContainText("AAA");
  await expect(editor).toContainText("BBB");
  await editor.evaluate((root) =>
    (root as any).editor.commands.insertContent(
      '<div data-timestamp-date="2020-02-29"><time>29.02.2020</time><span></span></div><p></p>',
    ),
  );
  await expect(
    editor.locator('[data-timestamp-date="2020-02-29"]'),
  ).toHaveCount(1);
  await editor.evaluate((root) => {
    const e = (root as any).editor;
    let pos = 0;
    e.state.doc.descendants((n: any, p: number) => {
      if (n.type.name === "timestampDivider" && n.attrs.date === "2020-02-29")
        pos = p;
    });
    e.commands.setNodeSelection(pos);
  });
  await editor.press("Control+Alt+ArrowUp");
  await expect(
    editor.locator('[data-timestamp-date="2020-02-29"]'),
  ).toHaveCount(1);
});

test("outer blocks, selection, pointer position, empty paragraph reuse and expired menu", async ({
  page,
}) => {
  const { editor, dialog } = await open(page);
  await editor.evaluate((root) => {
    const e = (root as any).editor;
    e.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Nested" }],
                },
              ],
            },
          ],
        },
        { type: "paragraph" },
      ],
    });
    e.commands.setTextSelection(12);
  });
  await insert(page, editor);
  expect(
    await editor.evaluate((root) =>
      (root as any).editor.getJSON().content.map((n: any) => n.type),
    ),
  ).toEqual(["paragraph", "bulletList", "timestampDivider", "paragraph"]);
  await editor.press("Control+z");
  await expect(editor.locator(".timestamp-divider")).toHaveCount(0);
  await editor.press("Control+y");
  await expect(editor.locator(".timestamp-divider")).toHaveCount(1);
  // Pointer targets the first paragraph, although the caret is after the list.
  await editor.locator("p").first().click({ button: "right" });
  let item = await page.evaluate(() => window.__notTaskMenu?.prepare());
  await page.evaluate(
    (token) => window.__notTaskMenu?.run(token!),
    item!.token,
  );
  expect(
    await editor.evaluate(
      (root) => (root as any).editor.getJSON().content[1].type,
    ),
  ).toBe("timestampDivider");
  await dialog
    .getByLabel("Название задачи")
    .dispatchEvent("contextmenu", { button: 2 });
  expect(await page.evaluate(() => window.__notTaskMenu?.prepare())).toBeNull();
  await editor.dispatchEvent("keydown", { key: "F10", shiftKey: true });
  await editor.dispatchEvent("contextmenu", { button: 2 });
  item = await page.evaluate(() => window.__notTaskMenu?.prepare());
  await dialog.getByRole("tab", { name: "История", exact: true }).click();
  await page.evaluate(
    (token) => window.__notTaskMenu?.run(token!),
    item!.token,
  );
  await dialog.getByRole("tab", { name: "Новая задача", exact: true }).click();
  await expect(editor.locator(".timestamp-divider")).toHaveCount(2);
});
