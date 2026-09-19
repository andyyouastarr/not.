import { test, expect } from "@playwright/test";

test("saved links open separately by click and Enter, without replacing the diary", async ({
  page,
  context,
  baseURL,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await page.getByLabel("Название записи").fill("Запись со ссылкой");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Открыть страницу");
  await expect(
    page.getByRole("button", { name: "Сохранено", exact: true }),
  ).toBeVisible();
  await editor.click();
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.getByRole("button", { name: "Ссылка", exact: true }).click();
  const url = `${baseURL}/?link-test=1#fragment`;
  await page.getByRole("textbox", { name: "Ссылка", exact: true }).fill(url);
  await page
    .locator(".link-menu")
    .getByRole("button", { name: "Добавить", exact: true })
    .click();
  const link = editor.getByRole("link", {
    name: "Открыть страницу",
    exact: true,
  });
  await expect(link).toHaveAttribute("href", url);
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
      has: page.getByRole("heading", {
        name: "Запись со ссылкой",
        exact: true,
      }),
    })
    .click();
  const diaryUrl = page.url();
  for (const keyboard of [false, true]) {
    const opened = context.waitForEvent("page");
    if (keyboard) {
      await link.focus();
      await link.press("Enter");
    } else await link.click();
    const target = await opened;
    await expect(target).toHaveURL(url);
    await expect(page).toHaveURL(diaryUrl);
    await expect(editor).toHaveText("Открыть страницу");
    await target.close();
  }
  // Selecting linked text must remain an edit operation.
  const bounds = (await link.boundingBox())!;
  let unexpected = 0;
  context.on("page", () => unexpected++);
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width - 2,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => window.getSelection()?.toString().length ?? 0),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Ссылка", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Ссылка", exact: true }),
  ).toHaveValue(url);
  expect(unexpected).toBe(0);
});

test("unsafe links are rejected when assigning a URL", async ({ page }) => {
  await page.goto("/?demo=1");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Текст");
  await editor.click();
  await editor.press("Home");
  await editor.press("Shift+End");
  await page.getByRole("button", { name: "Ссылка", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ссылка", exact: true })
    .fill("file:///C:/Windows/notepad.exe");
  await page
    .locator(".link-menu")
    .getByRole("button", { name: "Добавить", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Введите корректную ссылку",
  );
  await expect(editor.getByRole("link")).toHaveCount(0);
});
