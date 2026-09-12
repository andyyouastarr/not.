import { test, expect } from "@playwright/test";
test("editor, saved navigation, search, favorites and trash", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=1");
  await expect(page.getByLabel("Название записи")).toHaveValue(
    "Замечать простые вещи",
  );
  await page.screenshot({
    path: "artifacts/journal-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await page.getByLabel("Название записи").fill("Тест русского текста 🎈");
  await page
    .getByRole("textbox", { name: "Текст записи" })
    .fill("Сохранённая мысль и emoji 🎈");
  await expect(
    page.getByRole("button", { name: "Сохранено", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Добавить блок", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Таблица 3 × 3" }).click();
  await expect(page.locator(".tiptap table")).toBeVisible();
  await page
    .getByRole("button", { name: "Добавить строку", exact: true })
    .click();
  await expect(page.locator(".tiptap tr")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Избранное", exact: true })
    .last()
    .click();
  await page.getByRole("button", { name: "В корзину", exact: true }).click();
  await page.getByRole("button", { name: "Корзина", exact: true }).click();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: "Тест русского текста 🎈" }),
    })
    .click();
  await expect(
    page.getByText(
      "Запись в корзине. Восстановите её, чтобы продолжить писать.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Восстановить запись", exact: true })
    .click();
  await page.getByRole("button", { name: "Все записи", exact: true }).click();
  await page.getByLabel("Поиск по дневнику").fill("Сохранённая мысль");
  await expect(page.locator(".entry-card")).toHaveCount(1);
  expect(errors).toEqual([]);
});
test("focus, keyboard and narrow layout", async ({ page }) => {
  await page.goto("/?demo=1");
  await expect(page.getByLabel("Название записи")).toBeVisible();
  await page.getByRole("button", { name: "Режим фокуса", exact: true }).click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".entry-list")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator(".entry-list")).toBeVisible();
  for (const width of [1280, 853, 640]) {
    await page.setViewportSize({ width, height: 840 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/journal-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 840 });
  await page
    .getByRole("button", { name: "Настройки", exact: true })
    .first()
    .click();
  await page.getByRole("switch").check();
  await expect(page.locator(".opaque")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть" })
    .click();
  await page.keyboard.press("Control+n");
  await expect(page.getByLabel("Название записи")).toHaveValue("");
});
test("production-style browser has no pretend vault", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Ваш дневник живёт в приложении")).toBeVisible();
  await expect(page.locator(".tiptap")).toHaveCount(0);
});
test("block keyboard movement and undo preserve paragraphs", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await expect(page.getByLabel("Название записи")).toBeVisible();
  await page.keyboard.press("Control+n");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Первый");
  await editor.press("End");
  await editor.press("Enter");
  await page.keyboard.insertText("Второй");
  await editor.press("Enter");
  await page.keyboard.insertText("Третий");
  await editor.press("Control+Alt+ArrowUp");
  await expect(page.locator(".tiptap > p")).toHaveText([
    "Первый",
    "Третий",
    "Второй",
  ]);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(page.locator(".tiptap > p")).toHaveText([
    "Первый",
    "Второй",
    "Третий",
  ]);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.locator(".tiptap > p")).toHaveText([
    "Первый",
    "Третий",
    "Второй",
  ]);
  await page.setViewportSize({ width: 640, height: 840 });
  await page
    .getByRole("combobox", { name: "Раздел дневника" })
    .selectOption("trash");
  await expect(page.locator(".entry-card")).toHaveCount(0);
});
