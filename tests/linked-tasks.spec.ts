import { test, expect, type Page } from "@playwright/test";

async function select(page: Page, from: number, to: number) {
  await page
    .locator(".journal-prose")
    .first()
    .evaluate(
      (root, { from, to }) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) =>
            n.parentElement?.closest("button")
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT,
        });
        const nodes: Text[] = [];
        while (walker.nextNode()) nodes.push(walker.currentNode as Text);
        const at = (offset: number): [Node, number] => {
          for (const node of nodes) {
            if (offset <= node.length) return [node, offset];
            offset -= node.length;
          }
          return [root, root.childNodes.length];
        };
        const range = document.createRange();
        range.setStart(...at(from));
        range.setEnd(...at(to));
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      },
      { from, to },
    );
}
async function activate(page: Page) {
  const item = await menu(page);
  await page.evaluate(
    (token) => window.__notTaskMenu?.run(token!),
    item?.token,
  );
}

async function menu(page: Page) {
  const editor = page.locator(".journal-prose").first();
  await editor.dispatchEvent("contextmenu", { button: 2 });
  return page.evaluate(() => window.__notTaskMenu?.prepare());
}
async function create(page: Page, text: string) {
  const editor = page.locator(".journal-prose").first();
  await editor.fill(text);
  await editor.press("Control+a");
  const item = await menu(page);
  expect(item?.label).toBe("Создать задачу");
  await page.evaluate(
    (token) => window.__notTaskMenu?.run(token!),
    item?.token,
  );
}
test("linked task creation, modal, source, delete confirmation and undo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?demo=1");
  await create(page, "Задача из дневника 🎈");
  await expect(page.getByText("Задача создана", { exact: true })).toBeVisible();
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await page.locator(".task-link-icon").click();
  const dialog = page.getByRole("dialog", { name: "Задача", exact: true });
  await expect(dialog.getByLabel("Название задачи")).toHaveValue(
    "Задача из дневника 🎈",
  );
  await dialog
    .getByRole("button", { name: "Открыть фрагмент в дневнике" })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".task-link-icon")).toBeFocused();
  const editor = page.locator(".journal-prose").first();
  await editor.click();
  await editor.press("Control+a");
  await editor.press("Backspace");
  const confirm = page.getByRole("dialog", {
    name: "Разорвать связь с задачей?",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await expect(editor).toContainText("Задача из дневника 🎈");
  await confirm.getByRole("button", { name: "Отменить", exact: true }).click();
  await editor.focus();
  await editor.press("Control+a");
  await editor.press("Backspace");
  await confirm
    .getByRole("button", { name: "Разорвать связь", exact: true })
    .click();
  await expect(page.locator(".task-link-icon")).toHaveCount(0);
  await editor.press("Control+z");
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  expect(errors).toEqual([]);
});
test("Unicode length, toast undo, selection and existing link menu", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await create(page, "🎈".repeat(301));
  await expect(
    page.getByText("Название слишком длинное", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".task-link-icon")).toHaveCount(0);
  await create(page, "🎈".repeat(300));
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  const editor = page.locator(".journal-prose").first();
  await editor.focus();
  await editor.press("Control+a");
  expect((await menu(page))?.label).toBe("Открыть задачу");
  await page
    .locator(".task-created-notice")
    .getByRole("button", { name: "Отменить", exact: true })
    .click();
  await expect(page.locator(".task-link-icon")).toHaveCount(0);
  await expect(editor).toContainText("🎈".repeat(300));
});
test("two fragments, multiple overlap, boundary typing and copied HTML strip links", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const editor = page.locator(".journal-prose").first();
  await editor.fill("Первая Вторая");
  await select(page, 0, 6);
  await activate(page);
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await select(page, 7, 13);
  await activate(page);
  await expect(page.locator(".task-link-icon")).toHaveCount(2);
  await editor.focus();
  await editor.press("Control+a");
  const many = await menu(page);
  expect(many?.label).toBe("Выделение связано с несколькими задачами");
  expect(many?.enabled).toBe(false);
  await select(page, 13, 13);
  await page.keyboard.insertText(" рядом");
  await select(page, 14, 19);
  expect((await menu(page))?.label).toBe("Создать задачу");
  await editor.press("Control+End");
  await editor.evaluate((root) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      '<p><span data-fragment="forged-id">Вставленная копия</span></p>',
    );
    root.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  await expect(page.locator(".task-link-icon")).toHaveCount(2);
  await editor.focus();
  await editor.press("Control+a");
  await editor.press("Backspace");
  await expect(page.getByRole("dialog")).toContainText(
    "Разорвать связи с задачами (2)",
  );
});
test("another draft is preserved; linked task opens read-only, planner backlink and completion", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await page.evaluate(async () => {
    const path = "/src/api.ts";
    const { api } = await import(path);
    await api("plannerChange", {
      change: {
        action: "draft",
        draft: {
          id: crypto.randomUUID(),
          title: "Сохранить другой черновик",
          document: { type: "doc", content: [{ type: "paragraph" }] },
          deadline: null,
          revision: 0,
        },
      },
    });
  });
  await create(page, "Связанная задача");
  await page.locator(".task-link-icon").click();
  const dialog = page.getByRole("dialog", { name: "Просмотр задачи" });
  await expect(dialog).toContainText("Открыт другой черновик");
  await expect(dialog.getByLabel("Название задачи")).toBeDisabled();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await expect(
    page.getByText("Сохранить другой черновик", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Удалить черновик", exact: true })
    .click();
  const card = page
    .locator(".planner-card")
    .filter({ hasText: "Связанная задача" });
  await card.click();
  await page
    .getByRole("button", { name: "Открыть фрагмент в дневнике" })
    .click();
  await expect(page.locator(".task-link-icon")).toBeFocused();
});

test("whole replacement needs confirmation; partial edits and block movement retain identity", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await create(page, "Исходный фрагмент");
  const editor = page.locator(".journal-prose").first();
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await select(page, 2, 4);
  await page.keyboard.insertText("НОВ");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  const prior = await editor.innerText();
  await editor.press("Control+a");
  await page.keyboard.insertText("Полная замена");
  const confirm = page.getByRole("dialog", {
    name: "Разорвать связь с задачей?",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await expect(editor).toHaveText(prior);
  await confirm.getByRole("button", { name: "Отменить", exact: true }).click();
  await expect(editor).toHaveText(prior);
  await editor.focus();
  await editor.press("Control+a");
  await page.keyboard.insertText("Полная замена");
  await confirm
    .getByRole("button", { name: "Разорвать связь", exact: true })
    .click();
  await expect(editor).toHaveText("Полная замена");
  await editor.press("Control+z");
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await editor.press("Control+End");
  await editor.press("Enter");
  await expect(editor.locator(":scope > p")).toHaveCount(2);
  await page.keyboard.insertText("Второй абзац");
  await editor.press("Control+Alt+ArrowUp");
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await expect(editor.locator(":scope > p").first()).toHaveText("Второй абзац");
});

test("completion icon, archived/deleted task restoration and source in diary trash", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await create(page, "Завершённая задача");
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await page.evaluate(async () => {
    const path = "/src/api.ts";
    const { api } = await import(path);
    const board = await api("planner", {}),
      task = board.tasks[0];
    const moved = await api("plannerChange", {
      change: {
        action: "move",
        id: task.id,
        revision: task.revision,
        stage: board.stages.find((s: { completed: boolean }) => s.completed).id,
        before: null,
      },
    });
    await api("plannerChange", {
      change: {
        action: "flag",
        id: task.id,
        revision: moved.tasks[0].revision,
        field: "archived",
        value: true,
      },
    });
  });
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page.getByRole("button", { name: "Дневник", exact: true }).click();
  await expect(page.locator(".task-link-icon")).toHaveText("✓");
  await page.locator(".task-link-icon").click();
  await expect(page.getByRole("dialog")).toContainText("Задача в архиве");
  await page
    .getByRole("button", { name: "Восстановить задачу", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(async () => {
    const path = "/src/api.ts";
    const { api } = await import(path);
    const board = await api("planner", {}),
      task = board.tasks[0];
    await api("plannerChange", {
      change: {
        action: "flag",
        id: task.id,
        revision: task.revision,
        field: "deleted",
        value: true,
      },
    });
  });
  await page.locator(".task-link-icon").click();
  await expect(page.getByRole("dialog")).toContainText("Задача в корзине");
  await page
    .getByRole("button", { name: "Восстановить задачу", exact: true })
    .click();
  await page.getByRole("button", { name: "В корзину", exact: true }).click();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .locator(".planner-card")
    .filter({ hasText: "Завершённая задача" })
    .click();
  await page
    .getByRole("button", { name: "Открыть фрагмент в дневнике" })
    .click();
  await expect(page.locator(".trash-banner")).toBeVisible();
  await expect(page.locator(".journal-prose")).toHaveAttribute(
    "contenteditable",
    "false",
  );
});

test("a rectangular table selection creates one task from all selected cells", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  const editor = page.locator(".journal-prose").first();
  await editor.evaluate(async (root) => {
    const modulePath = "/node_modules/@tiptap/pm/tables/index.ts";
    const { CellSelection } = await import(modulePath);
    const view = (root as any).editor.view;
    const paragraph = (text: string) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });
    const table = view.state.schema.nodeFromJSON({
      type: "table",
      content: [
        ["А", "Б", "вне"],
        ["В", "Г", "вне"],
      ].map((row) => ({
        type: "tableRow",
        content: row.map((text) => ({
          type: "tableCell",
          content: [paragraph(text)],
        })),
      })),
    });
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, table),
    );
    const cells: number[] = [];
    view.state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === "tableCell") cells.push(pos);
    });
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cells[0], cells[4]),
      ),
    );
  });
  await activate(page);
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await page.locator(".task-link-icon").click();
  await expect(
    page.getByRole("dialog").getByLabel("Название задачи"),
  ).toHaveValue("А Б В Г");
});

