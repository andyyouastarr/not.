import { test, expect, type Locator, type Page } from "@playwright/test";

async function setup(page: Page, task = false, long = false) {
  await page.goto("/?demo=1");
  if (task) {
    await page.getByRole("button", { name: "Планер", exact: true }).click();
    await page
      .getByRole("button", { name: "Новая задача", exact: true })
      .last()
      .click();
    await page.getByLabel("Название задачи").fill("Images 0.7.0");
  } else {
    await page
      .getByRole("button", { name: "Новая запись", exact: true })
      .first()
      .click();
    await page.getByLabel("Название записи").fill("Images 0.7.0");
  }
  const editor = page.locator(".journal-prose:visible");
  await editor.click();
  await editor.evaluate(async (root) => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 160;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#aca0d5";
    ctx.fillRect(0, 0, 400, 160);
    ctx.fillStyle = "#3a3450";
    ctx.fillRect(0, 100, 400, 60);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!)));
    const data = new DataTransfer();
    data.items.add(new File([blob], "image.png", { type: "image/png" }));
    root.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(editor.locator("img")).toBeVisible();
  await editor.evaluate((root, long) => {
    const e = (root as any).editor;
    const image = structuredClone(e.getJSON()).content.find(
      (n: any) => n.type === "image",
    );
    image.attrs.widthPercent = 35;
    image.attrs.layout = "left";
    e.commands.setContent({
      type: "doc",
      content: [
        image,
        ...Array.from({ length: long ? 35 : 5 }, (_, i) => ({
          type: "paragraph",
          content: [
            {
              type: "text",
              text:
                `Абзац ${i + 1}. ` +
                "Текст должен обтекать изображение без потери содержимого. ".repeat(
                  3,
                ),
            },
          ],
        })),
      ],
    });
    (window as any).__imageBefore = JSON.stringify(e.getJSON());
    (window as any).__imageUpdates = 0;
    e.on("update", () => {
      (window as any).__imageUpdates++;
    });
  }, long);
  await expect(editor.locator("img")).toBeVisible();
  await expect(editor.locator(".node-image")).toHaveCSS("float", "left");
  await expect(editor.locator(".node-image")).toHaveAttribute("style", /35%/);
  await expect
    .poll(async () => {
      const b = await editor.locator("img").boundingBox();
      const c = await editor.boundingBox();
      return Math.round((100 * b!.width) / c!.width);
    })
    .toBe(35);
  return editor;
}
async function begin(page: Page, editor: Locator, x: number, y: number) {
  const img = await editor
    .locator(".node-image:not(.image-preview) img")
    .first()
    .boundingBox();
  await page.mouse.move(img!.x + img!.width / 2, img!.y + img!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
}
async function json(editor: Locator) {
  return editor.evaluate((root) =>
    JSON.stringify((root as any).editor.getJSON()),
  );
}

test("autoscroll, blur cancellation and save/reopen", async ({ page }) => {
  const editor = await setup(page, true, true);
  const before = await json(editor);
  const canvas = await editor.boundingBox();
  const scroll = page.locator(".task-description");
  const viewport = await scroll.boundingBox();
  await begin(
    page,
    editor,
    canvas!.x + canvas!.width - 30,
    viewport!.y + viewport!.height - 8,
  );
  await expect
    .poll(() => scroll.evaluate((e) => e.scrollTop))
    .toBeGreaterThan(100);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(editor.locator(".image-preview")).toHaveCount(0);
  expect(await json(editor)).toBe(before);
  await scroll.evaluate((e) => (e.scrollTop = 0));
  const target = await editor.locator("p").first().boundingBox();
  await begin(page, editor, canvas!.x + canvas!.width - 30, target!.y + 8);
  await expect(editor.locator(".image-preview")).toBeVisible();
  await page.mouse.up();
  const saved = await json(editor);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .locator(".planner-card")
    .filter({ hasText: "Images 0.7.0" })
    .click();
  expect(await json(editor)).toBe(saved);
});

test("preview is not persisted, midpoint stays stable, no-op creates no update", async ({
  page,
}) => {
  const editor = await setup(page);
  const before = await json(editor);
  const box = await editor.boundingBox();
  const para = await editor.locator("p").first().boundingBox();
  await begin(page, editor, box!.x + 20, para!.y + 5);
  await expect(editor.locator(".image-preview")).toBeVisible();
  await page.mouse.move(box!.x + box!.width / 2 + 5, para!.y + 5);
  await expect(editor.locator(".image-preview")).toHaveAttribute(
    "data-image-layout",
    "left",
  );
  await page.mouse.up();
  expect(await json(editor)).toBe(before);
  expect(await page.evaluate(() => (window as any).__imageUpdates)).toBe(0);
});

test("duplicate images, list boundaries, pointer resize and document-change cancellation", async ({
  page,
}) => {
  const editor = await setup(page);
  await editor.evaluate((root) => {
    const e = (root as any).editor;
    const doc = structuredClone(e.getJSON());
    const second = structuredClone(doc.content[0]);
    second.attrs.widthPercent = 20;
    doc.content.splice(
      2,
      0,
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "List item" }],
              },
            ],
          },
        ],
      },
      second,
    );
    e.commands.setContent(doc);
  });
  await expect(editor.locator(".node-image")).toHaveCount(2);
  const before = await json(editor);
  const box = await editor.boundingBox();
  const list = await editor.locator("ul").boundingBox();
  await begin(page, editor, box!.x + box!.width - 15, list!.y + 2);
  await expect(editor.locator(".image-preview")).toBeVisible();
  await page.mouse.up();
  await expect(editor.locator(".node-image")).toHaveCount(2);
  expect(
    await editor.evaluate((root) =>
      (root as any).editor
        .getJSON()
        .content.filter((n: any) => n.type === "image")
        .map((n: any) => n.attrs.widthPercent),
    ),
  ).toEqual([35, 20]);
  await page.keyboard.press("Control+z");
  expect(await json(editor)).toBe(before);
  const handle = editor.locator(".image-resize-handle.right").first();
  const h = await handle.boundingBox();
  await page.mouse.move(h!.x + 8, h!.y + 8);
  await page.mouse.down();
  await page.mouse.move(h!.x - 45, h!.y + 8, { steps: 8 });
  expect(await json(editor)).toBe(before);
  await page.mouse.up();
  expect(await json(editor)).not.toBe(before);
  await page.keyboard.press("Control+z");
  expect(await json(editor)).toBe(before);
  await begin(page, editor, box!.x + box!.width - 15, list!.y + 2);
  await expect(editor.locator(".image-preview")).toBeVisible();
  await editor.evaluate((root) =>
    (root as any).editor.commands.insertContentAt(2, "Changed "),
  );
  await expect(editor.locator(".image-preview")).toHaveCount(0);
  const changed = await json(editor);
  await page.mouse.up();
  expect(await json(editor)).toBe(changed);
});

