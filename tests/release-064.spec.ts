import { test, expect } from "@playwright/test";

test("diary placeholders, Timestamp alongside create task, persistence and readonly", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: /Новая запись/ })
    .first()
    .click();
  await expect(page.locator(".title-input")).toHaveAttribute(
    "placeholder",
    "Название",
  );
  const editor = page.locator(".journal-prose").first();
  await expect(editor.locator("p").first()).toHaveAttribute(
    "data-placeholder",
    "Здесь будет ваш текст",
  );
  await editor.fill("Текст дневника");
  await editor.press("Control+a");
  await editor.dispatchEvent("keydown", { key: "F10", shiftKey: true });
  await editor.dispatchEvent("contextmenu", { button: 2 });
  const menu = await page.evaluate(() => window.__notTaskMenu?.prepare());
  expect(menu?.label).toBe("Создать задачу");
  expect(menu?.additional?.[0].label).toBe("Timestamp разделитель");
  await page.evaluate(
    (token) => window.__notTaskMenu?.run(token!),
    menu?.additional?.[0].token,
  );
  await expect(editor.locator(".timestamp-divider")).toHaveCount(1);
  await page.keyboard.type("After");
  await expect(editor.locator("p").last()).toHaveText("After");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page.getByRole("button", { name: "Дневник", exact: true }).click();
  await expect(editor.locator(".timestamp-divider")).toHaveCount(1);
});

test("card native menu moves task to trash, single use, restore and no stale dialog action", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.getByLabel("Название задачи").fill("Context trash");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  const card = page
    .locator(".planner-card")
    .filter({ hasText: "Context trash" });
  await card.dispatchEvent("contextmenu", { button: 2 });
  const item = await page.evaluate(() => window.__notTaskMenu?.prepare());
  expect(item?.label).toBe("В корзину");
  expect(item?.enabled).toBe(true);
  await page.evaluate((token) => {
    window.__notTaskMenu?.run(token!);
    window.__notTaskMenu?.run(token!);
  }, item?.token);
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await expect(card).toHaveCount(1);
  await expect(page.getByText(/Очистка выполняется/)).toBeVisible();
  await card.dispatchEvent("contextmenu", { button: 2 });
  expect(await page.evaluate(() => window.__notTaskMenu?.prepare())).toBeNull();
  await card.locator("summary").click();
  await card.getByRole("button", { name: "Восстановить", exact: true }).click();
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await expect(card).toHaveCount(1);
  await card.dispatchEvent("contextmenu", { button: 2 });
  const stale = await page.evaluate(() => window.__notTaskMenu?.prepare());
  await card.locator(".planner-card-open").click();
  await page.evaluate(
    (token) => window.__notTaskMenu?.run(token!),
    stale?.token,
  );
  await expect(
    page.getByRole("dialog", { name: "Задача", exact: true }),
  ).toBeVisible();
  await page
    .locator(".task-dialog-footer")
    .getByRole("button", { name: "Отменить", exact: true })
    .click();
  await expect(card).toHaveCount(1);
});