test("clear formatting and clipboard preserve source identity; cancelled links cannot return through history", async ({
  page,
}) => {
  await page.goto("/?demo=1");
  await create(page, "Текст связанной задачи");
  const editor = page.locator(".journal-prose").first();
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.evaluate((root) => {
    const editor = (root as any).editor;
    editor.chain().selectAll().toggleBold().unsetAllMarks().run();
  });
  await expect(page.locator(".task-link-icon")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const copied = await editor.evaluate((root) => {
    const editor = (root as any).editor;
    const result = editor.view.serializeForClipboard(
      editor.state.selection.content(),
    );
    return {
      text: result.text,
      html: result.dom.innerHTML,
      slice: JSON.stringify(result.slice.toJSON()),
    };
  });
  expect(copied.text).toBe("Текст связанной задачи");
  expect(copied.html).not.toContain("fragment");
  expect(copied.slice).not.toContain("taskLink");
  await select(page, 1, 3);
  await page.keyboard.press("Backspace");
  await page
    .locator(".task-created-notice")
    .getByRole("button", { name: "Отменить", exact: true })
    .click();
  await expect(page.locator(".task-link-icon")).toHaveCount(0);
  await editor.press("Control+z");
  await expect(page.locator(".task-link-icon")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Сохранено", exact: true }),
  ).toBeVisible();
});
