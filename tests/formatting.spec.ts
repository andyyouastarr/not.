import { test, expect } from "@playwright/test";

test("settings dismiss on backdrop click but not inside or a drag from inside", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "Настройки", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("heading", { name: "Настройки" }).click();
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Название записи")).toHaveValue(
    "Замечать простые вещи",
  );
});

test("four highlight colors preserve selection, undo and saved formatting", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Важная мысль и обычный текст");
  await editor.press("Control+Home");
  await page.keyboard.down("Shift");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  const marker = page.getByRole("button", {
    name: "Маркер текста",
    exact: true,
  });
  // Exercise palette hit testing above a stacked editable surface.
  await editor.evaluate((element) => {
    element.style.position = "relative";
    element.style.zIndex = "1";
  });
  for (const [color, name] of [
    ["lavender", "Лавандовый"],
    ["yellow", "Жёлтый"],
    ["green", "Зелёный"],
    ["pink", "Розовый"],
  ]) {
    await marker.click();
    await page.getByRole("button", { name: `${name} маркер` }).click();
    await expect(editor.locator("mark")).toHaveAttribute(
      "data-highlight",
      color,
    );
    await expect(editor.locator("mark")).toHaveText("Важная");
  }
  await editor.press("Control+z");
  await expect(editor.locator("mark")).toHaveAttribute(
    "data-highlight",
    "green",
  );
  await editor.press("Control+Shift+z");
  await expect(editor.locator("mark")).toHaveAttribute(
    "data-highlight",
    "pink",
  );
  await marker.click();
  await page.getByRole("button", { name: "Розовый маркер" }).click();
  await expect(editor.locator("mark")).toHaveCount(0);
  await editor.press("Control+z");
  await expect(editor.locator("mark")).toHaveAttribute(
    "data-highlight",
    "pink",
  );
  await expect(
    page.getByRole("button", { name: "Сохранено", exact: true }),
  ).toBeVisible();
  await page
    .locator(".entry-card")
    .filter({ hasText: "Немного ясности" })
    .click();
  await page
    .locator(".entry-card")
    .filter({ hasText: "Замечать простые вещи" })
    .click();
  await expect(editor.locator("mark")).toHaveText("Важная");
  await expect(editor).toHaveText("Важная мысль и обычный текст");
  await editor.press("Control+Home");
  await editor.press("Control+Shift+ArrowRight");
  await marker.click();
  await page.screenshot({ path: "artifacts/highlight-palette.png" });
  await page.getByRole("button", { name: "Убрать маркер" }).click();
  await expect(editor.locator("mark")).toHaveCount(0);
});