for (const task of [false, true])
  test(`pointer image preview, commit, undo redo (${task ? "task" : "diary"})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const editor = await setup(page, task);
    const before = await json(editor);
    const box = await editor.boundingBox();
    const target = await editor.locator("p").nth(1).boundingBox();
    await begin(page, editor, box!.x + box!.width - 35, target!.y + 5);
    await expect(editor.locator(".image-preview")).toBeVisible();
    expect(await json(editor)).toBe(before);
    expect(await page.evaluate(() => (window as any).__imageUpdates)).toBe(0);
    await expect(editor.locator(".image-preview")).toHaveAttribute(
      "data-image-layout",
      "right",
    );
    const preview = await editor.locator(".image-preview").boundingBox();
    await page.mouse.up();
    await expect(editor.locator(".image-preview")).toHaveCount(0);
    const image = editor.locator(".node-image");
    await expect(image).toHaveAttribute("data-image-layout", "right");
    const committed = await image.boundingBox();
    expect(Math.abs(committed!.x - preview!.x)).toBeLessThan(2);
    expect(Math.abs(committed!.y - preview!.y)).toBeLessThan(2);
    const after = await json(editor);
    expect(after).not.toBe(before);
    await page.keyboard.press("Control+z");
    expect(await json(editor)).toBe(before);
    await page.keyboard.press("Control+Shift+z");
    expect(await json(editor)).toBe(after);
    expect(errors).toEqual([]);
  });

test("cancel, outside drop, click, small resize and wide right side", async ({
  page,
}) => {
  const editor = await setup(page);
  const before = await json(editor);
  await editor.locator("img").click();
  expect(await json(editor)).toBe(before);
  const box = await editor.boundingBox();
  const target = await editor.locator("p").nth(1).boundingBox();
  await begin(page, editor, box!.x + box!.width - 25, target!.y + 5);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await json(editor)).toBe(before);
  await begin(page, editor, box!.x + box!.width - 25, target!.y + 5);
  await page.mouse.move(5, 5);
  await page.mouse.up();
  expect(await json(editor)).toBe(before);
  const handle = editor.locator(".image-resize-handle.right");
  await handle.focus();
  await handle.press("Home");
  const small = await editor.locator("img").boundingBox();
  expect(small!.width).toBeCloseTo(32, 0);
  await page.keyboard.press("Control+z");
  expect(await json(editor)).toBe(before);
  await editor.evaluate((root) => {
    const e = (root as any).editor;
    e.commands.updateAttributes("image", { layout: "right", widthPercent: 35 });
  });
  await handle.focus();
  await handle.press("End");
  await expect(editor.locator(".node-image")).toHaveAttribute(
    "data-image-layout",
    "right",
  );
  await expect(editor.locator(".node-image")).toHaveAttribute(
    "data-wrap-below",
    "true",
  );
  const img = await editor.locator(".node-image").boundingBox();
  const para = await editor.locator("p").first().boundingBox();
  expect(para!.y).toBeGreaterThanOrEqual(img!.y + img!.height);
});
