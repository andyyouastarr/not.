import { test, expect, type Page } from "@playwright/test";
import os from "node:os";
import path from "node:path";
const shot = (page: Page, name: string) =>
  page.screenshot({
    animations: "disabled",
    path: path.join(os.tmpdir(), `not-theme-${name}.png`),
  });
async function settings(page: Page) {
  await page
    .getByRole("button", { name: "Настройки", exact: true })
    .first()
    .click();
}
async function close(page: Page) {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /^Закрыть$/ })
    .click();
}

test("theme switches paint only, retains document and editor identity", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=1");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Текст до смены темы 🎈");
  const before = await editor.boundingBox();
  await editor.evaluate((e) => {
    (window as any).themeEditor = e;
  });
  await shot(page, "dark-diary");
  await settings(page);
  await page.getByLabel("Тема", { exact: true }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const contrast = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement);
    const luminance = (name: string) => {
      const hex = css.getPropertyValue(name).trim();
      const rgb = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    };
    return Math.min(
      ...[
        "--text",
        "--muted",
        "--faint",
        "--accent",
        "--ink-danger",
        "--ink-success",
      ].flatMap((ink) =>
        ["--bg", "--page", "--panel"].map(
          (bg) => (luminance(bg) + 0.05) / (luminance(ink) + 0.05),
        ),
      ),
    );
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await shot(page, "light-settings");
  await close(page);
  await expect(editor).toHaveText("Текст до смены темы 🎈");
  expect(await editor.evaluate((e) => e === (window as any).themeEditor)).toBe(
    true,
  );
  expect(await editor.boundingBox()).toEqual(before);
  await expect(editor).toHaveCSS("color", "rgb(17, 17, 19)");
  await shot(page, "light-diary");
  await editor.click();
  // Tiptap groups text input within 500ms; this is a separate undo step.
  await page.waitForTimeout(600);
  await editor.press("End");
  await editor.press("!");
  await editor.press("Control+z");
  await expect(editor).toHaveText("Текст до смены темы 🎈");
  await settings(page);
  await page.getByRole("switch").check();
  await close(page);
  await shot(page, "light-opaque");
  await settings(page);
  await page.getByLabel("Тема", { exact: true }).selectOption("dark");
  await close(page);
  await expect(editor).toHaveText("Текст до смены темы 🎈");
  expect(errors).toEqual([]);
});

test("light planner nested dialogs, narrow layout and keyboard", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await settings(page);
  await page.getByLabel("Тема", { exact: true }).selectOption("light");
  await close(page);
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await shot(page, "light-planner");
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const task = page.getByRole("dialog", { name: "Задача", exact: true });
  await task.getByLabel("Название задачи").fill("Жемчужная тема");
  await task
    .getByRole("textbox", { name: "Текст записи" })
    .fill("Описание с чёрным текстом");
  await shot(page, "light-task");
  await task
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  const nested = page.getByRole("dialog", {
    name: "Настройки Планера → Исполнители",
    exact: true,
  });
  await nested.getByLabel("Имя исполнителя").fill("Анна");
  await shot(page, "light-assignees");
  await nested
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  await page.setViewportSize({ width: 650, height: 840 });
  await shot(page, "light-narrow-task");
  expect(await task.evaluate((e) => e.scrollWidth > e.clientWidth + 1)).toBe(
    false,
  );
  await task.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 840 });
  await expect(page.locator(".planner-card")).toContainText("Анна");
  await shot(page, "light-card");
  await page.getByRole("button", { name: "Дневник", exact: true }).click();
  const button = page.getByRole("button", { name: /клавиатур/i }).first();
  await button.click();
  await expect(page.locator(".keyboard-guide")).toBeVisible();
  await shot(page, "light-keyboard");
});

test("failed theme save restores confirmed palette", async ({ page }) => {
  await page.route("**/src/demo.ts", async (route) => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace(
      'case "setAppearance":',
      'case "setAppearance": throw Error("Theme write failed");',
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/?demo=1");
  await settings(page);
  await page.getByLabel("Тема", { exact: true }).selectOption("light");
  await expect(page.getByRole("alert")).toHaveText("Theme write failed");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("Тема", { exact: true })).toHaveValue("dark");
});
