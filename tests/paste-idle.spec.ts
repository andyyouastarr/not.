import { test, expect } from "@playwright/test";

async function pasteImage(
  page: import("@playwright/test").Page,
  corrupt = false,
) {
  await page
    .getByRole("textbox", { name: "Текст записи" })
    .evaluate(async (editor, corrupt) => {
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 120;
      canvas.getContext("2d")!.fillRect(0, 0, 200, 120);
      const blob = corrupt
        ? new Blob(["not an image"], { type: "image/png" })
        : await new Promise<Blob>((resolve) =>
            canvas.toBlob((b) => resolve(b!)),
          );
      const data = new DataTransfer();
      data.items.add(new File([blob], "paste.png", { type: "image/png" }));
      editor.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, corrupt);
}

test("pasted images save on navigation, undo and redo; corrupt image leaves text intact", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await page.getByLabel("Название записи").fill("Буфер изображения");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("До изображения");
  await editor.click();
  await editor.press("End");
  await pasteImage(page);
  await page
    .getByRole("button", { name: "Новая запись", exact: true })
    .first()
    .click();
  await expect(editor.locator("img")).toHaveCount(0);
  await page
    .locator(".entry-card")
    .filter({
      has: page.getByRole("heading", {
        name: "Буфер изображения",
        exact: true,
      }),
    })
    .click();
  const img = editor.locator("img");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i) => i.naturalHeight)).toBe(120);
  await editor.click();
  await editor.press("Control+End");
  await pasteImage(page);
  await expect(img).toHaveCount(2);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(img).toHaveCount(1);
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(img).toHaveCount(2);
  await pasteImage(page, true);
  await expect(page.getByRole("alert")).toContainText(
    "Не удалось прочитать изображение",
  );
  await expect(editor).toContainText("До изображения");
  await expect(img).toHaveCount(2);
});

test("idle lock defaults to 30 minutes, accepts presets, never and custom; persists dialog reopen", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const settings = page
    .getByRole("button", { name: "Настройки", exact: true })
    .first();
  await settings.click();
  const choice = page.getByRole("combobox", {
    name: "Блокировка при бездействии",
  });
  await expect(choice).toHaveValue("30");
  for (const minutes of ["1", "5", "15", "60", "0"]) {
    await choice.selectOption(minutes);
    await expect(choice).toHaveValue(minutes);
    await expect(choice).toBeEnabled();
  }
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await settings.click();
  await expect(choice).toHaveValue("0");
  await choice.selectOption("custom");
  await page.getByRole("spinbutton").fill("7");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(choice).toBeEnabled();
  await page.screenshot({ path: "artifacts/idle-lock-settings.png" });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await settings.click();
  await expect(choice).toHaveValue("custom");
  await expect(page.getByRole("spinbutton")).toHaveValue("7");
  await page.getByRole("spinbutton").fill("241");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(
    await page
      .getByRole("spinbutton")
      .evaluate((el: HTMLInputElement) => el.validity.valid),
  ).toBe(false);
});
