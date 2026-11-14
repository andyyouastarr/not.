import { test, expect } from "@playwright/test";

test("title typing does not update the description editor and preserves its undo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  const editor = dialog.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Описание до изменения названия");
  await editor.press("End");
  await page.keyboard.type("!");
  const title = dialog.getByLabel("Название задачи");
  await title.focus();
  await expect(dialog).toContainText("Черновик сохранён");
  await editor.evaluate((root) => {
    const e = (root as any).editor;
    (window as any).__titlePerf = { updates: 0, editor: e, doc: e.state.doc };
    const original = e.setOptions.bind(e);
    e.setOptions = (...args: any[]) => {
      (window as any).__titlePerf.updates++;
      return original(...args);
    };
  });
  await title.pressSequentially("New task title typed character by character", {
    delay: 20,
  });
  await expect(dialog).toContainText("Черновик сохранён");
  const result = await editor.evaluate((root) => {
    const p = (window as any).__titlePerf;
    return {
      updates: p.updates,
      sameEditor: p.editor === (root as any).editor,
      sameDoc: p.doc === p.editor.state.doc,
    };
  });
  console.log("Title typing editor work:", result);
  expect(result).toEqual({ updates: 0, sameEditor: true, sameDoc: true });
  await editor.press("Control+z");
  await expect(editor).not.toContainText("!");
  await editor.press("Control+Shift+z");
  await expect(editor).toHaveText("Описание до изменения названия!");
  await expect(title).toHaveValue(
    "New task title typed character by character",
  );
  await page.screenshot({ path: "artifacts/task-title-performance.png" });
  expect(errors).toEqual([]);
});
