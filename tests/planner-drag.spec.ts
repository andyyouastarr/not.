import { test, expect } from "@playwright/test";
import { pointerDrag } from "./taskDrag";
test.beforeEach(async ({ page }) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page.locator(".kanban-column").first().waitFor();
  await page.evaluate(async () => {
    const { preview } = await import("/src/planner/demo.ts");
    for (let i = 0; i < 3; i++)
      preview({
        action: "save",
        draft: {
          id: crypto.randomUUID(),
          title: `Task ${i}`,
          document: { type: "doc", content: [{ type: "paragraph" }] },
          deadline: null,
          revision: 0,
        },
      });
    window.dispatchEvent(new Event("planner-updated"));
  });
  await expect(page.locator(".planner-card")).toHaveCount(3);
});
test("pointer transfer, ordering, no-op, outside and Escape", async ({
  page,
}) => {
  const card = (title: string) =>
    page.locator(".planner-card").filter({ hasText: title });
  const column = page.locator(".kanban-cards").first();
  await pointerDrag(page, card("Task 0"), column, 0.2);
  await expect(column.locator(".planner-card")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pointerDrag(page, card("Task 1"), card("Task 0"), 0.1);
  await expect(column.locator(".planner-card").first()).toContainText("Task 1");
  await pointerDrag(page, card("Task 1"), card("Task 0"), 0.9);
  await expect(column.locator(".planner-card").last()).toContainText("Task 1");
  const revision = () =>
    page.evaluate(
      async () => (await import("/src/planner/demo.ts")).preview().revision,
    );
  const before = await revision();
  await pointerDrag(page, card("Task 1"), column, 0.8);
  expect(await revision()).toBe(before);
  await pointerDrag(page, card("Task 1"), page.locator(".planner-inbox"), 0.8);
  await expect(page.locator(".planner-inbox .planner-card")).toHaveCount(2);
  for (const cancel of ["Escape", "outside", "blur", "pointercancel"]) {
    const r = (await card("Task 0").boundingBox())!;
    await page.mouse.move(r.x + 30, r.y + 20);
    await page.mouse.down();
    await page.mouse.move(r.x + 50, r.y + 30, { steps: 4 });
    await expect(page.locator(".task-drag-overlay")).toBeVisible();
    if (cancel === "Escape") await page.keyboard.press("Escape");
    else if (cancel === "outside") await page.mouse.move(3, 3);
    else
      await page.evaluate(
        (type) => window.dispatchEvent(new Event(type)),
        cancel,
      );
    await page.mouse.up();
    await expect(page.locator(".task-drag-overlay")).toHaveCount(0);
    await expect(column.locator(".planner-card")).toHaveCount(1);
  }
});
test("short click opens task and menus do not drag", async ({ page }) => {
  const card = page.locator(".planner-card").first();
  await card.locator("summary").click();
  await expect(card.locator("select")).toBeVisible();
  await expect(page.locator(".task-drag-overlay")).toHaveCount(0);
  await card.locator(".planner-card-open").click();
  await expect(
    page.getByRole("dialog", { name: "Задача", exact: true }),
  ).toBeVisible();
});

test("drag scrolls both axes and stops on cancel", async ({ page }) => {
  await page.evaluate(async () => {
    const { preview } = await import("/src/planner/demo.ts");
    let b = preview();
    preview({
      action: "stages",
      stages: [
        ...b.stages,
        ...Array.from({ length: 4 }, (_, i) => ({
          id: crypto.randomUUID(),
          title: `Extra ${i}`,
          completed: false,
        })),
      ],
      revision: b.revision,
      removed: null,
      destination: null,
    });
    for (let i = 0; i < 40; i++) {
      const id = crypto.randomUUID();
      preview({
        action: "save",
        draft: {
          id,
          title: `Long ${i}`,
          document: { type: "doc", content: [{ type: "paragraph" }] },
          revision: 0,
          deadline: null,
        },
      });
      preview({
        action: "move",
        id,
        revision: 1,
        stage: b.stages[0].id,
        before: null,
      });
    }
    window.dispatchEvent(new Event("planner-updated"));
  });
  await expect(page.locator(".kanban-column")).toHaveCount(7);
  const source = (await page
    .locator(".planner-inbox .planner-card")
    .first()
    .boundingBox())!;
  const col = (await page.locator(".kanban-cards").first().boundingBox())!;
  await page.mouse.move(source.x + 30, source.y + 20);
  await page.mouse.down();
  await page.mouse.move(col.x + 100, col.y + col.height - 8, { steps: 20 });
  await expect
    .poll(() =>
      page
        .locator(".kanban-cards")
        .first()
        .evaluate((e) => e.scrollTop),
    )
    .toBeGreaterThan(80);
  const board = (await page.locator(".kanban-board").boundingBox())!;
  await page.mouse.move(board.x + board.width - 8, board.y + 120, {
    steps: 20,
  });
  await expect
    .poll(() => page.locator(".kanban-board").evaluate((e) => e.scrollLeft))
    .toBeGreaterThan(80);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  const scroll = await page
    .locator(".kanban-board")
    .evaluate((e) => e.scrollLeft);
  await page.waitForTimeout(450);
  expect(
    await page.locator(".kanban-board").evaluate((e) => e.scrollLeft),
  ).toBe(scroll);
});

test("one save per drop, pending preview and rollback after disk error", async ({
  page,
}) => {
  await page.route("**/src/api.ts", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "return mock(type, args);",
      `if (type === "plannerChange" && args.change.action === "move") { window.moveCalls = (window.moveCalls || 0) + 1; await new Promise(resolve => window.releaseMove = resolve); if (window.failMove) throw Error("Test disk write failed"); } return mock(type, args);`,
    );
    await route.fulfill({ response, body });
  });
  await page.reload();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page.locator(".kanban-column").first().waitFor();
  await page.evaluate(async () => {
    const { preview } = await import("/src/planner/demo.ts");
    preview({
      action: "save",
      draft: {
        id: crypto.randomUUID(),
        title: "Failure task",
        document: { type: "doc", content: [{ type: "paragraph" }] },
        deadline: null,
        revision: 0,
      },
    });
    window.failMove = true;
    window.dispatchEvent(new Event("planner-updated"));
  });
  const task = page.locator(".planner-card");
  const target = page.locator(".kanban-cards").first();
  await pointerDrag(page, task, target, 0.2);
  await expect(target.locator(".task-saving")).toHaveCount(1);
  expect(await page.evaluate(() => window.moveCalls)).toBe(1);
  await page.evaluate(() => window.releaseMove());
  await expect(page.getByRole("alert")).toContainText("Test disk write failed");
  await expect(page.locator(".planner-inbox .planner-card")).toHaveCount(1);
  await page.evaluate(() => {
    window.failMove = false;
  });
  await pointerDrag(page, task, target, 0.2);
  await expect.poll(() => page.evaluate(() => window.moveCalls)).toBe(2);
  await page.evaluate(() => window.releaseMove());
  await expect(target.locator(".planner-card:not(.task-saving)")).toHaveCount(
    1,
  );
  expect(await page.evaluate(() => window.moveCalls)).toBe(2);
});
