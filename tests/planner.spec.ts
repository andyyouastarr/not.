import { test, expect } from "@playwright/test";
import { pointerDrag } from "./taskDrag";

test("planner lifecycle, drag, stages, recovery and diary isolation", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const original = await page.getByLabel("Название записи").inputValue();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Доска задач" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  await dialog.getByLabel("Название задачи").fill("Проверить Планер");
  await dialog.getByLabel("Дедлайн").fill("2020-01-01");
  const editor = dialog.getByRole("textbox", { name: "Текст записи" });
  await editor.fill("Описание задачи 🎈");
  await expect(
    dialog.getByText("Черновик сохранён", { exact: true }),
  ).toBeVisible();
  await dialog
    .locator(".task-dialog-footer")
    .getByRole("button", { name: "Отменить", exact: true })
    .click();
  await expect(
    dialog.getByText("Удалить изменения?", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Продолжить", exact: true }).click();
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const task = page
    .locator(".planner-card")
    .filter({ hasText: "Проверить Планер" });
  await expect(task).toContainText("Просрочено");
  await pointerDrag(
    page,
    task,
    page.getByRole("region", { name: "В работе", exact: true }),
  );
  await expect(
    page
      .getByRole("region", { name: "В работе", exact: true })
      .locator(".planner-card"),
  ).toHaveCount(1);
  await task.locator("summary").click();
  await task
    .getByLabel("Стадия: Проверить Планер")
    .selectOption({ label: "Готово" });
  await expect(task).toContainText("Выполнено");
  await task.locator("summary").click();
  await task.getByRole("button", { name: "В архив", exact: true }).click();
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  await expect(task).toBeVisible();
  await task.locator("summary").click();
  await task.getByRole("button", { name: "В корзину", exact: true }).click();
  await page
    .getByRole("button", { name: "Корзина", exact: true })
    .last()
    .click();
  await task.locator("summary").click();
  await task.getByRole("button", { name: "Восстановить", exact: true }).click();
  await page.getByRole("button", { name: "Архив", exact: true }).click();
  await task.locator("summary").click();
  await task
    .getByRole("button", { name: "Вернуть из архива", exact: true })
    .click();
  await page.getByRole("button", { name: "Входящие", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Готово", exact: true })
      .locator(".planner-card"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Настроить стадии" }).click();
  await page.getByLabel("Удалить стадию 3", { exact: true }).click();
  await page
    .getByRole("button", { name: "Удалить стадию", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await expect(
    page.getByLabel("Входящие задачи").locator(".planner-card"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Дневник", exact: true }).click();
  await expect(page.getByLabel("Название записи")).toHaveValue(original);
});

test("planner width, edge scrolling and encrypted draft indicator", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page.getByRole("button", { name: "Настроить стадии" }).click();
  for (let i = 0; i < 4; i++)
    await page
      .getByRole("button", { name: "+ Добавить стадию", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Сохранить стадии", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await expect(page.locator(".kanban-column")).toHaveCount(7);
  const width = await page
    .locator(".kanban-column")
    .first()
    .evaluate((e) => e.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(260);
  await page
    .getByRole("button", { name: "Прокрутить доску вправо", exact: true })
    .hover();
  await expect
    .poll(() => page.locator(".kanban-board").evaluate((e) => e.scrollLeft))
    .toBeGreaterThan(100);
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.getByLabel("Название задачи").fill("Защищённый черновик");
  await expect(
    page.getByText("Черновик сохранён", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+s");
  await page.screenshot({ path: "artifacts/planner-task.png" });
});

test("planner narrow and wide geometry, keyboard order and draft discard", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  for (const title of ["Первая задача", "Вторая задача"]) {
    await page
      .getByRole("button", { name: "Новая задача", exact: true })
      .last()
      .click();
    await page.getByLabel("Название задачи").fill(title);
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  }
  const second = page
    .locator(".planner-card")
    .filter({ hasText: "Вторая задача" });
  await second.locator("summary").focus();
  await page.keyboard.press("Enter");
  await second.getByRole("button", { name: "Выше", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".planner-inbox .planner-card").first(),
  ).toContainText("Вторая задача");
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.getByLabel("Название задачи").fill("Отменяемая задача");
  await page.getByText("Черновик сохранён", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Удалить изменения", exact: true })
    .click();
  await expect(page.locator(".planner-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Настроить стадии" }).click();
  for (let i = 0; i < 3; i++)
    await page
      .getByRole("button", { name: "+ Добавить стадию", exact: true })
      .click();
  await page
    .getByLabel("Название стадии 1", { exact: true })
    .fill(
      "Очень длинное название стадии для проверки переноса текста и размеров колонок",
    );
  await page
    .getByRole("button", { name: "Сохранить стадии", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  for (const width of [640, 960, 1280, 1920, 2560]) {
    await page.setViewportSize({ width, height: 840 });
    const geometry = await page.locator(".kanban-board").evaluate((e) => ({
      width: e.clientWidth,
      columns: [...e.querySelectorAll(".kanban-column")].map((c) => ({
        left: c.getBoundingClientRect().left,
        width: c.getBoundingClientRect().width,
      })),
      right: e.getBoundingClientRect().right,
    }));
    expect(geometry.columns.every((c) => c.width >= 260)).toBe(true);
    expect(
      geometry.columns.filter((c) => c.left + c.width <= geometry.right + 1)
        .length,
    ).toBeLessThanOrEqual(5);
  }
  await page.screenshot({ path: "artifacts/planner-wide.png" });
});

test("planner handles a populated board and zero or one stage", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("heading", { name: "Доска задач", exact: true })
    .waitFor();
  await page.evaluate(async () => {
    // Seed development-only data, then exercise the real rendered board.
    const { preview } = await import("/src/planner/demo.ts");
    let b = preview();
    for (let i = 0; i < 300; i++) {
      const id = crypto.randomUUID();
      b = preview({
        action: "save",
        draft: {
          id,
          title: `Задача ${i + 1}`,
          document: { type: "doc", content: [{ type: "paragraph" }] },
          deadline: null,
          revision: 0,
        },
      });
      preview({
        action: "move",
        id,
        revision: 1,
        stage: b.stages[i % 3].id,
        before: null,
      });
    }
    window.dispatchEvent(new Event("planner-updated"));
  });
  await expect(page.locator(".planner-card")).toHaveCount(300);
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await page.getByLabel("Название задачи").fill("Ввод на заполненной доске");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".planner-card")).toHaveCount(301);
  for (const count of [1, 0]) {
    await page.evaluate(async (count) => {
      const { preview } = await import("/src/planner/demo.ts");
      let b = preview();
      while (b.stages.length > count) {
        b = preview({
          action: "stages",
          stages: b.stages.slice(0, -1),
          removed: b.stages.at(-1).id,
          destination: null,
          revision: b.revision,
        });
      }
      window.dispatchEvent(new Event("planner-updated"));
    }, count);
    await expect(page.locator(".kanban-column")).toHaveCount(count);
  }
  await expect(
    page.getByText("Добавьте стадии в настройках.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".planner-inbox .planner-card")).toHaveCount(301);
});
