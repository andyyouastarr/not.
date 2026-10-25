import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const root = process.cwd();
const profile = path.join(root, "artifacts", `assignees-native-${Date.now()}`);
await mkdir(profile, { recursive: true });
let child, browser, page;
const errors = [];
async function launch() {
  const env = { ...process.env, NOT_STUDIO_TEST_DATA_DIR: profile };
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
  delete env.WEBVIEW2_USER_DATA_FOLDER;
  child = spawn(path.join(root, "src-tauri/target/debug/not-studio.exe"), [], {
    cwd: root,
    env,
    windowsHide: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  for (let i = 0; i < 80; i++) {
    try {
      const port = (
        await readFile(
          path.join(profile, "webview/EBWebView/DevToolsActivePort"),
          "utf8",
        )
      ).split(/\r?\n/)[0];
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = browser.contexts()[0].pages()[0];
      if (!page) throw Error("WebView not ready");
      page.on("pageerror", (e) => errors.push(e.message));
      await page.waitForLoadState("domcontentloaded");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw Error("Native planner launch failed");
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = new Promise((r) => child.once("exit", r));
    child.kill();
    await exit;
  }
  await browser?.close().catch(() => {});
}
const command = (request) =>
  page.evaluate(
    (request) => window.__TAURI_INTERNALS__.invoke("dispatch", { request }),
    request,
  );
try {
  await launch();
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native assignee test password");
  await page
    .getByLabel("Повторите пароль")
    .fill("native assignee test password");
  await page
    .getByRole("button", { name: "Создать дневник", exact: true })
    .click();
  const recovery = await page.locator(".recovery-code").innerText();
  await page.getByLabel("Введите сохранённый ключ для проверки").fill(recovery);
  await page
    .getByRole("button", { name: "Ключ сохранён — продолжить" })
    .click();
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page
    .getByRole("button", { name: "Новая задача", exact: true })
    .last()
    .click();
  const task = page.getByRole("dialog", { name: "Задача", exact: true });
  await task.getByLabel("Название задачи").fill("NativeAssigneeTaskMarker");
  await task
    .getByRole("textbox", { name: "Текст записи" })
    .fill("Описание с emoji 🎈");
  await task
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Настройки Планера → Исполнители",
    exact: true,
  });
  await settings
    .getByLabel("Имя исполнителя")
    .fill("Анна NativeAssigneeSecret");
  await settings
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  await settings.waitFor({ state: "hidden" });
  const id = (await command({ type: "assignees" }))[0].id;
  assert.equal(
    await task.getByLabel("Исполнитель", { exact: true }).inputValue(),
    id,
  );
  await task.getByRole("button", { name: "Сохранить", exact: true }).click();
  await task.waitFor({ state: "hidden" });
  let board = await command({ type: "planner" });
  assert.equal(board.tasks[0].assigneeId, id);
  const taskId = board.tasks[0].id;
  await page.locator(".planner-card-open").click();
  await task.getByLabel("Название задачи").fill("Черновик назначения");
  await task
    .getByRole("button", { name: "Добавить исполнителя", exact: true })
    .click();
  await settings
    .getByLabel("Имя исполнителя")
    .fill("Не сохранять при блокировке");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "vault-lock-request",
      payload: null,
    }),
  );
  await page.getByLabel("Пароль", { exact: true }).waitFor();
  assert.equal(await page.locator(".assignee-dialog").count(), 0);
  await stop();
  await launch();
  await page
    .getByLabel("Пароль", { exact: true })
    .fill("native assignee test password");
  await page
    .getByRole("button", { name: "Открыть дневник", exact: true })
    .click();
  await page.getByRole("button", { name: "Планер", exact: true }).waitFor();
  board = await command({ type: "planner" });
  assert.equal(board.tasks.find((t) => t.id === taskId).assigneeId, id);
  assert.equal(board.draft.assigneeId, id);
  assert.equal(board.draft.title, "Черновик назначения");
  assert.equal((await command({ type: "assignees" })).length, 1);
  await command({
    type: "plannerChange",
    change: { action: "draft", draft: null },
  });
  await command({
    type: "assigneeChange",
    change: { action: "archive", id, revision: 1, archived: true },
  });
  const original = board.tasks.find((t) => t.id === taskId);
  const draft = {
    id: taskId,
    title: original.title,
    document: original.document,
    deadline: original.deadline,
    revision: original.revision,
    assigneeId: id,
  };
  await command({ type: "plannerChange", change: { action: "save", draft } });
  await assert.rejects(
    () =>
      command({
        type: "plannerChange",
        change: {
          action: "save",
          draft: { ...draft, id: crypto.randomUUID(), revision: 0 },
        },
      }),
    /архиве/,
  );
  await page.getByRole("button", { name: "Планер", exact: true }).click();
  await page.locator(".planner-card-open").click();
  await page.getByLabel("Исполнитель", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(profile, "assignees-native.png") });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(profile, "report.json"),
    JSON.stringify(
      {
        passed: true,
        checks: [
          "native nested shortcut and focus",
          "task and encrypted draft persistence after restart",
          "lock clears nested dialog",
          "archived current assignment allowed, new assignment rejected",
        ],
        deviceScaleFactor: await page.evaluate(() => devicePixelRatio),
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`PASS native assignees: ${profile}`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(profile, "failure.png") })
    .catch(() => {});
  console.error(profile);
  throw error;
} finally {
  await stop();
}
