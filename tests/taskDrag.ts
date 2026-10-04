import type { Locator, Page } from "@playwright/test";
export async function pointerDrag(
  page: Page,
  card: Locator,
  target: Locator,
  fraction = 0.5,
) {
  const from = await card.boundingBox(),
    to = await target.boundingBox();
  if (!from || !to) throw Error("Missing drag geometry");
  await page.mouse.move(from.x + 35, from.y + 25);
  await page.mouse.down();
  await page.mouse.move(from.x + 45, from.y + 25, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * fraction, {
    steps: 20,
  });
  await page.locator(".task-drag-overlay").waitFor();
  await page.mouse.up();
}
