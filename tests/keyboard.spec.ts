import { test, expect } from "@playwright/test";

test("keyboard guide preserves writing focus, resizes and never inserts text", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Начало ");
  await editor.press("Control+End");
  const toggle = page.getByRole("button", {
    name: "Клавиатура-подсказка",
    exact: true,
  });
  await toggle.click();
  const panel = page.getByRole("region", { name: "Клавиатура-подсказка" });
  await expect(panel).toBeVisible();
  await expect(editor).toBeFocused();
  await page.keyboard.insertText("продолжение");
  await expect(editor).toHaveText("Начало продолжение");
  await panel.locator(".guide-key").filter({ hasText: /^F$/ }).click();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("Начало продолжение");
  const widthResize = page.getByRole("separator", {
    name: "Ширина клавиатуры",
  });
  const initialWidth = (await panel.boundingBox())!.width;
  const side = (await widthResize.boundingBox())!;
  await page.mouse.move(side.x + 6, side.y + 20);
  await page.mouse.down();
  await page.mouse.move(side.x - 54, side.y + 20);
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeCloseTo(initialWidth - 120, 0);
  await expect(editor).toBeFocused();
  const preferredWidth = await widthResize.getAttribute("aria-valuenow");
  const resize = page.getByRole("separator", { name: "Высота клавиатуры" });
  const handle = await resize.boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 6);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y - 44);
  await page.mouse.up();
  await expect(resize).toHaveAttribute("aria-valuenow", "280");
  await expect(widthResize).toHaveAttribute("aria-valuenow", preferredWidth!);
  await expect(editor).toBeFocused();
  await toggle.click();
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(resize).toHaveAttribute("aria-valuenow", "280");
  await resize.focus();
  await resize.press("ArrowDown");
  await expect(resize).toHaveAttribute("aria-valuenow", "270");
  const bounds = await page.locator(".document-scroll").boundingBox();
  const keyboard = await panel.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(keyboard!.y + 1);
  await page.getByRole("button", { name: "Режим фокуса", exact: true }).click();
  await expect(panel).toBeVisible();
  await widthResize.focus();
  await widthResize.press("Home");
  await expect(widthResize).toHaveAttribute("aria-valuenow", "440");
  expect(
    await panel
      .locator(".keyboard-overflow")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: "artifacts/keyboard-focus.png" });
  await page.setViewportSize({ width: 640, height: 600 });
  await expect(panel).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "artifacts/keyboard-narrow.png" });
  await page
    .getByRole("button", { name: "Скрыть клавиатуру-подсказку" })
    .click();
  await expect(panel).toBeHidden();
});
