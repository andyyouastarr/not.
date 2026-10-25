import { test, expect } from "@playwright/test";
import { pointerDrag } from "./taskDrag";
import os from "node:os";
import path from "node:path";

test("assignee shortcut preserves draft, assignment, rename and archive", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const task = page.getByRole("dialog", { name: "Задача", exact: true });
  await task.getByLabel("Название задачи").fill("Задача с исполнителем");
  await task.getByLabel("Дедлайн", { exact: true }).fill("2026-12-31");
  await task
    .getByRole("textbox", { name: "Текст записи" })
    .fill("Описание с сохранением 🎈");
  await task
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Настройки Планера → Исполнители",
    exact: true,
  });
  await expect(settings.getByLabel("Имя исполнителя")).toBeFocused();
  await settings.getByLabel("Имя исполнителя").fill("Анна Иванова");
  await settings
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  await expect(
    task.getByLabel("Исполнитель", { exact: true }).locator("option:checked"),
  ).toHaveText("Анна Иванова");
  await expect(
    task.getByRole("textbox", { name: "Текст записи" }),
  ).toContainText("Описание с сохранением 🎈");
  await expect(task.getByLabel("Дедлайн", { exact: true })).toHaveValue(
    "2026-12-31",
  );
  await page.screenshot({
    path: path.join(os.tmpdir(), "not-assignees-desktop.png"),
  });
  await task.getByRole("button", { name: "Сохранить", exact: true }).click();
  const card = page
    .locator(".planner-card")
    .filter({ hasText: "Задача с исполнителем" });
  await expect(card.locator(".task-assignee")).toHaveText("Анна Иванова");
  await pointerDrag(
    page,
    card,
    page.getByRole("region", { name: "В работе", exact: true }),
  );
  await expect(
    page
      .getByRole("region", { name: "В работе", exact: true })
      .locator(".task-assignee"),
  ).toHaveText("Анна Иванова");
  await page.getByRole("button", { name: "Настроить стадии" }).click();
  await page
    .getByRole("button", { name: "Переименовать Анна Иванова" })
    .click();
  await page.getByLabel("Имя исполнителя").fill("Анна Петрова");
  await page
    .getByRole("button", { name: "Сохранить имя", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Архивировать Анна Петрова", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Архивировать исполнителя", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Закрыть", exact: true })
    .click();
  await expect(card.locator(".task-assignee")).toHaveText("Анна Петрова");
  await card.locator(".planner-card-open").click();
  await expect(
    task.getByLabel("Исполнитель", { exact: true }).locator("option:checked"),
  ).toHaveText("Анна Петрова · В архиве");
  await task.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(errors).toEqual([]);
});

test("narrow task, nested cancel and independent assignee persistence", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const task = page.getByRole("dialog", { name: "Задача", exact: true });
  await task.getByLabel("Название задачи").fill("Не сохранять задачу");
  await task
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Настройки Планера → Исполнители",
    exact: true,
  });
  await settings.getByLabel("Имя исполнителя").fill("Не сохранять имя");
  await page.keyboard.press("Escape");
  await settings
    .getByRole("button", { name: "Продолжить", exact: true })
    .click();
  await settings.getByLabel("Имя исполнителя").fill("Борис");
  await settings
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  await page.setViewportSize({ width: 580, height: 840 });
  const field = task.getByLabel("Исполнитель", { exact: true });
  await expect(field).toBeVisible();
  const overflow = await task.evaluate(
    (e) => e.scrollWidth > e.clientWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: path.join(os.tmpdir(), "not-assignees-narrow.png"),
  });
  await task
    .locator(".task-dialog-footer")
    .getByRole("button", { name: "Отменить", exact: true })
    .click();
  await task
    .getByRole("button", { name: "Удалить изменения", exact: true })
    .click();
  await page.setViewportSize({ width: 1280, height: 840 });
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  await expect(
    task.getByLabel("Исполнитель", { exact: true }).locator("option"),
  ).toHaveText(["Без исполнителя", "Борис"]);
});
