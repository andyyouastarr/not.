import { test, expect } from "@playwright/test";

test("tools stay available during scrolling while title scrolls away", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const editor = page.getByRole("textbox", { name: "Текст записи" });
  await editor.fill(
    Array.from(
      { length: 100 },
      (_, i) => `Строка ${i + 1}. Длинная запись для проверки прокрутки.`,
    ).join("\n"),
  );
  const scroll = page.locator(".document-scroll");
  const toolbar = page.getByRole("toolbar", { name: "Инструменты записи" });
  for (const focus of [false, true]) {
    if (focus)
      await page
        .getByRole("button", { name: "Режим фокуса", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Клавиатура-подсказка", exact: true })
      .click();
    for (const position of [500, 1600, 100000]) {
      await scroll.evaluate((el, top) => {
        el.scrollTop = top;
      }, position);
      await expect
        .poll(async () => {
          const a = (await scroll.boundingBox())!;
          const b = (await toolbar.boundingBox())!;
          return b.y >= a.y - 1 && b.y + b.height <= a.y + a.height;
        })
        .toBe(true);
      expect(
        (await page.getByLabel("Название записи").boundingBox())!.y,
      ).toBeLessThan((await scroll.boundingBox())!.y);
      await toolbar
        .getByRole("button", { name: "Добавить блок", exact: true })
        .click();
      await expect(
        page.getByRole("menuitem", { name: "Таблица 3 × 3" }),
      ).toBeVisible();
      await toolbar
        .getByRole("button", { name: "Добавить блок", exact: true })
        .click();
    }
    await page.screenshot({
      path: `artifacts/sticky-tools-${focus ? "focus" : "normal"}.png`,
    });
  }
});
