import { test, expect } from "@playwright/test";
import { pointerDrag } from "./taskDrag";
import os from "node:os";
import path from "node:path";

test("history tabs retain editor, undo and draft; repeated visits are grouped", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  const history = dialog.getByRole("tab", { name: "История", exact: true });
  const editor = dialog.getByRole("textbox", { name: "Текст записи" });
  await dialog.getByLabel("Название задачи").fill("История тест");
  await editor.fill("Первый текст");
  await editor.press("End");
  await editor.pressSequentially(" добавление");
  await editor.evaluate((e) => {
    (window as any).historyEditor = e;
  });
  await history.click();
  await expect(
    dialog.getByText("История появится после создания задачи"),
  ).toBeVisible();
  await history.press("ArrowLeft");
  await expect(dialog.getByRole("tab", { name: "Новая задача" })).toBeFocused();
  expect(
    await editor.evaluate((e) => e === (window as any).historyEditor),
  ).toBe(true);
  await expect(editor).toContainText("добавление");
  await editor.click();
  await editor.press("Control+z");
  await expect(editor).not.toContainText("добавление");
  await editor.press("Control+y");
  await expect(editor).toContainText("добавление");
  await editor.evaluate((root) =>
    (root as any).editor.commands.setTextSelection({ from: 2, to: 8 }),
  );
  await history.click();
  await dialog.getByRole("tab", { name: "Новая задача" }).click();
  expect(
    await editor.evaluate((root) => {
      const s = (root as any).editor.state.selection;
      return { from: s.from, to: s.to };
    }),
  ).toEqual({ from: 2, to: 8 });
  await history.click();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  const card = page
    .locator(".planner-card")
    .filter({ hasText: "История тест" });
  for (const title of ["В работе", "К выполнению", "В работе"]) {
    await expect(card).toHaveAttribute("data-movable", "true");
    await pointerDrag(
      page,
      card,
      page.getByRole("region", { name: title, exact: true }),
    );
    await expect(
      page
        .getByRole("region", { name: title, exact: true })
        .locator(".planner-card"),
    ).toHaveCount(1);
    await expect(card).toHaveAttribute("data-movable", "true");
  }
  await card.locator(".planner-card-open").click();
  await history.click();
  await expect(dialog.locator(".history-stage h4")).toHaveText([
    "Входящие",
    "В работе",
    "К выполнению",
  ]);
  await expect(
    dialog
      .locator(".history-stage")
      .filter({
        has: page.getByRole("heading", { name: "В работе", exact: true }),
      })
      .locator("li"),
  ).toHaveCount(2);
  await page.screenshot({
    path: path.join(os.tmpdir(), "not-history-dark.png"),
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await expect(history).toHaveCSS("color", "rgb(17, 17, 19)");
  await page.screenshot({
    path: path.join(os.tmpdir(), "not-history-light.png"),
  });
  await page.setViewportSize({ width: 720, height: 840 });
  await expect(
    dialog.getByRole("button", { name: "Закрыть задачу" }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole("button", { name: "Сохранить", exact: true }),
  ).toBeInViewport();
});

test("history pagination, retry and ignored response after tab closes", async ({
  page,
}) => {
  await page.route("**/src/api.ts", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "return mock(type, args);",
      `if(type === "taskHistory") { if(window.historyFail) throw Error("History read failed"); if(window.historyHold) await new Promise(resolve=>window.releaseHistory=resolve); } return mock(type,args);`,
    );
    await route.fulfill({ response, body });
  });
  await page.goto("/?demo=1");
  await page.evaluate(async () => {
    const { preview } = await import("/src/planner/demo.ts");
    let b = preview({
      action: "save",
      draft: {
        id: crypto.randomUUID(),
        title: "Long history",
        document: { type: "doc", content: [{ type: "paragraph" }] },
        deadline: null,
        assigneeId: null,
        revision: 0,
      },
    });
    for (let i = 0; i < 205; i++)
      b = preview({
        action: "move",
        id: b.tasks[0].id,
        revision: b.tasks[0].revision,
        stage: b.stages[i % 2].id,
        before: null,
      });
    (window as any).historyFail = true;
  });
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page.locator(".planner-card-open").click();
  const dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  const tab = dialog.getByRole("tab", { name: "История", exact: true });
  await tab.click();
  await expect(dialog.getByRole("alert")).toContainText("History read failed");
  await page.evaluate(() => {
    (window as any).historyFail = false;
  });
  await dialog.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(dialog.locator(".history-stage li")).toHaveCount(200);
  await dialog
    .getByRole("button", { name: "Показать ещё", exact: true })
    .click();
  await expect(dialog.locator(".history-stage li")).toHaveCount(206);
  await expect(dialog.locator(".history-stage")).toHaveCount(3);
  await dialog.getByRole("tab", { name: "Редактирование задачи" }).click();
  await page.evaluate(() => {
    (window as any).historyHold = true;
  });
  await tab.click();
  await expect(dialog.getByText("Загрузка истории…")).toBeVisible();
  await dialog.getByRole("tab", { name: "Редактирование задачи" }).click();
  await page.evaluate(() => {
    (window as any).releaseHistory();
    (window as any).historyHold = false;
  });
  await expect(dialog.locator(".task-history")).toHaveCount(0);
  await tab.click();
  await expect(dialog.locator(".history-stage li")).toHaveCount(200);
});
