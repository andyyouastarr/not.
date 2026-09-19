import { test, expect } from "@playwright/test";

test("checklist creation, completion, history and saved navigation", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await page.getByLabel("Название записи").fill("Мой чек-лист");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  const toggle = page.getByRole("button", { name: "Чек-лист", exact: true });
  await editor.click();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.insertText("Написать запись");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Сделать копию");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Обычный текст после списка");
  const items = editor.locator('li[data-type="taskItem"]');
  await expect(items).toHaveCount(2);
  await expect(editor.locator(":scope > p").first()).toHaveText(
    "Обычный текст после списка",
  );
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Сохранено", exact: true }),
  ).toBeVisible();
  const done = editor.getByRole("checkbox", {
    name: "Пункт чек-листа: Написать запись",
    exact: true,
  });
  await done.check();
  await expect(done).toBeChecked();
  await expect(items.first().locator("div > p")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(done).not.toBeChecked();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(done).toBeChecked();
  const pending = editor.getByRole("checkbox", {
    name: "Пункт чек-листа: Сделать копию",
    exact: true,
  });
  await pending.focus();
  await pending.press("Space");
  await expect(pending).toBeChecked();
  await pending.uncheck();
  await expect(
    page.getByRole("button", { name: "Сохранено", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await page
    .locator(".entry-card")
    .filter({
      has: page.getByRole("heading", { name: "Мой чек-лист", exact: true }),
    })
    .click();
  await expect(done).toBeChecked();
  await expect(pending).not.toBeChecked();
  await page.screenshot({ path: "artifacts/checklist.png" });
  await page.getByRole("button", { name: "В корзину", exact: true }).click();
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await page
    .locator(".entry-card")
    .filter({
      has: page.getByRole("heading", { name: "Мой чек-лист", exact: true }),
    })
    .click();
  await done.click();
  await expect(done).toBeChecked();
});

test("block menu and slash menu create checklists; nesting keeps independent flags", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.click();
  await page.keyboard.type("/");
  await page.getByRole("menuitem", { name: "Чек-лист", exact: true }).click();
  await page.keyboard.insertText("Родительский пункт");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("Вложенный пункт");
  await page.keyboard.press("Tab");
  await expect(
    editor.locator('li[data-type="taskItem"] li[data-type="taskItem"]'),
  ).toHaveCount(1);
  await editor
    .getByRole("checkbox", {
      name: "Пункт чек-листа: Родительский пункт",
      exact: true,
    })
    .check();
  await expect(
    editor.getByRole("checkbox", {
      name: "Пункт чек-листа: Вложенный пункт",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(editor.locator('li[data-type="taskItem"] li p')).toHaveCSS(
    "text-decoration-line",
    "none",
  );
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await editor.fill("Пункт из текста");
  await page
    .getByRole("button", { name: "Добавить блок", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Чек-лист", exact: true }).click();
  await expect(editor.getByRole("checkbox")).toHaveCount(1);
  await page.getByRole("button", { name: "Чек-лист", exact: true }).click();
  await expect(editor.getByRole("checkbox")).toHaveCount(0);
  await expect(editor).toHaveText("Пункт из текста");
});
